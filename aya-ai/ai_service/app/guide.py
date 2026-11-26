"""The AI Museum Guide: one conversational turn, from the visitor's message to a checked reply.

    message
      |  1. booking words?   -> hand over to the booking system (nothing is booked here)
      |  2. greeting/thanks? -> fixed friendly reply
      |  3. follow-up?       -> rewrite as a stand-alone question                (model call 1, only if there is history)
      |  4. search           -> the existing RAG search (other museums are refused there);
      |                         for a rewritten follow-up the notes used in earlier answered turns of this
      |                         conversation are offered to the judge too (it still has to prove the answer)
      |  5. JUDGE            -> do the notes DIRECTLY answer it? must quote them  (model call 2)
      |  6. check the quotes -> every quote must really be in its note (code)
      |  7. ANSWER           -> written from the approved notes only              (model call 3)
      |  8. check the answer -> citations, numbers, links, language              (code)
      v
    reply + sources     (or a fixed "I don't have that information" reply)

The model never gets a tool: it cannot book, search, write to the database or open a link.
Whenever a check fails the guide says it cannot verify the answer; it never falls back to guessing.
"""

import logging
import re
import time
from urllib.parse import urlparse

from . import guide_prompts as prompts
from .clients import OpenAIChat, UpstreamError
from .conversations import Conversation, ConversationStore
from .domain import fold, part_of
from .guide_text import OFFICIAL_SITE, booking_action, language_name, language_of, reply, register, small_talk
from .rag import RagSearcher

logger = logging.getLogger("gem_ai")

MAX_NOTES = 5            # notes taken from the new search
MAX_REUSED = 3           # extra notes remembered from earlier answered turns of the same conversation
MAX_ANSWER_CHARS = 1800
_ALWAYS_ALLOWED_HOSTS = ("gem.eg", "tickets.gem.eg")


class ConversationNotFound(Exception):
    """The conversation id is unknown, expired, or belongs to somebody else (the caller cannot tell which)."""


# ---------------------------------------------------------------------------
# checks that need no AI
# ---------------------------------------------------------------------------

def quote_is_in_note(quote: str, content: str) -> bool:
    """Is the judge's quote really (almost) word for word in the note? Case, spacing and punctuation are ignored."""
    q, n = fold(quote).strip(), fold(content)
    if len(q) < 12:
        return False
    if q in n:
        return True
    q_words, n_words = set(q.split()), set(n.split())
    return len(q_words) >= 3 and len(q_words & n_words) / len(q_words) >= 0.85


_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_NUMBER_WORDS = {
    **{w: v for v, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve".split())},
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100,
    "واحد": 1, "اثنان": 2, "اثنين": 2, "ثلاثه": 3, "ثلاث": 3, "اربعه": 4, "اربع": 4, "خمسه": 5, "خمس": 5, "سته": 6,
    "سبعه": 7, "سبع": 7, "ثمانيه": 8, "ثماني": 8, "تسعه": 9, "تسع": 9, "عشره": 10, "عشر": 10, "احد عشر": 11,
    "عشرون": 20, "ثلاثون": 30, "اربعون": 40, "خمسون": 50, "ستون": 60, "سبعون": 70, "ثمانون": 80, "تسعون": 90,
    "مئه": 100, "مائه": 100, "ساعتين": 2, "ساعتان": 2, "يومين": 2, "دقيقتين": 2, "عامين": 2, "سنتين": 2,
}
_THOUSAND = {"thousand", "الف"}
_MILLION = {"million", "مليون"}
_TWELVE_PHRASES = ("اثنتي عشره", "اثنتا عشره", "اثنا عشر", "اثني عشر")


def numbers_in(text: str) -> set[str]:
    """Every number written with digits (Arabic-Indic digits and thousands separators understood)."""
    text = re.sub(r"\[\d+\]", " ", text.translate(_DIGITS))                   # [1] citation marks are not facts
    text = re.sub(r"(?<=\d)[,٬،](?=\d{3}(?!\d))", "", text)         # 30,000 -> 30000
    return set(re.findall(r"\d+(?:\.\d+)?", text))


def number_words_in(text: str) -> set[str]:
    """Numbers written as words ("two", "ثلاثون ألف"), as digits, so they can be compared."""
    folded = fold(text)
    tokens = folded.split()
    out = set()
    for i, token in enumerate(tokens):
        value = _NUMBER_WORDS.get(token)
        if value is None:
            continue
        out.add(str(value))
        following = tokens[i + 1] if i + 1 < len(tokens) else ""
        if following in _THOUSAND:
            out.add(str(value * 1000))
        if following in _MILLION:
            out.add(str(value * 1_000_000))
    if any(p in folded for p in _TWELVE_PHRASES):
        out.add("12")
    return out


_LINK = re.compile(r"(?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:/\S*)?", re.IGNORECASE)


def disallowed_links(answer: str, allowed_hosts: set[str]) -> list[str]:
    """Web addresses in the answer that do not belong to a cited source or to the official museum sites."""
    bad = []
    for match in _LINK.finditer(answer):
        raw = match.group(0).rstrip(".,;:)")
        host = (urlparse(raw if "//" in raw else "//" + raw).hostname or "").removeprefix("www.")
        if not any(host == allowed or host.endswith("." + allowed) for allowed in allowed_hosts):
            bad.append(host or raw)
    return bad


def _arabic_share(text: str) -> float:
    letters = re.findall(r"[A-Za-zء-ي]", text)
    return sum(1 for c in letters if ord(c) > 0x600) / len(letters) if letters else 0.0


def _normal(text: str) -> str:
    return " ".join(fold(text).split())


# ---------------------------------------------------------------------------
# the guide
# ---------------------------------------------------------------------------

class GuideAgent:
    def __init__(self, searcher: RagSearcher, chat: OpenAIChat, store: ConversationStore):
        self._searcher, self._chat, self._store = searcher, chat, store

    # ---- public ----

    def respond(self, user_id: str, message: str, conversation_id: str | None = None, trace: dict | None = None) -> dict:
        """One turn. `trace` (optional, for the smoke test only) is filled with note keys and verdicts, never with secrets."""
        started = time.perf_counter()
        conversation = self._conversation(user_id, conversation_id)
        reg = register(message)
        stats = {"llm_calls": 0, "notes": 0, "supported": 0, "reused": 0, "trace": trace if trace is not None else {}}

        outcome = self._turn(conversation, message, reg, stats)
        status = outcome["status"]
        if status != "unavailable":                       # a failed turn is not remembered
            conversation.remember("user", message)
            conversation.remember("assistant", outcome["reply"])

        outcome.update({
            "conversation_id": conversation.id,
            "language": language_of(reg),
            "register": reg,
            "enough_evidence": status == "answered",
        })
        outcome.setdefault("sources", [])
        outcome.setdefault("handoff", None)
        outcome.setdefault("contains_time_sensitive", False)
        # Only metadata is logged: never the visitor's words, the notes, the answer, keys or tokens.
        stats["trace"]["status"] = status
        logger.info("guide status=%s register=%s notes=%d reused=%d supported=%d llm_calls=%d ms=%d",
                    status, reg, stats["notes"], stats["reused"], stats["supported"], stats["llm_calls"], int((time.perf_counter() - started) * 1000))
        return outcome

    # ---- one turn ----

    def _conversation(self, user_id: str, conversation_id: str | None) -> Conversation:
        if conversation_id is None:
            return self._store.start(user_id)
        conversation = self._store.get(user_id, conversation_id)
        if conversation is None:
            raise ConversationNotFound
        return conversation

    def _turn(self, conversation: Conversation, message: str, reg: str, stats: dict) -> dict:
        # 1) booking: hand over, never act
        action = booking_action(message)
        if action:
            return {"status": "handoff", "reply": reply(f"handoff_{action}", reg),
                    "handoff": {"type": "booking", "action": action, "target": "booking_system"}}

        # 2) greetings and thanks
        kind = small_talk(message)
        if kind:
            return {"status": "smalltalk", "reply": reply(kind, reg)}

        # 3) follow-ups become stand-alone questions
        question = message
        history = conversation.history()
        if history:
            question = self._standalone(history, message, stats)

        # 4) search (the other-museum check lives inside the search)
        found = self._searcher.search(question, None, MAX_NOTES)
        scope = found.get("out_of_scope")
        if scope:
            return {"status": "out_of_scope", "reply": reply("other_museum", reg, museum=scope["museum"])}
        fresh = found["results"]
        notes = list(fresh)
        if history and _normal(question) != _normal(message):
            # a follow-up that needed rewriting: the notes behind earlier answers may hold the answer
            known = {n["chunk_key"] for n in notes}
            again = [n for n in conversation.evidence if n["chunk_key"] not in known][:MAX_REUSED]
            notes += again
            stats["reused"] = len(again)
        notes = [{**n, "part_of": part_of(n.get("entity_key"), n.get("language", "en"))} for n in notes]
        stats["notes"] = len(fresh)
        trace = stats["trace"]
        trace.update(question=question, searched=[n["chunk_key"] for n in fresh],
                     reused=[n["chunk_key"] for n in notes[len(fresh):]])
        if not notes:
            return {"status": "insufficient_evidence", "reply": reply("no_info", reg)}

        # 5 + 6) the judge decides, the code checks the judge
        try:
            verdict = self._call("judge", prompts.JUDGE_SYSTEM, prompts.judge_user(question, notes), "judge", prompts.JUDGE_SCHEMA, stats)
        except UpstreamError:
            return {"status": "unavailable", "reply": reply("unavailable", reg)}
        supported = self._verified_support(verdict, notes)
        stats["supported"] = len(supported)
        trace.update(judge=str(verdict.get("answerable")), approved=[notes[i]["chunk_key"] for i in supported])
        if not supported:
            return {"status": "insufficient_evidence", "reply": reply("no_info", reg)}
        approved = [notes[i] for i in supported]
        partial = verdict.get("answerable") == "partial"

        # 7) the answer is written from the approved notes only
        try:
            draft = self._call("answer", prompts.ANSWER_SYSTEM, prompts.answer_user(question, message, language_name(reg), approved),
                               "answer", prompts.ANSWER_SCHEMA, stats)
        except UpstreamError:
            return {"status": "unavailable", "reply": reply("unavailable", reg)}

        # 8) the answer is checked
        checked = self._check_answer(draft, approved, [question, message], reg)
        if isinstance(checked, str):
            trace["rejected"] = checked
            logger.info("guide answer rejected: %s", checked)
            return {"status": "unverified", "reply": reply("unverified", reg)}
        text, cited = checked
        time_sensitive = any(approved[i]["time_sensitive"] for i in cited)
        if partial:
            text += " " + reply("partial", reg)
        if time_sensitive:
            text += " " + reply("time_sensitive", reg)
        sources = [
            {"n": n, "title": approved[i]["source"]["title"], "url": approved[i]["source"]["url"], "note": approved[i]["chunk_key"],
             "language": approved[i]["language"], "verification_status": approved[i]["verification_status"],
             "time_sensitive": approved[i]["time_sensitive"]}
            for n, i in enumerate(cited, 1)
        ]
        # the markers in the text must follow the order of the sources list
        text = self._renumber(text, [i + 1 for i in cited])
        conversation.remember_evidence(notes)
        return {"status": "answered", "reply": text, "sources": sources, "contains_time_sensitive": time_sensitive}

    # ---- model calls ----

    def _call(self, name: str, system: str, user: str, schema_name: str, schema: dict, stats: dict) -> dict:
        stats["llm_calls"] += 1
        return self._chat.complete_json(system, user, schema_name, schema)

    def _standalone(self, history, message: str, stats: dict) -> str:
        try:
            data = self._call("understand", prompts.UNDERSTAND_SYSTEM, prompts.understand_user(history, message),
                              "understand", prompts.UNDERSTAND_SCHEMA, stats)
            question = " ".join(str(data.get("standalone_question", "")).split())
        except UpstreamError:
            return message                                  # degrade: search with the message as it is
        return question[:300] if 2 <= len(question) else message

    # ---- checks on the judge ----

    @staticmethod
    def _verified_support(verdict: dict, notes: list[dict]) -> list[int]:
        """Positions (0-based) of the notes whose supporting quote really appears in them."""
        if verdict.get("answerable") not in ("full", "partial"):
            return []
        approved: list[int] = []
        for item in verdict.get("supporting", []):
            number, quote = item.get("note"), item.get("quote")
            if not isinstance(number, int) or not isinstance(quote, str) or not 1 <= number <= len(notes):
                continue
            if quote_is_in_note(quote, notes[number - 1]["content"]) and number - 1 not in approved:
                approved.append(number - 1)
        return approved

    # ---- checks on the answer ----

    @staticmethod
    def _check_answer(draft: dict, approved: list[dict], asked: list[str], reg: str) -> tuple[str, list[int]] | str:
        """(clean text, positions of the cited notes) or the short reason the answer was rejected."""
        text = draft.get("answer")
        citations = draft.get("citations")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_ANSWER_CHARS or not isinstance(citations, list):
            return "empty_or_too_long"
        text = " ".join(text.split())

        marked = {int(m) for m in re.findall(r"\[(\d+)\]", text)}
        valid = set(range(1, len(approved) + 1))
        cited = sorted(({c for c in citations if isinstance(c, int)} | marked) & valid)
        if not cited or not {c for c in citations if isinstance(c, int)} & valid:
            return "no_valid_citation"
        text = re.sub(r"\[(\d+)\]", lambda m: m.group(0) if int(m.group(1)) in valid else "", text)

        allowed_hosts = set(_ALWAYS_ALLOWED_HOSTS) | {
            (urlparse(approved[c - 1]["source"]["url"] or "").hostname or "").removeprefix("www.") for c in cited
        }
        if disallowed_links(text, allowed_hosts - {""}):
            return "disallowed_link"

        evidence = " ".join(approved[c - 1]["content"] for c in cited) + " " + " ".join(asked)
        allowed_numbers = numbers_in(evidence) | number_words_in(evidence)
        if numbers_in(text) - allowed_numbers:
            return "ungrounded_number"

        share = _arabic_share(text)
        if (reg == "en" and share >= 0.3) or (reg in ("ar", "eg") and share < 0.3):
            return "wrong_language"
        return text, [c - 1 for c in cited]

    @staticmethod
    def _renumber(text: str, original_numbers: list[int]) -> str:
        """[2] [3] in the model's numbering -> [1] [2] in the order of the sources list."""
        mapping = {old: new for new, old in enumerate(original_numbers, 1)}
        return re.sub(r"\[(\d+)\]", lambda m: f"[{mapping[int(m.group(1))]}]" if int(m.group(1)) in mapping else "", text)
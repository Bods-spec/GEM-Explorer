"""The Smart Visit Planner: one conversational turn, from the visitor's message to a structured plan.

    message
      |  1. booking words?     -> hand over to the booking system (nothing is booked here)
      |  2. another museum?    -> refused;  greeting / thanks -> fixed reply
      |  3. EXTRACT (1 model call): time, pace, interests, must-see / add / remove  (values come from fixed lists)
      |  4. code checks the form: known keys only, a time that the message really mentions, wording copied from the message
      |  5. merge with the plan of this conversation ("make it 90 minutes and remove the Grand Stairs" edits it)
      |  6. ask for the time if it is missing; otherwise BUILD THE PLAN IN CODE (planner_core.py) from Supabase's entity table
      v
    status + preferences + ordered stops with minutes, reasons, highlights, sources, assumptions, limitations

The model never writes text the visitor sees, never picks minutes and never touches the booking system.
"""

import logging
import re
import threading
import time

from . import planner_prompts as prompts
from . import planner_text as words
from .catalog import Catalog, load_catalog
from .clients import OpenAIChat, SupabaseRest, UpstreamError
from .conversations import Conversation, ConversationStore
from .domain import fold, names_gem, other_museum
from .guide import ConversationNotFound
from .guide_prompts import clean
from .guide_text import booking_action, language_of, register, reply as guide_reply, small_talk
from .planner_core import PACES, Preferences, build_plan

logger = logging.getLogger("gem_ai")

CATALOG_TTL = 600.0
MAX_UNMATCHED = 3
_TIME_WORDS = ("hour", "hr", "min", "half", "quarter", "day", "ساع", "دقيق", "دقايق", "نص", "ربع", "يوم")


def mentions_time(message: str) -> bool:
    """Does the message say anything about an amount of time? (A time the model 'found' elsewhere is not trusted.)"""
    folded = fold(message)
    return any(c.isdigit() for c in message) or any(token.startswith(_TIME_WORDS) for token in folded.split())


_LATIN_OR_ARABIC = re.compile(r"[A-Za-z\u0621-\u064a]")


def tool_register(message: str, language: str | None) -> str:
    """The wording register when the Booking Agent calls the tool. Its Arabic is Egyptian Arabic, so Arabic text with no
    dialect words is answered in Egyptian Arabic too; a message with no letters at all ("90") follows the page language."""
    reg = register(message)
    if reg == "ar":
        return "eg"
    if reg == "en" and language == "ar" and not _LATIN_OR_ARABIC.search(message):
        return "eg"
    return reg


def clean_extraction(raw: dict, catalog: Catalog, message: str, known_minutes: int | None) -> dict:
    """Keep only what is valid. Anything the model made up (a key, a time, wording not in the message) is dropped."""
    raw = raw if isinstance(raw, dict) else {}

    def keys(name: str) -> list[str]:
        found = [k for k in raw.get(name) if isinstance(k, str) and k in catalog.places] if isinstance(raw.get(name), list) else []
        return list(dict.fromkeys(found))

    minutes = raw.get("minutes")
    if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes < 1 or not (mentions_time(message) or minutes == known_minutes):
        minutes = None
    tags = catalog.tags()
    folded_message = " ".join(fold(message).split())
    unmatched, seen = [], set()
    for item in raw.get("unmatched") if isinstance(raw.get("unmatched"), list) else []:
        item = " ".join(clean(item).split()) if isinstance(item, str) else ""
        folded = " ".join(fold(item).split())
        if 2 <= len(item) <= 40 and folded in folded_message and folded not in seen:
            seen.add(folded)
            unmatched.append(item)
    return {
        "intent": raw.get("intent") if raw.get("intent") in ("create", "modify", "other") else "other",
        "minutes": minutes,
        "time_conflict": raw.get("time_conflict") is True,
        "pace": raw.get("pace") if raw.get("pace") in PACES else None,
        "interests": list(dict.fromkeys(t for t in (raw.get("interests") if isinstance(raw.get("interests"), list) else [])
                                        if isinstance(t, str) and t in tags)),
        "must_see": keys("must_see"), "add": keys("add"), "remove": keys("remove"),
        "unmatched": unmatched[:MAX_UNMATCHED],
    }


def merge(prefs: Preferences, planned: bool, ex: dict) -> Preferences:
    """Edit the preferences of this conversation. A new plan starts fresh (but keeps the time); an edit keeps everything else."""
    base = Preferences(prefs.minutes, prefs.pace) if (ex["intent"] == "create" and planned) else Preferences.from_state(prefs.to_state())
    if ex["minutes"]:
        base.minutes = ex["minutes"]
    if ex["pace"]:
        base.pace = ex["pace"]
    for tag in ex["interests"]:
        if tag not in base.interests:
            base.interests.append(tag)
    for key in ex["must_see"] + ex["add"]:
        if key not in base.must_see:
            base.must_see.append(key)
        if key in base.removed:
            base.removed.remove(key)
    for key in ex["remove"]:
        if key not in base.removed:
            base.removed.append(key)
        if key in base.must_see:
            base.must_see.remove(key)
    return base


class PlannerAgent:
    def __init__(self, supabase: SupabaseRest, chat: OpenAIChat, store: ConversationStore, clock=time.monotonic):
        self._supabase, self._chat, self._store, self._clock = supabase, chat, store, clock
        self._catalog: Catalog | None = None
        self._loaded = 0.0
        self._lock = threading.Lock()

    def catalog(self) -> Catalog:
        with self._lock:
            now = self._clock()
            if self._catalog is None or now - self._loaded > CATALOG_TTL:
                self._catalog, self._loaded = load_catalog(self._supabase), now      # raises UpstreamError; the old copy is kept
            return self._catalog

    # ---- public ----

    def respond(self, user_id: str, message: str, conversation_id: str | None = None, trace: dict | None = None) -> dict:
        """One turn of the stand-alone development endpoint (POST /planner/chat)."""
        return self._respond(self._conversation(user_id, conversation_id), message, trace)

    def turn(self, user_id: str, message: str, conversation_id: str, language: str | None = None,
             booking_handled: bool = False, trace: dict | None = None) -> dict:
        """One turn as a TOOL of the Booking Agent (POST /planner/turn).

        The caller owns the conversation and chooses its id. `booking_handled` means the caller already took the
        booking part of the message, so the planner must not hand it over. The answer is structured data plus the
        fixed wording; the Booking Agent decides what the visitor sees. Nothing is ever booked here."""
        conversation = self._store.get_or_start(user_id, conversation_id)
        return self._respond(conversation, message, trace, tool=True, language=language, booking_handled=booking_handled)

    def _respond(self, conversation: Conversation, message: str, trace: dict | None, tool: bool = False,
                 language: str | None = None, booking_handled: bool = False) -> dict:
        started = time.perf_counter()
        reg = tool_register(message, language) if tool else register(message)
        if reg == "ar" and conversation.state.get("reg") == "eg":
            reg = "eg"                         # a short follow-up ("90 دقيقة") has no dialect words: keep the visitor's dialect
        trace = trace if trace is not None else {}
        out = self._turn(conversation, message, reg, trace, booking_handled)
        if reg == "eg":
            conversation.state["reg"] = "eg"          # after the turn: the turn replaces the state dict
        out.setdefault("plan", None)
        out.setdefault("handoff", None)
        out.setdefault("preferences", self._preferences_out(Preferences.from_state(conversation.state.get("prefs")), None, reg))
        out.setdefault("time_budget_minutes", conversation.state.get("prefs", {}).get("minutes"))
        out.setdefault("assumptions", [])
        out.setdefault("limitations", [])
        out.update(conversation_id=conversation.id, language=language_of(reg), register=reg)
        if tool:
            out["plan_presented"] = out["status"] in ("plan_created", "plan_updated")   # the Booking Agent's "plan shown" signal
        trace["status"] = out["status"]
        logger.info("planner status=%s register=%s stops=%d ms=%d", out["status"], reg,
                    len((out["plan"] or {}).get("stops", [])), int((time.perf_counter() - started) * 1000))
        return out

    # ---- one turn ----

    def _conversation(self, user_id: str, conversation_id: str | None) -> Conversation:
        if conversation_id is None:
            return self._store.start(user_id)
        conversation = self._store.get(user_id, conversation_id)
        if conversation is None:
            raise ConversationNotFound
        return conversation

    def _turn(self, conversation: Conversation, message: str, reg: str, trace: dict, booking_handled: bool = False) -> dict:
        action = None if booking_handled else booking_action(message)
        if action:
            return {"status": "handoff", "reply": guide_reply(f"handoff_{action}", reg),
                    "handoff": {"type": "booking", "action": action, "target": "booking_system"}}
        museum = other_museum(message)
        if museum and not names_gem(message):
            return {"status": "out_of_scope", "reply": guide_reply("other_museum", reg, museum=museum)}
        kind = small_talk(message)
        if kind in ("greeting", "about"):
            return {"status": "smalltalk", "reply": words.text("greeting", reg)}
        if kind in ("thanks", "bye"):
            return {"status": "smalltalk", "reply": guide_reply(kind, reg)}

        catalog = self.catalog()
        state = conversation.state
        prefs, planned = Preferences.from_state(state.get("prefs")), bool(state.get("planned"))
        try:
            raw = self._chat.complete_json(prompts.EXTRACT_SYSTEM, prompts.extract_user(message, state.get("prefs"), catalog),
                                           "extract", prompts.extract_schema(catalog))
        except UpstreamError:
            return {"status": "unavailable", "reply": guide_reply("unavailable", reg)}
        ex = clean_extraction(raw, catalog, message, prefs.minutes)
        trace["extracted"] = {k: v for k, v in ex.items() if k != "unmatched"}
        if ex["intent"] == "other":
            return {"status": "not_planning", "reply": words.text("not_planning", reg)}
        if ex["time_conflict"]:
            return self._ask(conversation, prefs, planned, reg, "time_conflict")

        prefs = merge(prefs, planned, ex)
        if not prefs.minutes:
            return self._ask(conversation, prefs, planned, reg, "ask_time")

        plan = build_plan(prefs, catalog, language_of(reg))
        trace["stops"] = [s["key"] for s in plan["stops"]]
        conversation.state = {"prefs": prefs.to_state(), "planned": bool(plan["stops"]) or planned}
        shown = self._preferences_out(prefs, catalog, reg)
        if not plan["stops"]:
            conversation.state["planned"] = planned
            return {"status": "not_possible", "reply": self._why_not(plan, prefs, reg), "preferences": shown,
                    "time_budget_minutes": prefs.minutes, "plan": None, **self._notes(prefs, reg)}
        return {
            "status": "plan_updated" if planned else "plan_created",
            "reply": words.render_plan(plan, min(prefs.minutes, 480), reg, planned, ex["unmatched"]),
            "preferences": shown, "time_budget_minutes": prefs.minutes, "plan": self._plan_out(plan),
            "unmatched_requests": ex["unmatched"], **self._notes(prefs, reg),
        }

    # ---- helpers ----

    def _ask(self, conversation: Conversation, prefs: Preferences, planned: bool, reg: str, kind: str) -> dict:
        conversation.state = {"prefs": prefs.to_state(), "planned": planned}
        return {"status": "needs_clarification", "reply": words.text(kind, reg), "clarification": kind,
                "preferences": self._preferences_out(prefs, None, reg)}

    @staticmethod
    def _why_not(plan: dict, prefs: Preferences, reg: str) -> str:
        for issue in plan["issues"]:
            if issue["code"] == "must_see_no_estimate":
                return words.text("must_see_no_estimate", reg, names=words.join(issue["names"], reg))
            if issue["code"] == "must_see_does_not_fit":
                return words.text("must_see_too_long", reg, names=words.join(issue["names"], reg), budget=prefs.minutes, needed=issue["needs_minutes"])
        if plan["shortest_stop_minutes"] and plan["budget_minutes"] < plan["shortest_stop_minutes"]:
            return words.text("too_short", reg, budget=prefs.minutes, needed=plan["shortest_stop_minutes"])
        return words.text("no_stops", reg)

    @staticmethod
    def _notes(prefs: Preferences, reg: str) -> dict:
        assumed = words.text("budget_assumed", reg, minutes=min(prefs.minutes or 0, 480))
        return {"assumptions": [assumed, *words.ASSUMPTIONS[reg]], "limitations": list(words.LIMITATIONS[reg])}

    @staticmethod
    def _preferences_out(prefs: Preferences, catalog: Catalog | None, reg: str) -> dict:
        lang = language_of(reg)

        def named(keys: list[str]) -> list[dict]:
            return [{"key": k, "name": (catalog.get(k).name(lang) if catalog and catalog.get(k) else k)} for k in keys]

        return {"minutes": prefs.minutes, "pace": prefs.pace,
                "interests": [{"key": t, "label": words.tag_label(t, reg)} for t in prefs.interests],
                "must_see": named(prefs.must_see), "removed": named(prefs.removed)}

    @staticmethod
    def _plan_out(plan: dict) -> dict:
        return {k: plan[k] for k in ("stops", "total_estimated_minutes", "free_minutes", "transition_minutes_each", "transitions_total",
                                     "rest_buffer_minutes", "not_included", "issues", "budget_minutes")}
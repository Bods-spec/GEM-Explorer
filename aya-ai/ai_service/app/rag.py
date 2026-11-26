"""Museum knowledge retrieval.

search(question) -> the most relevant team-written notes, each with its source.

How it works
  0. A question that explicitly asks about ANOTHER museum (the Louvre, the Egyptian Museum in
     Tahrir...) gets no evidence at all, and nothing is sent to OpenAI (see domain.py).
  1. Embed the question with OpenAI (if that fails, fall back to keyword-only search).
  2. Ask the database function search_museum_knowledge() for the best notes. It merges
     keyword rank and meaning rank (see sql/knowledge_base.sql).
  3. Keep only notes that are really relevant. The database always returns *something*,
     so this step is what makes "I don't have that information" possible:
        a note is kept if its meaning-similarity is high enough, OR if it shares enough
        distinctive words with the question. (The two kinds of evidence are reported separately.)
  4. Put the notes about the place or artefact the visitor NAMED first, then notes about its
     area or its artefacts, then everything else (each group keeps the database's order).
  5. Return the notes with their source page, verification status and time-sensitive flag.

Nothing here writes to the database or answers the question; it only finds evidence.
"""

import re
import unicodedata
from typing import Any

from .clients import OpenAIEmbedder, SupabaseRest, UpstreamError, vector_literal
from .domain import entity_match, mentioned_entities, other_museum

MAX_QUERY_CHARS = 300

_ARABIC_RE = re.compile(r"[؀-ۿ]")
_LATIN_RE = re.compile(r"[A-Za-z]")
_WORD_RE = re.compile(r"[\w؀-ۿ]+", re.UNICODE)
# A booking reference is Latin letters inside an Arabic sentence; it must not decide the language.
_REFERENCE_RE = re.compile(r"(?<![A-Za-z0-9])GEM[-‐-―]\S*", re.IGNORECASE)

_EN_STOP = frozenset(
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its "
    "me my of on or our please she so tell that the their them then there these they this to us was we were "
    "what when where which who whom why will with would you your about any some more most also than very "
    "show give know like want need near".split()
)
_AR_STOP = frozenset(
    "في من على الى عن مع هذا هذه ذلك تلك هو هي هم انا انت نحن ما ماذا متى اين كيف لماذا هل كان كانت يكون "
    "التي الذي الذين لي لك له لها بعد قبل عند حتى او ثم لكن قد كل بعض اي ان انه انها فيه فيها عايز عاوز "
    "قولي ايه فين امتى ازاي مين ده دي دا احكيلي احكي قولي ممكن لو سمحت اعرف معلومات كده يعني بتاع بتاعه كام بيفتح".split()
)
# Words that appear in nearly every note. They say nothing about WHICH note is wanted, so they
# do not count as shared-word evidence ("What can I see in the Louvre Museum" must not match
# a note just because both say "museum" and "see").
_GENERIC = frozenset(
    "museum egypt egyptian gem see visit visitor artefact artifact piece object ancient متحف مصر مصري المتحف".split()
    + ["مصريه", "زيار", "زياره"]
)


def detect_language(text: str) -> str:
    """'ar' if the text is mostly Arabic letters, otherwise 'en'."""
    text = _REFERENCE_RE.sub(" ", text)
    return "ar" if len(_ARABIC_RE.findall(text)) > len(_LATIN_RE.findall(text)) else "en"


def _normalize_arabic(word: str) -> str:
    word = "".join(c for c in unicodedata.normalize("NFKD", word) if not unicodedata.combining(c))
    word = word.replace("ـ", "")  # tatweel
    for src, dst in (("أ", "ا"), ("إ", "ا"), ("آ", "ا"), ("ٱ", "ا"), ("ى", "ي"), ("ة", "ه")):
        word = word.replace(src, dst)
    return word


def terms(text: str) -> set[str]:
    """Meaningful words of a text, simplified so 'Statues' matches 'statue' and 'المسلة' matches 'مسلة'."""
    out: set[str] = set()
    for raw in _WORD_RE.findall(text.lower()):
        if _ARABIC_RE.search(raw):
            word = _normalize_arabic(raw)
            for prefix in ("وال", "بال", "لل", "ال"):
                if word.startswith(prefix) and len(word) - len(prefix) >= 3:
                    word = word[len(prefix):]
                    break
            if len(word) >= 3 and word not in _AR_STOP:
                out.add(word)
        else:
            word = raw.strip("_")
            if len(word) > 3 and word.endswith("s"):
                word = word[:-1]
            if len(word) > 5 and word.endswith("ing"):      # opening -> open
                word = word[:-3]
            elif len(word) > 5 and word.endswith("ed"):     # opened -> open
                word = word[:-2]
            if len(word) >= 3 and word not in _EN_STOP and not word.isdigit():
                out.add(word)
    return out


def relevance_flags(query_terms: set[str], row: dict, min_similarity: float) -> tuple[bool, bool, int, int]:
    """(meaning evidence, shared-word evidence, shared distinctive words, words needed) for one database row.

    Meaning evidence: the note's similarity to the question reaches min_similarity.
    Shared-word evidence: the note shares at least two distinctive words with the question
    (one if the question only has one). Words that appear in nearly every note do not count.
    """
    similarity = row.get("similarity")
    distinctive = {t for t in query_terms if t not in _GENERIC}
    overlap = len(distinctive & terms(row.get("content", "")))
    needed = min(2, len(distinctive))
    semantic = similarity is not None and similarity >= min_similarity
    lexical = needed > 0 and overlap >= needed
    return semantic, lexical, overlap, needed


def clean_query(query: str) -> str:
    return " ".join(query.split())[:MAX_QUERY_CHARS]


class RagSearcher:
    def __init__(
        self,
        supabase: SupabaseRest,
        embedder: OpenAIEmbedder | None,
        min_similarity: float = 0.30,
    ):
        self._supabase = supabase
        self._embedder = embedder
        self._min_similarity = min_similarity

    def search(self, query: str, language: str | None = None, limit: int = 5) -> dict[str, Any]:
        query = clean_query(query)
        lang = language if language in ("en", "ar") else detect_language(query)
        limit = max(1, min(int(limit), 10))

        # 0) a question about another museum is out of scope: no embedding, no search
        other = other_museum(query)
        if other:
            return {
                "query_language": lang,
                "mode": "not_searched",
                "enough_evidence": False,
                "contains_time_sensitive": False,
                "out_of_scope": {"reason": "other_museum", "museum": other},
                "results": [],
            }

        # 1) meaning vector (optional: a keyword-only search still works without it)
        mode, vector = "keyword_only", None
        if self._embedder is not None:
            try:
                vector = vector_literal(self._embedder.embed([query])[0])
                mode = "hybrid"
            except UpstreamError:
                pass  # OpenAI is down or out of budget: degrade, do not fail

        # 2) database search. Ask for extra rows: step 3 drops the irrelevant ones, and when the visitor
        #    named a place or artefact its notes must be among the candidates for step 4 to bring them forward.
        named = mentioned_entities(query)
        rows = self._supabase.rpc(
            "search_museum_knowledge",
            {
                "query_text": query,
                "query_embedding": vector,
                "query_language": lang,
                "match_count": 20 if named else min(limit * 2, 20),
                "include_conflicting": False,
            },
        )

        # 3) keep only what is really relevant
        query_terms = terms(query)
        kept = []
        for row in rows:
            similarity = row.get("similarity")
            semantic, lexical, _overlap, _needed = relevance_flags(query_terms, row, self._min_similarity)
            if not (semantic or lexical):
                continue
            kept.append(
                {
                    "chunk_key": row["chunk_key"],
                    "entity_key": row.get("entity_key"),
                    "language": row["language"],
                    "content": row["content"],
                    "verification_status": row["verification_status"],
                    "time_sensitive": bool(row.get("time_sensitive")),
                    "relevance": "both" if semantic and lexical else "semantic" if semantic else "keyword",
                    "entity_match": entity_match(row.get("entity_key"), named),
                    "scores": {
                        "keyword_rank": row.get("keyword_rank"),
                        "similarity": None if similarity is None else round(float(similarity), 4),
                        "score": round(float(row.get("score") or 0), 5),
                    },
                    "source": {
                        "title": row.get("source_title"),
                        "url": row.get("source_url"),
                        "type": row.get("source_type"),
                    },
                }
            )

        # 4) notes about what the visitor named come first (a stable sort keeps the database's order inside each group)
        order = {"exact": 0, "related": 1, None: 2}
        kept.sort(key=lambda r: order[r["entity_match"]])
        results = kept[:limit]

        return {
            "query_language": lang,
            "mode": mode,
            "enough_evidence": bool(results),
            "contains_time_sensitive": any(r["time_sensitive"] for r in results),
            "out_of_scope": None,
            "results": results,
        }
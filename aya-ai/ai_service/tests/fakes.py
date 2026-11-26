"""Fake OpenAI and fake Supabase servers for the tests.

They run inside the test process (httpx.MockTransport): nothing touches the network,
and any request to a host other than the two fake ones fails the test.
"""

import hashlib
import json
import math
import re

import httpx

DIM = 1536
OPENAI_KEY = "sk-test-OPENAI-key-0000000000000000"
SECRET_KEY = "sb_secret_TEST-SECRET-0000000000000000"
PUBLISHABLE_KEY = "sb_publishable_TEST-0000000000000000"
SUPABASE_URL = "https://fake-project.supabase.co"
ALL_SECRETS = (OPENAI_KEY, SECRET_KEY, PUBLISHABLE_KEY)

_STOP = {"the", "and", "for", "are", "what", "was", "did", "this", "that", "with", "from", "his", "her", "of", "is", "in", "to", "a"}


def words(text: str) -> list[str]:
    return [w for w in re.findall(r"\w+", text.lower()) if len(w) >= 3 and w not in _STOP]


def hash_embedding(text: str) -> list[float]:
    """A stand-in for a real embedding: texts that share words get similar vectors."""
    vector = [0.0] * DIM
    for w in words(text):
        vector[int(hashlib.md5(w.encode()).hexdigest(), 16) % DIM] += 1.0
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


class FakeOpenAI:
    def __init__(self):
        self.requests: list[dict] = []      # {"headers":..., "json":...}
        self.overrides: dict[str, list[float]] = {}   # exact text -> chosen vector
        self.fail_status: int | None = None
        self.fail_times = 0
        self.timeout = False
        self.bad_dimension = False

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append({"headers": dict(request.headers), "json": body})
        if self.timeout:
            raise httpx.ReadTimeout("slow", request=request)
        if request.headers.get("authorization") != f"Bearer {OPENAI_KEY}":
            return httpx.Response(401, json={"error": {"message": "bad key"}})
        if self.fail_times > 0 and self.fail_status:
            self.fail_times -= 1
            return httpx.Response(self.fail_status, json={"error": {"message": "nope", "type": "server_error"}})
        texts = body["input"]
        data = [
            {"index": i, "object": "embedding",
             "embedding": ([0.1] * 8 if self.bad_dimension else self.overrides.get(t) or hash_embedding(t))}
            for i, t in enumerate(texts)
        ]
        return httpx.Response(200, json={"object": "list", "data": list(reversed(data)),   # out of order on purpose
                                         "model": body["model"], "usage": {"prompt_tokens": 1, "total_tokens": 1}})

    @property
    def embedded_texts(self) -> list[str]:
        return [t for r in self.requests for t in r["json"]["input"]]


class FakeChat:
    """A stand-in for OpenAI chat completions. It behaves like a sensible model (so the whole guide can be
    tested without any network) and every answer can be replaced per test with `script[role] = ...`:
    a dict (the JSON to return), a function (system, user) -> dict, or an Exception instance to raise."""

    def __init__(self):
        self.requests: list[dict] = []
        self.script: dict[str, object] = {}
        self.status: int | None = None          # force an HTTP error status
        self.fail_times = 0

    @staticmethod
    def role(system: str) -> str:
        return re.search(r"ROLE: (\w+)", system).group(1).lower()

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append({"headers": dict(request.headers), "json": body})
        if request.headers.get("authorization") != f"Bearer {OPENAI_KEY}":
            return httpx.Response(401, json={"error": {"message": "bad key"}})
        if self.status and self.fail_times != 0:
            self.fail_times -= 1
            return httpx.Response(self.status, json={"error": {"message": "nope"}})
        system, user = body["messages"][0]["content"], body["messages"][1]["content"]
        role = self.role(system)
        scripted = self.script.get(role)
        if isinstance(scripted, Exception):
            raise scripted
        data = scripted(system, user) if callable(scripted) else scripted if scripted is not None else getattr(self, f"_{role}")(user)
        if isinstance(data, httpx.Response):
            return data
        return httpx.Response(200, json={"choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps(data, ensure_ascii=False)}}]})

    def calls(self, role: str) -> list[dict]:
        return [r for r in self.requests if self.role(r["json"]["messages"][0]["content"]) == role]

    # ---- default behaviour: a careful, literal "model" ----

    @staticmethod
    def _section(user: str, name: str) -> str:
        match = re.search(rf"<<<{name}>>>\n(.*?)\n<<<END>>>", user, re.S)
        return match.group(1) if match else ""

    def _understand(self, user: str) -> dict:
        latest = self._section(user, "LATEST MESSAGE")
        visitor_lines = [l[len("Visitor: "):] for l in self._section(user, "EARLIER CONVERSATION").splitlines() if l.startswith("Visitor: ")]
        short = len(words(latest)) <= 3
        return {"standalone_question": f"{visitor_lines[-1]} {latest}" if visitor_lines and short else latest}

    @staticmethod
    def _notes(user: str) -> list[tuple[int, str, str]]:
        block = FakeChat._section(user, "NOTES")
        return [(int(n), lang, text.strip()) for n, lang, text in re.findall(r"\[(\d+)\] \((\w+); source:[^\n]*\)\n(.*?)(?=\n\n\[\d+\] \(|\Z)", block, re.S)]

    @staticmethod
    def _best_sentence(question_words: set, text: str) -> tuple[float, str]:
        sentences = [x.strip() for x in re.split(r"(?<=[.!؟؛])\s+", text) if len(x.strip()) >= 12] or [text]
        best = max(sentences, key=lambda x: len(question_words & set(words(x))))
        return len(question_words & set(words(best))), best

    def _judge(self, user: str) -> dict:
        from app.rag import _GENERIC, terms
        q = {t for t in terms(self._section(user, "QUESTION")) if t not in _GENERIC}
        scored = []
        for n, _lang, text in self._notes(user):
            hits, sentence = self._best_sentence(q, text)
            coverage = len(q & terms(text)) / len(q) if q else 0
            if coverage >= 0.6:
                scored.append((coverage, n, sentence))
        scored.sort(reverse=True)
        picked = scored[:3]
        if not picked:
            return {"answerable": "none", "supporting": [], "missing": "everything"}
        return {"answerable": "full", "supporting": [{"note": n, "quote": sentence[:200]} for _c, n, sentence in picked], "missing": ""}

    def _answer(self, user: str) -> dict:
        arabic = "Arabic" in user.split("\n", 1)[0]
        notes = self._notes(user)
        pool = [n for n in notes if (n[1] == "ar") == arabic] or notes
        q = set(words(self._section(user, "QUESTION")))
        chosen = pool[:2]
        parts = [f"{self._best_sentence(q, text)[1]} [{n}]" for n, _l, text in chosen]
        return {"answer": " ".join(parts), "citations": [n for n, _l, _t in chosen]}

    # ---- the visit planner's "model": a keyword reader, enough to test the wiring (NOT real language understanding) ----

    _PLACES = (
        ("tutankhamun-galleries", ("tutankhamun galleries", "قاعات توت", "قاعات عرض كنوز")),
        ("golden-throne", ("golden throne", "العرش")), ("golden-burial-mask", ("golden mask", "burial mask", "القناع")),
        ("colossal-statue-ramesses-ii", ("colossal statue", "التمثال الضخم", "تمثال رمسيس")),
        ("hanging-obelisk", ("hanging obelisk", "المسلة المعلقة")), ("grand-stairs", ("grand stairs", "الدرج العظيم")),
        ("grand-hall", ("grand hall", "البهو العظيم")), ("main-galleries", ("main galleries", "قاعات العرض الرئيسة")),
        ("khufus-boats-museum", ("khufu", "خوفو")), ("seated-statue-sekhmet", ("sekhmet", "سخمت")),
        ("sarcophagus-djehutymose", ("djehutymose", "جحوتي")), ("canopic-chest", ("canopic",)),
    )
    _INTERESTS = (
        ("tutankhamun", ("tutankhamun", "توت")), ("treasures", ("treasure", "كنوز")), ("gold", ("gold", "ذهب", "دهب")),
        ("ramesses", ("ramesses", "رمسيس")), ("statues", ("statue", "تماثيل")), ("obelisks", ("obelisk", "مسل")),
        ("kings", ("kings", "ملوك")), ("gods", ("gods", "معبود")), ("history", ("history", "تاريخ")),
        ("boats", ("boat", "مراكب")),
    )
    _UNMATCHED = ("restaurant", "gift shop", "great pyramid", "cafe", "مطعم", "الهرم الاكبر")

    def _extract(self, user: str) -> dict:
        from app.domain import fold
        message = self._section(user, "VISITOR'S MESSAGE")
        text = fold(message)
        state = self._section(user, "CURRENT PLAN STATE")
        has_plan = not state.startswith("none")
        remove_words = ("remove", "without", "skip", "drop", "شيل", "احذف", "احذفي", "بدون", "من غير")
        add_words = ("add ", "ضيف", "اضف", "زود")
        modify_words = ("make it", "خليها", "خليه", "اجعلها", "instead", "change") + remove_words + add_words

        minutes = self._minutes(text)
        conflict = len(set(minutes)) > 1 and not any(m in text for m in ("make it", "خليها", "اجعلها"))
        cut = min([text.find(w) for w in remove_words if w in text] or [len(text)])
        before, after = text[:cut], text[cut:]
        add_cut = min([before.find(w) for w in add_words if w in before] or [len(before)])
        found = lambda part: [k for k, names in self._PLACES if any(fold(n).strip() in part for n in names)]
        remove = found(after)
        add = found(before[add_cut:]) if add_cut < len(before) else []
        must = [k for k in found(before[:add_cut]) if k not in add]
        modify = has_plan and any(w in text for w in modify_words)
        asking = text.strip().startswith(("what is", "what are", "who", "how", "why", "when", "where is", "tell me about", "ما ", "من ", "كيف", "هل"))
        planning = (bool(minutes) or modify or any(w in text for w in ("visit", "plan", "see", "زيار", "اشوف", "نشوف", "اتفرج")) or bool(must)) \
            and not (asking and not minutes and not modify and not any(w in text for w in ("visit", "plan", "زيار")))
        pace = "relaxed" if any(w in text for w in ("relaxed", "slow", "براحتي")) else "fast" if any(w in text for w in ("quick", "hurry", "بسرعة", "fast")) else "unspecified"
        return {
            "intent": ("modify" if modify else "create") if planning else "other",
            "minutes": minutes[0] if len(set(minutes)) == 1 else None, "time_conflict": conflict, "pace": pace,
            "interests": [t for t, names in self._INTERESTS if any(fold(n).strip() in text for n in names)] if not remove or not has_plan else [],
            "must_see": must, "add": add, "remove": remove,
            "unmatched": [u for u in self._UNMATCHED if fold(u).strip() in text],
        }

    @staticmethod
    def _minutes(text: str) -> list[int]:
        import re
        out = []
        for number, unit in re.findall(r"(\d+)\s*(hours?|hrs?|minutes?|mins?|ساع\w*|دقيق\w*|دقايق)", text):
            n = int(number)
            out.append(n * 60 if unit.startswith(("hour", "hr", "ساع")) else n)
        for pattern, value in (("an hour and a half", 90), ("ساعه ونص", 90), ("two hours", 120), ("ساعتين", 120), ("three hours", 180),
                               ("ثلاث ساعات", 180), ("one hour", 60), ("half an hour", 30), ("نص ساعه", 30)):
            if pattern in text:
                out.append(value)
        return out


class FakeSupabase:
    def __init__(self):
        self.tables: dict[str, dict] = {"museum_sources": {}, "museum_entities": {}, "museum_chunks": {}}
        self.tokens: dict[str, dict] = {}
        self.requests: list[dict] = []       # {"method","path","headers","json","params"}
        self.rpc_status: int | None = None
        self.auth_status: int | None = None
        self.missing_tables = False
        self._next_id = 0

    # ---- helpers for the tests ----
    @property
    def chunks(self) -> dict:
        return self.tables["museum_chunks"]

    def writes(self, table: str) -> list[dict]:
        return [r for r in self.requests if r["method"] == "POST" and r["path"] == f"/rest/v1/{table}"]

    # ---- the fake server ----
    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        headers = {k.lower(): v for k, v in request.headers.items()}
        body = json.loads(request.content) if request.content else None
        params = dict(request.url.params)
        self.requests.append({"method": request.method, "path": path, "headers": headers, "json": body, "params": params})

        if path == "/auth/v1/user":
            return self._auth(headers)
        if not path.startswith("/rest/v1/"):
            return httpx.Response(404)
        if headers.get("apikey") != SECRET_KEY:
            return httpx.Response(401, json={"message": "Invalid API key"})
        if self.missing_tables:
            return httpx.Response(404, json={"code": "PGRST205"})
        name = path.removeprefix("/rest/v1/")
        if name == "rpc/search_museum_knowledge":
            return self._search(body)
        if name in self.tables and request.method == "GET":
            return httpx.Response(200, json=self._select(name, params["select"]))
        if name in self.tables and request.method == "POST":
            return self._upsert(name, body, params["on_conflict"])
        return httpx.Response(404)

    def _auth(self, headers: dict) -> httpx.Response:
        if self.auth_status:
            return httpx.Response(self.auth_status)
        if headers.get("apikey") != PUBLISHABLE_KEY:
            return httpx.Response(401)
        token = headers.get("authorization", "").removeprefix("Bearer ")
        user = self.tokens.get(token)
        if not user:
            return httpx.Response(401, json={"msg": "invalid JWT"})
        return httpx.Response(200, json={"id": user["id"], "is_anonymous": user.get("is_anonymous", False)})

    def _select(self, table: str, columns: str) -> list[dict]:
        cols = columns.split(",")
        return [{c: row.get(c) for c in cols} for row in self.tables[table].values()]

    def _upsert(self, table: str, rows: list[dict], key: str) -> httpx.Response:
        store = self.tables[table]
        batch_keys = {r.get(key) for r in rows}
        for row in rows:
            error = self._check(table, row, batch_keys)
            if error:
                return httpx.Response(400, json={"message": error})
        for row in rows:
            current = store.get(row[key])
            if current is None:
                self._next_id += 1
                current = {"id": f"00000000-0000-4000-8000-{self._next_id:012d}"}
            current.update(row)   # merge-duplicates: only the columns that were sent change
            store[row[key]] = current
        return httpx.Response(201)

    def _check(self, table: str, row: dict, batch_keys: set) -> str | None:
        statuses = {"verified", "corroborated", "single_source", "conflicting"}
        if table == "museum_entities":
            parent = row.get("parent_key")
            if parent and parent not in self.tables["museum_entities"]:
                return f"parent {parent} must already exist"     # stricter than Postgres: proves the order
            if row.get("verification_status") not in statuses:
                return "bad status"
        if table == "museum_chunks":
            if row["source_id"] not in {s["id"] for s in self.tables["museum_sources"].values()}:
                return "unknown source_id"
            if row.get("entity_key") and row["entity_key"] not in self.tables["museum_entities"]:
                return "unknown entity"
            if row.get("language") not in ("en", "ar") or row.get("verification_status") not in statuses:
                return "bad language/status"
            if not 20 <= len(row["content"]) <= 1500:
                return "bad content length"
            if "embedding" in row:
                values = json.loads(row["embedding"]) if isinstance(row["embedding"], str) else None
                if not isinstance(row["embedding"], str) or not row["embedding"].startswith("[") or len(values) != DIM:
                    return "embedding must be '[...]' text with 1536 numbers"
        return None

    def _search(self, p: dict) -> httpx.Response:
        if self.rpc_status:
            return httpx.Response(self.rpc_status, json={"message": "boom with secrets?"})
        lang = "ar" if p["query_language"] == "ar" else "en"
        usable = [c for c in self.chunks.values() if p["include_conflicting"] or c["verification_status"] != "conflicting"]
        q_words = set(words(p["query_text"]))

        keyword = sorted(
            ((len(q_words & set(words(c["content"]))), c["chunk_key"]) for c in usable if c["language"] == lang),
            reverse=True,
        )
        keyword = [(n, k) for n, k in keyword if n > 0][:40]
        k_rank = {k: i + 1 for i, (_, k) in enumerate(keyword)}

        sims: dict[str, float] = {}
        if p["query_embedding"] is not None:
            q_vec = json.loads(p["query_embedding"])
            ranked = sorted(((cosine(q_vec, json.loads(c["embedding"])), c["chunk_key"]) for c in usable if c.get("embedding")), reverse=True)[:40]
            sims = {k: s for s, k in ranked}
        s_rank = {k: i + 1 for i, k in enumerate(sims)}

        rows = []
        for key in set(k_rank) | set(s_rank):
            c = self.chunks[key]
            score = (1 / (60 + k_rank[key]) if key in k_rank else 0) + (1 / (60 + s_rank[key]) if key in s_rank else 0)
            src = next(s for s in self.tables["museum_sources"].values() if s["id"] == c["source_id"])
            rows.append({"chunk_key": key, "entity_key": c.get("entity_key"), "language": c["language"], "content": c["content"],
                         "verification_status": c["verification_status"], "time_sensitive": c["time_sensitive"],
                         "source_title": src["title"], "source_url": src["url"], "source_type": src["source_type"],
                         "keyword_rank": k_rank.get(key), "similarity": sims.get(key), "score": score})
        rows.sort(key=lambda r: (-r["score"], r["chunk_key"]))
        return httpx.Response(200, json=rows[: max(1, min(p["match_count"], 20))])


class World:
    """Both fake servers behind one HTTP client; any other host raises."""

    def __init__(self):
        self.openai = FakeOpenAI()
        self.chat = FakeChat()
        self.supabase = FakeSupabase()
        self.stray: list[str] = []
        self.client = httpx.Client(transport=httpx.MockTransport(self._route))

    def _route(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host == "api.openai.com":
            return self.chat.handle(request) if request.url.path.endswith("/chat/completions") else self.openai.handle(request)
        if host == "fake-project.supabase.co":
            return self.supabase.handle(request)
        self.stray.append(str(request.url))
        raise AssertionError(f"unexpected outgoing request to {host}")
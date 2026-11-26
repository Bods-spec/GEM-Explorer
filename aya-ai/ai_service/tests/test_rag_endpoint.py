"""POST /rag/search: protection, validation, retrieval quality plumbing, failure modes.

Everything runs against the fake OpenAI / Supabase servers. The fake "embeddings" only
share words, so these tests prove the wiring and the rules, NOT real semantic quality.
That is checked in the first real test, with real embeddings.
"""

import json

import pytest

import fakes
from app.rag import detect_language, terms
from app.security import ApiError, DailyCap, RateLimiter
from conftest import GUEST_TOKEN, OTHER_TOKEN, USER_TOKEN, auth


def search(client, query="golden mask of Tutankhamun", token=USER_TOKEN, **extra):
    return client.post("/rag/search", json={"query": query, **extra}, headers=auth(token) if token else {})


# ---------------- who may call it ----------------

def test_a_valid_user_gets_results(make_client, ingested):
    response = search(make_client())
    assert response.status_code == 200
    assert response.json()["enough_evidence"] is True


@pytest.mark.parametrize("headers", [
    {}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer"}, {"Authorization": "Bearer too short"},
    {"Authorization": "Bearer unknown-token-0000000000000000"},
])
def test_missing_or_bad_tokens_are_rejected(make_client, ingested, headers):
    response = make_client().post("/rag/search", json={"query": "golden mask"}, headers=headers)
    assert response.status_code == 401 and response.json() == {"error": "UNAUTHORIZED"}
    assert ingested.supabase.writes("museum_chunks") == []
    assert not [r for r in ingested.supabase.requests if "rpc" in r["path"]], "no search ran"
    assert ingested.openai.requests == [], "no OpenAI call for an unauthorised caller"


def test_guests_are_blocked_unless_guest_mode_is_on(make_client, ingested):
    blocked = search(make_client(allow_guest_users=False), token=GUEST_TOKEN)
    assert blocked.status_code == 403 and blocked.json() == {"error": "GUESTS_NOT_ALLOWED"}
    allowed = search(make_client(allow_guest_users=True), token=GUEST_TOKEN)
    assert allowed.status_code == 200


def test_the_user_id_in_the_body_is_ignored(make_client, ingested):
    search(make_client(), user_id="someone-else", user={"id": "x"})
    rpc = next(r for r in ingested.supabase.requests if "rpc" in r["path"])
    assert "someone-else" not in json.dumps(rpc["json"])


def test_service_refuses_everything_when_not_configured(make_client, ingested):
    response = search(make_client(supabase_publishable_key=""))
    assert response.status_code == 503 and response.json() == {"error": "SERVICE_NOT_CONFIGURED"}


def test_auth_outage_is_a_503_not_an_open_door(make_client, ingested):
    ingested.supabase.auth_status = 500
    response = search(make_client())
    assert response.status_code == 503 and response.json() == {"error": "AUTH_UNAVAILABLE"}


def test_browsers_cannot_post_across_origins(make_client):
    response = make_client().options("/rag/search", headers={
        "Origin": "http://localhost:5600", "Access-Control-Request-Method": "POST"})
    assert response.status_code == 400


# ---------------- input checks ----------------

@pytest.mark.parametrize("body", [
    {}, {"query": ""}, {"query": "   "}, {"query": "x" * 301}, {"query": 5},
    {"query": "ok", "language": "fr"}, {"query": "ok", "limit": 0}, {"query": "ok", "limit": 11},
])
def test_invalid_requests_get_a_fixed_error_that_does_not_echo_input(make_client, ingested, body):
    response = make_client().post("/rag/search", json=body, headers=auth())
    assert response.status_code == 422 and response.json() == {"error": "INVALID_REQUEST"}


def test_non_json_body_is_invalid(make_client, ingested):
    response = make_client().post("/rag/search", content=b"not json", headers={**auth(), "Content-Type": "application/json"})
    assert response.status_code == 422


# ---------------- what comes back ----------------

def test_english_question_returns_the_right_note_with_its_source(make_client, ingested):
    body = search(make_client(), "What is the golden burial mask of Tutankhamun?").json()
    assert body["mode"] == "hybrid" and body["query_language"] == "en"
    top = body["results"][0]
    assert top["chunk_key"] == "golden-burial-mask-en"
    assert top["entity_key"] == "golden-burial-mask"
    assert top["verification_status"] == "verified"
    assert top["source"] == {
        "title": "Artefact: The Golden Burial Mask of Tutankhamun",
        "url": "https://gem.eg/en/collection/artefacts/the-golden-burial-mask-of-tutankhamun",
        "type": "official",
    }
    assert top["relevance"] in ("both", "semantic", "keyword")
    assert set(top["scores"]) == {"keyword_rank", "similarity", "score"}
    assert "golden" in top["content"].lower()


def test_arabic_question_is_detected_and_finds_the_arabic_note(make_client, ingested):
    body = search(make_client(), "ما هي مواعيد العمل في المتحف؟").json()
    assert body["query_language"] == "ar"
    keys = [r["chunk_key"] for r in body["results"]]
    assert "gem-hours-ar" in keys
    hours = next(r for r in body["results"] if r["chunk_key"] == "gem-hours-ar")
    assert hours["time_sensitive"] is True and body["contains_time_sensitive"] is True
    assert hours["language"] == "ar" and hours["source"]["url"] == "https://tickets.gem.eg/"


def test_arabic_question_can_reach_an_english_note_through_meaning(make_client, ingested):
    """The Arabic words appear in no English note; only the embedding can link them."""
    question = "ما هو القناع الذهبي لتوت عنخ آمون"
    ingested.openai.overrides[question] = fakes.hash_embedding(ingested.supabase.chunks["golden-burial-mask-en"]["content"])
    # Reciprocal-rank fusion favours notes found by BOTH lists, so a perfect meaning-only match
    # can sit just below them; ask for a longer list and check it is there.
    body = search(make_client(), question, limit=10).json()
    mask = next(r for r in body["results"] if r["chunk_key"] == "golden-burial-mask-en")
    assert mask["language"] == "en"
    assert mask["relevance"] == "semantic" and mask["scores"]["keyword_rank"] is None
    assert mask["scores"]["similarity"] > 0.99


def test_explicit_language_overrides_detection(make_client, ingested):
    search(make_client(), "obelisk", language="ar")
    rpc = next(r for r in ingested.supabase.requests if "rpc" in r["path"])
    assert rpc["json"]["query_language"] == "ar"


def test_limit_is_respected_and_results_are_ranked(make_client, ingested):
    body = search(make_client(), "Tutankhamun gold coffin throne mask", limit=3).json()
    assert 1 <= len(body["results"]) <= 3
    scores = [r["scores"]["score"] for r in body["results"]]
    assert scores == sorted(scores, reverse=True)


@pytest.mark.parametrize("question", [
    "best pizza restaurant near the museum", "how do I cook pasta carbonara", "xqzv blorp wug",
    "who won the football world cup", "ما هو أفضل مطعم بيتزا",
])
def test_unsupported_questions_return_no_evidence(make_client, ingested, question):
    body = search(make_client(), question).json()
    assert body["results"] == [] and body["enough_evidence"] is False


def test_conflicting_notes_are_never_returned(make_client, ingested):
    ingested.supabase.chunks["golden-burial-mask-en"]["verification_status"] = "conflicting"
    body = search(make_client(), "golden burial mask of Tutankhamun").json()
    assert "golden-burial-mask-en" not in [r["chunk_key"] for r in body["results"]]
    rpc = next(r for r in ingested.supabase.requests if "rpc" in r["path"])
    assert rpc["json"]["include_conflicting"] is False


def test_query_is_sent_embedded_as_pgvector_text(make_client, ingested):
    search(make_client(), "golden mask")
    rpc = next(r for r in ingested.supabase.requests if "rpc" in r["path"])
    vector = rpc["json"]["query_embedding"]
    assert vector.startswith("[") and len(json.loads(vector)) == 1536


# ---------------- when something fails ----------------

def test_openai_outage_falls_back_to_keyword_search(make_client, ingested):
    ingested.openai.fail_status, ingested.openai.fail_times = 500, 99
    body = search(make_client(), "golden burial mask of Tutankhamun").json()
    assert body["mode"] == "keyword_only"
    assert body["results"][0]["chunk_key"] == "golden-burial-mask-en"
    assert body["results"][0]["scores"]["similarity"] is None
    rpc = next(r for r in ingested.supabase.requests if "rpc" in r["path"])
    assert rpc["json"]["query_embedding"] is None


def test_no_openai_key_means_keyword_only(make_client, ingested):
    body = search(make_client(openai_api_key=""), "golden burial mask of Tutankhamun").json()
    assert body["mode"] == "keyword_only" and body["results"]
    assert ingested.openai.requests == []


def test_keyword_only_mode_still_says_no_when_nothing_matches(make_client, ingested):
    body = search(make_client(openai_api_key=""), "best pizza restaurant near the museum").json()
    assert body["results"] == [] and body["enough_evidence"] is False


def test_database_failure_is_a_generic_502(make_client, ingested, caplog):
    ingested.supabase.rpc_status = 500
    response = search(make_client())
    assert response.status_code == 502 and response.json() == {"error": "KNOWLEDGE_UNAVAILABLE"}
    assert not any(s in response.text + caplog.text for s in fakes.ALL_SECRETS)


def test_empty_knowledge_base_says_no_evidence(make_client, world):
    body = search(make_client(), "golden mask").json()      # nothing ingested
    assert body["results"] == [] and body["enough_evidence"] is False


# ---------------- limits ----------------

def test_per_user_rate_limit(make_client, ingested):
    client = make_client(rag_user_per_minute=3)
    assert [search(client).status_code for _ in range(3)] == [200, 200, 200]
    blocked = search(client)
    assert blocked.status_code == 429 and blocked.json() == {"error": "RATE_LIMITED"}
    assert int(blocked.headers["Retry-After"]) >= 1
    assert search(client, token=OTHER_TOKEN).status_code == 200      # another user is not affected


def test_per_ip_rate_limit_applies_before_login_is_checked(make_client, ingested):
    client = make_client(rag_ip_per_minute=2)
    assert [client.post("/rag/search", json={"query": "x"}).status_code for _ in range(2)] == [401, 401]
    blocked = client.post("/rag/search", json={"query": "x"})
    assert blocked.status_code == 429
    assert [r for r in ingested.supabase.requests if r["path"] == "/auth/v1/user"] == [], "bad tokens never reached Supabase"


def test_daily_cap_stops_all_searches(make_client, ingested):
    client = make_client(rag_daily_limit=2)
    assert [search(client).status_code for _ in range(2)] == [200, 200]
    blocked = search(client)
    assert blocked.status_code == 429 and blocked.json() == {"error": "DAILY_LIMIT_REACHED"}
    assert len(ingested.openai.requests) == 2, "no OpenAI call once the cap is reached"


def test_rate_limiter_window_slides():
    now = [0.0]
    limiter = RateLimiter(2, window=60, clock=lambda: now[0])
    limiter.check("a"); limiter.check("a")
    with pytest.raises(ApiError):
        limiter.check("a")
    limiter.check("b")
    now[0] = 61
    limiter.check("a")


def test_daily_cap_resets_on_a_new_day():
    day = ["2026-11-26"]
    cap = DailyCap(1, today=lambda: day[0])
    cap.hit()
    with pytest.raises(ApiError):
        cap.hit()
    day[0] = "2026-11-27"
    cap.hit()


# ---------------- secrets ----------------

def test_secrets_never_leave_their_own_service_and_never_appear_in_responses(make_client, ingested, caplog):
    client = make_client()
    texts = [search(client).text, search(client, token="nope-nope-nope-nope-nope-0000").text,
             client.get("/health").text]
    texts.append(make_client(supabase_publishable_key="").post("/rag/search", json={"query": "x"}, headers=auth()).text)
    assert not any(s in t for s in fakes.ALL_SECRETS for t in texts + [caplog.text])
    for req in ingested.openai.requests:
        assert fakes.SECRET_KEY not in str(req) and fakes.PUBLISHABLE_KEY not in str(req)
    for req in ingested.supabase.requests:
        assert fakes.OPENAI_KEY not in str(req)
        if req["path"] == "/auth/v1/user":
            assert req["headers"]["apikey"] == fakes.PUBLISHABLE_KEY    # the login check never uses the secret key


# ---------------- helpers ----------------

def test_detect_language():
    assert detect_language("ما هو القناع الذهبي") == "ar"
    assert detect_language("What is the golden mask?") == "en"
    assert detect_language("اعرض حجز GEM-ABCDE12345") == "ar"
    assert detect_language("") == "en"


def test_terms_simplify_both_languages():
    assert terms("المسلة المعلقة") == {"مسله", "معلقه"}
    assert terms("Statues of Ramesses") == {"statue", "ramesse"}
    assert terms("What is the best pizza near the museum?") == {"best", "pizza", "museum"}
    assert terms("opening") == terms("opened") == {"open"}
    assert terms("ما هي مواعيد العمل") == {"مواعيد", "عمل"}


# ---------------- retrieval expectations on the real dataset (wiring check) ----------------

EXPECTED = [
    ("What are the opening hours?", "gem-hours-en"),
    ("How long does the guided tour take?", "gem-guided-tour-en"),
    ("Tell me about the Hanging Obelisk", "hanging-obelisk-en"),
    ("How high is the colossal statue of Ramesses II?", "colossal-statue-ramesses-ii-en"),
    ("What was inside Tutankhamun's canopic chest?", "canopic-chest-en"),
    ("Who made the model of Tutankhamun on a funerary bed?", "model-funerary-bed-en"),
    ("Where can I buy official tickets?", "gem-official-tickets-en"),
    ("When did the museum open?", "gem-overview-en"),
    ("ما هي مواعيد العمل", "gem-hours-ar"),
    ("اين المسلة المعلقة", "hanging-obelisk-ar"),
    ("كم عدد القطع في الدرج العظيم", "grand-stairs-ar"),
    ("ما هي القاعات الرئيسية", "main-galleries-ar"),
]


@pytest.mark.parametrize("question, expected", EXPECTED)
def test_expected_note_is_in_the_top_three(make_client, ingested, question, expected):
    keys = [r["chunk_key"] for r in search(make_client(), question, limit=3).json()["results"]]
    assert expected in keys, keys


# ---------------- other museums and ranking ----------------

@pytest.mark.parametrize("question, museum", [
    ("What can I see in the Louvre Museum in Paris?", "Louvre Museum"),
    ("Tell me about the Egyptian Museum in Tahrir Square", "Egyptian Museum in Tahrir Square, Cairo"),
    ("ما هي أهم القطع في متحف اللوفر؟", "Louvre Museum"),
    ("المتحف المصري بالتحرير بيفتح امتى؟", "Egyptian Museum in Tahrir Square, Cairo"),
])
def test_a_question_about_another_museum_gets_no_evidence_and_costs_nothing(make_client, ingested, question, museum):
    body = search(make_client(), question).json()
    assert body["enough_evidence"] is False and body["results"] == []
    assert body["out_of_scope"] == {"reason": "other_museum", "museum": museum}
    assert body["mode"] == "not_searched"
    assert ingested.openai.requests == []                                   # nothing sent to OpenAI
    assert not [r for r in ingested.supabase.requests if "rpc" in r["path"]]  # and no database search


@pytest.mark.parametrize("question", [
    "Is the Grand Egyptian Museum bigger than the Louvre?",
    "Tell me about the Egyptian Museum",
    "Tell me about Ramesses II",
    "What is the Golden Throne?",
])
def test_ordinary_questions_are_searched_normally(make_client, ingested, question):
    body = search(make_client(), question).json()
    assert body["out_of_scope"] is None and body["mode"] == "hybrid"
    assert [r for r in ingested.supabase.requests if "rpc" in r["path"]]


@pytest.mark.parametrize("question, entities", [
    ("What can I see in the Tutankhamun Galleries?", {"tutankhamun-galleries"}),
    ("Tell me about the Golden Throne.", {"golden-throne"}),
    ("What is the Hanging Obelisk?", {"hanging-obelisk", "obelisk-ramesses-ii"}),
    ("What is the canopic chest?", {"canopic-chest"}),
    ("احكيلي عن المسلة المعلقة", {"hanging-obelisk", "obelisk-ramesses-ii"}),
    ("ما هو كرسي العرش الذهبي؟", {"golden-throne"}),
    ("إيه أهم الآثار الموجودة في البهو العظيم؟", {"grand-hall"}),
])
def test_notes_about_the_named_thing_come_first(make_client, ingested, question, entities):
    results = search(make_client(), question, limit=10).json()["results"]
    assert results and results[0]["entity_key"] in entities and results[0]["entity_match"] == "exact"
    order = [r["entity_match"] for r in results]
    assert order == sorted(order, key=lambda m: {"exact": 0, "related": 1, None: 2}[m])   # exact, then related, then the rest


def test_generic_notes_do_not_outrank_the_named_artefact(make_client, ingested):
    results = search(make_client(), "What can I see in the Tutankhamun Galleries? Tell me about the guided tour.", limit=10).json()["results"]
    first_generic = next((i for i, r in enumerate(results) if r["entity_match"] is None), len(results))
    assert all(r["entity_match"] in ("exact", "related") for r in results[:first_generic]) and first_generic >= 1


def test_the_database_is_asked_for_a_full_candidate_list_when_something_is_named(make_client, ingested):
    search(make_client(), "Tell me about the Golden Throne.", limit=2)
    rpc = next(r for r in ingested.supabase.requests if "rpc" in r["path"])
    assert rpc["json"]["match_count"] == 20
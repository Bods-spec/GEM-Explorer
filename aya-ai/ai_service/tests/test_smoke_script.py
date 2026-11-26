"""The real-service smoke test script, proven here against the FAKE servers only.

This shows the script's own logic works (reports, threshold study, authentication checks,
no secrets, no writes). It says nothing about real OpenAI or Supabase results.
"""

import fakes
import smoke_test_rag as smoke
from app.services import build_services
from conftest import GUEST_TOKEN, USER_TOKEN, make_settings


def run_smoke(world, tmp_path, token=USER_TOKEN, **settings):
    services = build_services(make_settings(**settings), world.client)
    services.embedder._sleep = lambda _s: None
    lines: list[str] = []
    code = smoke.run(services, token, tmp_path / "report.md", echo=lines.append)
    return code, "\n".join(lines), (tmp_path / "report.md").read_text(encoding="utf-8")


def test_report_has_every_section_and_every_question(ingested, tmp_path):
    _code, text, saved = run_smoke(ingested, tmp_path)
    for heading in ("## 1. Search results", "## 2. Genuine cross-language", "## 3. Is RAG_MIN_SIMILARITY appropriate?",
                    "### 3b. Meaning evidence only", "### 3c. Shared-word evidence only", "### 3d. What the API actually does",
                    "### 3e. Verdict", "## 4. Authentication", "## 5. Summary"):
        assert heading in text
    for question in smoke.QUESTIONS:
        assert question["q"] in text
    assert "enough_evidence" in text and "similarity" in text         # scores are shown on the console
    assert "https://" in saved                                         # source URLs are in the saved report
    assert set(text.splitlines()) - {"", "Report saved to report.md"} <= set(saved.splitlines())   # the console is a subset of the file


def test_no_key_or_token_is_ever_printed_or_saved(ingested, tmp_path):
    _code, text, saved = run_smoke(ingested, tmp_path)
    for secret in (*fakes.ALL_SECRETS, USER_TOKEN):
        assert secret not in text and secret not in saved


def test_the_script_only_reads_from_supabase(ingested, tmp_path):
    run_smoke(ingested, tmp_path)
    for request in ingested.supabase.requests:
        assert request["method"] in ("GET", "POST")
        if request["method"] == "POST":
            assert request["path"] == "/rest/v1/rpc/search_museum_knowledge"     # a read-only search function
        else:
            assert request["path"] == "/auth/v1/user"


def test_refused_requests_are_checked_and_cost_nothing(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path)
    assert "OpenAI calls made by the refused requests: **0**" in text
    assert text.count("| 401 UNAUTHORIZED | 401 UNAUTHORIZED |") == 4
    assert "auth: /health reveals no key | PASS" in text
    for qid in ("E1", "G2", "O1", "M1"):
        assert f"auth: valid token, {qid} | PASS" in text


def test_without_a_token_the_valid_login_check_is_skipped_not_passed(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path, token="")
    assert "was **not tested**" in text
    assert "a valid login is accepted | SKIPPED" in text


def test_a_guest_token_is_explained_when_guests_are_off(ingested, tmp_path):
    ingested.supabase.tokens[GUEST_TOKEN] = {"id": "g", "is_anonymous": True}
    code, text, _saved = run_smoke(ingested, tmp_path, token=GUEST_TOKEN, allow_guest_users=False)
    assert code == 1 and "GUESTS_NOT_ALLOWED" in text and "ALLOW_GUEST_USERS=true" in text


def test_a_wrong_token_is_reported_as_expired(ingested, tmp_path):
    code, text, _saved = run_smoke(ingested, tmp_path, token="expired-token-dddddddddddddddddddd")
    assert code == 1 and "UNAUTHORIZED" in text and "expired" in text


def test_threshold_study_lists_every_threshold_and_a_verdict(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path)
    for threshold in smoke.THRESHOLDS:
        assert f"| {threshold:.2f}" in text
    assert "← configured" in text and "### 3e. Verdict (recommendation only, nothing was changed)" in text


def test_a_search_failure_stops_cleanly_without_details(ingested, tmp_path):
    ingested.supabase.rpc_status = 500
    code, text, _saved = run_smoke(ingested, tmp_path)
    assert code == 1 and "STOPPED" in text and "boom" not in text
    for secret in fakes.ALL_SECRETS:
        assert secret not in text


def test_the_script_restores_the_app_afterwards(ingested, tmp_path):
    from app.main import app
    from app.services import get_services
    run_smoke(ingested, tmp_path)
    assert get_services not in app.dependency_overrides


def test_missing_keys_stop_before_anything_is_sent(monkeypatch, capsys):
    monkeypatch.setattr(smoke, "get_settings", lambda: make_settings(openai_api_key=""))
    monkeypatch.setattr(smoke, "build_services", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("must not build services")))
    assert smoke.main() == 2
    assert "OPENAI_API_KEY" in capsys.readouterr().out


# ---------------- the labelled question set and the separate kinds of check ----------------

def _checks(text):
    """{check name: 'PASS' | 'FAIL' | 'SKIPPED' | 'KNOWN LIMITATION'} from the summary table."""
    rows = [line.split(" | ") for line in text.splitlines() if line.startswith("| ") and line.rstrip().endswith(" |")]
    return {r[0][2:]: r[1] for r in rows if len(r) == 3 and r[1] in ("PASS", "FAIL", "SKIPPED", "KNOWN LIMITATION")}


def test_the_question_set_matches_the_dataset():
    import json
    from pathlib import Path
    base = Path(__file__).resolve().parent.parent / "knowledge"
    entity_keys = {e["entity_key"] for e in json.loads((base / "entities.json").read_text(encoding="utf-8"))}
    chunk_keys = {c["chunk_key"] for c in json.loads((base / "chunks.json").read_text(encoding="utf-8"))}
    ids = [q["id"] for q in smoke.QUESTIONS]
    assert len(ids) == len(set(ids))
    for q in smoke.QUESTIONS:
        assert q["group"] in ("en", "ar", "eg", "out_unrelated", "out_museum", "gate_pass", "adjacent"), q["id"]
        for spec in (q, q.get("cross") or {}):
            assert set(spec.get("entities", [])) <= entity_keys, q["id"]
            assert set(spec.get("chunks", [])) <= chunk_keys, q["id"]
        if q.get("cross"):
            assert q["cross"]["lang"] in ("en", "ar")
    groups = {g: [q for q in smoke.QUESTIONS if q["group"] == g] for g in ("en", "ar", "eg", "out_unrelated", "out_museum", "gate_pass", "adjacent")}
    assert all(len(v) >= 5 for v in groups.values())
    assert any(q["group"] in ("ar", "eg") and q.get("cross", {}).get("lang") == "en" for q in smoke.QUESTIONS)   # Arabic -> English note
    assert any(q["group"] == "en" and q.get("cross", {}).get("lang") == "ar" for q in smoke.QUESTIONS)          # English -> Arabic note


def test_relevance_ranking_and_cross_language_are_separate_checks(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path)
    names = _checks(text)
    kinds = {name.split(" ")[0].rstrip(":") for name in names}
    assert {"relevance", "ranking", "cross-language", "refusal", "other-museum", "not-refused", "auth", "threshold"} <= kinds
    # a note that is relevant but in the other language still counts as relevant
    assert "relevance A2: ما هو القناع الذهبي لتوت عنخ آمون؟" in names
    assert "cross-language A2: ما هو القناع الذهبي لتوت عنخ آمون؟" in names


def test_other_museum_questions_are_refused_without_calling_openai(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path)
    names = _checks(text)
    museum = {n: r for n, r in names.items() if n.startswith("other-museum")}
    assert len(museum) == 7 and set(museum.values()) == {"PASS"}
    assert all("0 OpenAI calls" in line for line in text.splitlines() if line.startswith("| other-museum M"))


def test_ordinary_questions_are_not_refused_by_the_museum_check(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path)
    names = _checks(text)
    assert {r for n, r in names.items() if n.startswith("not-refused")} == {"PASS"}
    assert len([n for n in names if n.startswith("not-refused")]) == 5


def test_unrelated_questions_are_refused(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path)
    refusals = {n: r for n, r in _checks(text).items() if n.startswith("refusal")}
    assert len(refusals) == 7 and set(refusals.values()) == {"PASS"}


def test_meaning_and_word_evidence_are_reported_separately_and_nothing_is_changed(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path)
    assert "### 3b. Meaning evidence only" in text and "### 3c. Shared-word evidence only" in text
    assert "your setting is not changed" in text and "Change it only if" in text
    assert "RAG_MIN_SIMILARITY=" not in text


def test_the_threshold_replay_uses_the_same_rule_as_the_api(ingested):
    """The report's 'what the API does' table is built with the real RagSearcher, so it cannot drift."""
    services = build_services(make_settings(), ingested.client)
    rows_seen = {}
    question = smoke.BY_ID["E2"]
    result = services.searcher.search(question["q"], None, smoke.LIMIT)
    vector = services.embedder.embed([question["q"]])[0]
    rows = services.supabase.rpc("search_museum_knowledge", {
        "query_text": question["q"], "query_embedding": smoke.vector_literal(vector), "query_language": "en",
        "match_count": 20, "include_conflicting": False})
    replayed = smoke.RagSearcher(smoke._Replay(rows), smoke._FixedEmbedder(vector), 0.30).search(question["q"], "en", smoke.LIMIT)
    assert [r["chunk_key"] for r in replayed["results"]] == [r["chunk_key"] for r in result["results"]]


def test_ranking_is_strict_position_two_is_a_failure(ingested, tmp_path, monkeypatch):
    services = build_services(make_settings(), ingested.client)
    services.embedder._sleep = lambda _s: None
    original = services.searcher.search

    def second_best(query, language=None, limit=5):
        result = original(query, language, limit)
        if len(result["results"]) >= 2:
            result["results"][0], result["results"][1] = result["results"][1], result["results"][0]
        return result

    monkeypatch.setattr(services.searcher, "search", second_best)
    lines: list[str] = []
    code = smoke.run(services, USER_TOKEN, tmp_path / "r.md", echo=lines.append)
    text = "\n".join(lines)
    ranking = [l for l in text.splitlines() if l.startswith("| ranking ")]
    assert code == 1 and any("| FAIL | position 2 (must be 1)" in l for l in ranking)
    assert not any("| PASS | position 2" in l for l in ranking)


def test_documented_limitations_are_reported_but_do_not_fail_the_run(ingested, tmp_path):
    """Cross-language misses and the A8/G6 ranking are shown as KNOWN LIMITATION, never hidden, never blocking."""
    services = build_services(make_settings(), ingested.client)
    services.embedder._sleep = lambda _s: None
    original = services.searcher.search

    def second_best(query, language=None, limit=5):
        result = original(query, language, limit)
        if "tickets" in query.lower() or "التذاكر" in query or "تذاكر" in query:
            r = result["results"]
            if len(r) >= 2:
                r[0], r[1] = r[1], r[0]
        return result

    services.searcher.search = second_best
    lines: list[str] = []
    smoke.run(services, USER_TOKEN, tmp_path / "r.md", echo=lines.append)
    text = "\n".join(lines)
    result = _checks(text)
    for name in ("ranking A8: expected note first", "ranking G6: expected note first"):
        assert result[name] in ("KNOWN LIMITATION", "PASS")
    assert not any(v == "FAIL" for k, v in result.items() if k.startswith(smoke.KNOWN_LIMITATIONS))
    assert all(k.startswith(smoke.KNOWN_LIMITATIONS) for k, v in result.items() if v == "KNOWN LIMITATION")
    assert "Known, documented, non-blocking limitations" in text or "KNOWN LIMITATION" not in text
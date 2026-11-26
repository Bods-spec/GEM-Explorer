"""smoke_test_guide.py proven against the FAKE servers only: this shows the script's own logic works
(report, checks, no secrets, read-only). It says nothing about real model quality."""

import fakes
import smoke_test_guide as smoke
from app.services import build_services
from conftest import USER_TOKEN, make_settings


def run_smoke(world, tmp_path, token=USER_TOKEN, **settings):
    services = build_services(make_settings(guide_user_per_minute=500, guide_user_per_day=5000, **settings), world.client)
    services.embedder._sleep = lambda _s: None
    services.guide._chat._sleep = lambda _s: None
    lines: list[str] = []
    code = smoke.run(services, token, tmp_path / "report.md", echo=lines.append)
    return code, "\n".join(lines), (tmp_path / "report.md").read_text(encoding="utf-8")


def checks(text):
    rows = [l.split(" | ") for l in text.splitlines() if l.startswith("| ") and l.rstrip().endswith(" |")]
    return {r[0][2:]: r[1] for r in rows if len(r) == 3 and r[1] in ("PASS", "FAIL", "SKIPPED")}


def test_report_shows_every_scenario_reply_and_source(ingested, tmp_path):
    _code, text, saved = run_smoke(ingested, tmp_path)
    for scenario in smoke.SCENARIOS:
        assert f"### {scenario['id']}" in text
    assert "## 1. Scenarios" in text and "## 2. Authentication" in text and "## 3. Summary" in text
    assert "https://gem.eg/" in saved and "**Guide (answered" in saved
    assert set(text.splitlines()) - {"", "Report saved to report.md"} <= set(saved.splitlines())


def test_the_fake_guide_passes_the_structural_checks_that_are_deterministic(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path)
    result = checks(text)
    for scenario in smoke.SCENARIOS:
        if scenario["kind"] in ("handoff", "other_museum", "smalltalk"):
            mine = {n: r for n, r in result.items() if n.startswith(scenario["id"] + ":")}
            assert mine and set(mine.values()) == {"PASS"}, (scenario["id"], mine)
    for name in ("auth: no Authorization header is refused", "auth: refused requests never reached OpenAI",
                 "auth: a valid login is accepted", "auth: an unknown conversation id is a 404"):
        assert result[name] == "PASS", name
    assert result["U1: politely refused, nothing invented"] == "PASS"
    assert result["U4: politely refused, nothing invented"] == "PASS"
    assert result["F1: answered with sources (turn 1)"] == "PASS"


def test_no_key_or_token_is_ever_printed_or_saved(ingested, tmp_path):
    _code, text, saved = run_smoke(ingested, tmp_path)
    for secret in (*fakes.ALL_SECRETS, USER_TOKEN):
        assert secret not in text and secret not in saved


def test_the_script_never_writes_and_never_touches_booking(ingested, tmp_path):
    run_smoke(ingested, tmp_path)
    for request in ingested.supabase.requests:
        assert request["method"] in ("GET", "POST")
        if request["method"] == "POST":
            assert request["path"] == "/rest/v1/rpc/search_museum_knowledge"
        else:
            assert request["path"] == "/auth/v1/user"


def test_without_a_token_the_valid_login_check_is_skipped_not_passed(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path, token="")
    assert checks(text)["auth: a valid login is accepted"] == "SKIPPED" and "(a valid login was not tested)" in text


def test_a_guide_that_answers_unsupported_questions_is_caught(ingested, tmp_path):
    """If the judge wrongly approved the restaurant question, the script must report a FAIL."""
    real = ingested.chat._judge

    def lenient(system, user):
        verdict = real(user)
        if verdict["answerable"] == "none":
            note = ingested.chat._notes(user)[0]
            return {"answerable": "full", "missing": "", "supporting": [{"note": note[0], "quote": ingested.chat._best_sentence(set(), note[2])[1]}]}
        return verdict

    ingested.chat.script["judge"] = lenient
    code, text, _saved = run_smoke(ingested, tmp_path)
    assert code == 1 and "CHECK(S) FAILED" in text
    assert any(r == "FAIL" for n, r in checks(text).items() if n.startswith("U"))


def test_a_model_failure_stops_the_run_with_a_clear_hint_and_saves_the_report(ingested, tmp_path):
    from app.clients import UpstreamError
    ingested.chat.script["judge"] = UpstreamError("openai-chat", 404)
    code, text, saved = run_smoke(ingested, tmp_path)
    assert code == 1 or "unavailable" in text
    assert saved.startswith("# GEM Explorer AI: Museum Guide smoke test")


def test_attempts_to_inject_instructions_are_checked(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path)
    result = checks(text)
    for sid in ("I1", "I2", "I3", "I4"):
        assert result[f"{sid}: no link the guide was not given"] == "PASS"
        assert result[f"{sid}: did not start booking or change mode"] == "PASS"


# ====================== Step 3 finalisation: targeted script, login prompt, C3 rules ======================

import getpass
import sys

import smoke_test_guide_targeted as targeted


def test_the_token_comes_from_a_hidden_prompt_or_the_environment_and_is_never_shown(monkeypatch, capsys):
    monkeypatch.delenv("SMOKE_TEST_ACCESS_TOKEN", raising=False)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    prompts = []
    monkeypatch.setattr(getpass, "getpass", lambda prompt="": prompts.append(prompt) or "  typed-token-value-123  ")
    assert smoke.read_token() == "typed-token-value-123" and "hidden" in prompts[0]
    monkeypatch.setenv("SMOKE_TEST_ACCESS_TOKEN", "env-token-value-456")
    assert smoke.read_token() == "env-token-value-456" and len(prompts) == 1       # no prompt when .env has it
    monkeypatch.delenv("SMOKE_TEST_ACCESS_TOKEN")
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    assert smoke.read_token() == ""                                                  # unattended: skipped, never blocks
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(getpass, "getpass", lambda prompt="": (_ for _ in ()).throw(EOFError()))
    assert smoke.read_token() == ""
    out = capsys.readouterr()
    assert "typed-token-value" not in out.out + out.err and "env-token-value" not in out.out + out.err


def test_a_valid_login_is_accepted_by_the_guide_and_the_token_never_reaches_the_report(ingested, tmp_path):
    token = USER_TOKEN
    _code, text, saved = run_smoke(ingested, tmp_path, token=token)
    result = checks(text)
    assert result["auth: a valid login is accepted"] == "PASS"
    assert result["auth: the same login can continue its conversation"] == "PASS"
    assert result["auth: an unknown conversation id is a 404"] == "PASS"
    assert result["auth: a 501-character message is refused"] == "PASS"
    assert token not in text and token not in saved and "Valid login (the token is never shown or saved)" in saved


def test_a_guest_or_expired_token_gets_a_helpful_hint_not_a_pass(ingested, tmp_path):
    _code, text, saved = run_smoke(ingested, tmp_path, token="expired.token." + "z" * 30)
    assert checks(text)["auth: a valid login is accepted"] == "FAIL" and "fresh one" in saved
    assert "expired.token" not in saved


def test_the_targeted_run_only_runs_the_chosen_scenarios_and_shows_a_trace(ingested, tmp_path):
    services = build_services(make_settings(guide_user_per_minute=500, guide_user_per_day=5000), ingested.client)
    services.embedder._sleep = lambda _s: None
    services.guide._chat._sleep = lambda _s: None
    lines: list[str] = []
    smoke.run(services, USER_TOKEN, tmp_path / "t.md", echo=lines.append, only=targeted.TARGETED)
    text = "\n".join(lines)
    ran = {l[4:6] for l in text.splitlines() if l.startswith("### ")}
    assert ran == set(targeted.TARGETED) and "### B1" not in text and "### F1 " not in text
    assert "_trace · searched:" in text and "reused from earlier turns:" in text and "judge:" in text
    assert {s["id"] for s in smoke.SCENARIOS} >= set(targeted.TARGETED)


def test_the_builder_scenario_accepts_only_a_grounded_answer_or_an_honest_refusal():
    scenario = next(s for s in smoke.SCENARIOS if s["id"] == "C3")
    source = {"n": 1, "note": "obelisk-ramesses-ii-en", "title": "T", "url": "https://gem.eg/x", "verification_status": "verified", "time_sensitive": False}

    def turn(status, reply, sources):
        return {"status": status, "reply": reply, "sources": sources, "conversation_id": "c", "contains_time_sensitive": False,
                "handoff": None, "register": "en", "language": "en", "enough_evidence": status == "answered"}

    used = [(2, 1, 1, "x", 1), (3, 1, 1, "what is the hanging obelisk? who built it", 1)]
    first = turn("answered", "It is an obelisk [1].", [source])

    def verdicts(second):
        return {w: ok for w, ok, _d in smoke.evaluate(scenario, [first, second], used)}

    good = verdicts(turn("answered", "King Ramesses II raised it [1].", [source]))
    assert good["answered only with what the notes say (Ramesses II raised it)"] is True
    invented = verdicts(turn("answered", "Ramesses II had the architect Senmut build it [1].", [source]))
    assert invented["answered only with what the notes say (Ramesses II raised it)"] is False
    refusal = verdicts(turn("insufficient_evidence", "I don't have that.", []))
    assert refusal["honest refusal (the notes do not say who built it)"] is True
    assert verdicts(turn("insufficient_evidence", "x", [source]))["honest refusal (the notes do not say who built it)"] is False
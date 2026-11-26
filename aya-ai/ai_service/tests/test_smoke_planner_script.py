"""smoke_test_planner.py proven against the FAKE servers only: this shows the script's own logic works
(report, checks, no secrets, read-only). It says nothing about real model quality."""

import fakes
import smoke_test_planner as smoke
from app.services import build_services
from conftest import USER_TOKEN, make_settings


def run_smoke(world, tmp_path, token=USER_TOKEN, only=None, **settings):
    services = build_services(make_settings(planner_user_per_minute=500, planner_user_per_day=5000, **settings), world.client)
    services.embedder._sleep = lambda _s: None
    services.planner._chat._sleep = lambda _s: None
    lines: list[str] = []
    code = smoke.run(services, token, tmp_path / "report.md", echo=lines.append, only=only)
    return code, "\n".join(lines), (tmp_path / "report.md").read_text(encoding="utf-8")


def checks(text):
    rows = [l.split(" | ") for l in text.splitlines() if l.startswith("| ") and l.rstrip().endswith(" |")]
    return {r[0][2:]: r[1] for r in rows if len(r) == 3 and r[1] in ("PASS", "FAIL", "SKIPPED")}


def test_report_shows_every_scenario_reply_and_what_the_model_understood(ingested, tmp_path):
    _code, text, saved = run_smoke(ingested, tmp_path)
    for scenario in smoke.SCENARIOS:
        assert f"### {scenario['id']}" in text
    assert "## 1. Scenarios" in text and "## 2. Authentication" in text and "## 3. Summary" in text
    assert "model understood:" in saved and "https://gem.eg/" in saved and "**Planner (plan_created" in saved
    assert set(text.splitlines()) - {"", "Report saved to report.md"} <= set(saved.splitlines())


def test_the_deterministic_scenarios_and_auth_pass_with_the_fake_servers(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path)
    result = checks(text)
    for scenario in smoke.SCENARIOS:
        if scenario["kind"] in ("handoff", "other_museum", "smalltalk", "conflict", "too_short"):
            mine = {n: r for n, r in result.items() if n.startswith(scenario["id"] + ":")}
            assert mine and set(mine.values()) == {"PASS"}, (scenario["id"], mine)
    for name in ("auth: no Authorization header is refused", "auth: refused requests never reached OpenAI",
                 "auth: a valid login is accepted", "auth: the same login can continue its plan", "auth: an unknown conversation id is a 404"):
        assert result[name] == "PASS", name
    assert result["P2: plan rules hold (budget, real stops, real sources, no routes)"] == "PASS"
    assert result["F1: the follow-up updated the SAME plan"] == "PASS"
    assert result["Q1: one short question first"] == "PASS"


def test_a_broken_plan_would_be_caught_by_the_structural_checks(ingested, tmp_path):
    services = build_services(make_settings(), ingested.client)
    catalog = services.planner.catalog()
    good = services.planner.respond("u", "I have two hours and want to see Tutankhamun's treasures.")
    assert smoke.plan_problems(good, catalog, 120) == []
    over = dict(good, plan=dict(good["plan"], total_estimated_minutes=999))
    assert any("999" in p for p in smoke.plan_problems(over, catalog, 120))
    fake_stop = dict(good["plan"]["stops"][0], key="secret-vault")
    assert any("secret-vault" in p for p in smoke.plan_problems(dict(good, plan=dict(good["plan"], stops=[fake_stop])), catalog, 120))
    bad_source = dict(good["plan"]["stops"][0], sources=[{"title": "x", "url": "https://evil.example.com/"}])
    assert any("evil.example.com" in p for p in smoke.plan_problems(dict(good, plan=dict(good["plan"], stops=[bad_source])), catalog, 120))
    assert any("floors" in p for p in smoke.plan_problems(dict(good, reply="Take the stairs to floor 2, room 5."), catalog, 120))


def test_no_key_or_token_is_ever_printed_or_saved(ingested, tmp_path):
    _code, text, saved = run_smoke(ingested, tmp_path)
    for secret in (*fakes.ALL_SECRETS, USER_TOKEN):
        assert secret not in text and secret not in saved


def test_the_script_only_reads(ingested, tmp_path):
    run_smoke(ingested, tmp_path)
    for request in ingested.supabase.requests:
        assert request["method"] == "GET", request
    assert not any("book" in r["path"] for r in ingested.supabase.requests)
    assert ingested.openai.requests == []                                    # the planner needs no embeddings


def test_without_a_token_the_valid_login_check_is_skipped_not_passed(ingested, tmp_path):
    code, text, _saved = run_smoke(ingested, tmp_path, token="")
    assert checks(text)["auth: a valid login is accepted"] == "SKIPPED" and "was **not tested**" in text and isinstance(code, int)


def test_only_runs_the_chosen_scenarios(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path, only=("B1", "S1"))
    assert "### B1" in text and "### S1" in text and "### P1" not in text


def test_a_model_failure_stops_the_run_with_a_clear_message(ingested, tmp_path):
    from app.clients import UpstreamError
    ingested.chat.script["extract"] = UpstreamError("openai-chat", 500)
    code, text, _saved = run_smoke(ingested, tmp_path, only=("P2",))
    assert "_model understood:" not in text and "(unavailable" in text and "| FAIL |" in text and code == 1


def test_a_reply_may_repeat_a_refused_request_but_not_obey_it():
    assert not smoke.repeats_injection("I have no verified information about «Secret Vault», so I did not add anything for that.")
    assert smoke.repeats_injection("Stop 5: Secret Vault, 300 minutes")
    assert smoke.repeats_injection("Entry is free for everyone")
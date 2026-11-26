"""smoke_test_planner_turn.py against the FAKE servers only: proves the script's own logic, not model quality."""

import fakes
import smoke_test_planner_turn as smoke
from app.services import build_services
from conftest import USER_TOKEN, make_settings


def run_smoke(world, tmp_path, token=USER_TOKEN):
    services = build_services(make_settings(planner_user_per_minute=500, planner_user_per_day=5000), world.client)
    services.embedder._sleep = lambda _s: None
    services.planner._chat._sleep = lambda _s: None
    lines: list[str] = []
    code = smoke.run(services, token, tmp_path / "report.md", echo=lines.append)
    return code, "\n".join(lines), (tmp_path / "report.md").read_text(encoding="utf-8")


def results(text):
    rows = [l.split(" | ") for l in text.splitlines() if l.startswith("| ") and l.rstrip().endswith(" |")]
    return {r[0][2:]: r[1] for r in rows if len(r) == 3 and r[1] in ("PASS", "FAIL", "SKIPPED")}


def test_every_scenario_is_in_the_report_and_the_deterministic_checks_pass(ingested, tmp_path):
    _code, text, saved = run_smoke(ingested, tmp_path)
    for scenario in smoke.SCENARIOS:
        assert f"### {scenario['id']}" in text
    result = results(text)
    for name in ("T1: first turn made a plan for 120 minutes", "T1: follow-up updated the SAME plan to 90 minutes, not 90 visitors",
                 "T1: Grand Stairs removed", "T3: handed back to the booking system", "T3: ZERO model calls",
                 "T4: one short question first", "auth: no Authorization header is refused", "auth: refused requests never reached OpenAI",
                 "auth: a valid login is accepted", "auth: the same login and conversation id update the same plan",
                 "auth: a user id in the body is ignored"):
        assert result[name] == "PASS", name
    assert "plan_presented=True" in saved


def test_no_key_or_token_is_printed_or_saved_and_it_only_reads(ingested, tmp_path):
    _code, text, saved = run_smoke(ingested, tmp_path)
    for secret in (*fakes.ALL_SECRETS, USER_TOKEN):
        assert secret not in text and secret not in saved
    assert all(r["method"] == "GET" for r in ingested.supabase.requests)


def test_without_a_token_the_valid_login_check_is_skipped(ingested, tmp_path):
    _code, text, _saved = run_smoke(ingested, tmp_path, token="")
    assert results(text)["auth: a valid login is accepted"] == "SKIPPED"
"""Small REAL test of POST /planner/turn (the Planner as a tool of the Booking Agent). Phase A of the integration.

Run it from the ai_service folder:   python smoke_test_planner_turn.py

READ-ONLY: nothing is written to Supabase and no booking system is contacted. Real OpenAI chat model and real Supabase
entity tables, a few cents at most (about 10 small model calls). It checks what the Booking Agent will rely on:

  a message that mixes planning and booking, with booking_handled=true, makes a plan and ignores the booking words
  "90 minutes" is time, never visitors; the caller's conversation id keeps ONE plan across turns
  a booking-only message is handed back with ZERO model calls; Egyptian Arabic is kept in follow-ups
  the endpoint verifies the visitor's token itself and refuses everything else

Keys come ONLY from ai_service/.env. Keys and tokens are never printed or saved. The report is saved to
smoke_test_planner_turn_report.md (UTF-8).
"""

import sys
from datetime import datetime
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.services import Services, build_services, get_services
from smoke_test_guide import read_token
from smoke_test_planner import Meter, plan_problems
from smoke_test_rag import Report

HERE = Path(__file__).resolve().parent
SMOKE_USER = "smoke-test-user"

# Each scenario is a conversation: (message, extra request fields). The id is the caller's, like the Booking Agent's.
SCENARIOS = [
    dict(id="T1", note="planning + booking in one message (English)", turns=[
        ("Plan a 2-hour visit for the Tutankhamun treasures and book 2 tickets for Friday", dict(booking_handled=True, language="en")),
        ("Make it 90 minutes and remove the Grand Stairs", dict(language="en"))]),
    dict(id="T2", note="planning + booking in one message (Egyptian Arabic)", turns=[
        ("عايز خطة زيارة ساعتين وعايز اشوف الدهب، وأحجز تذكرتين يوم الجمعة", dict(booking_handled=True, language="ar")),
        ("خليها 90 دقيقة", dict(language="ar"))]),
    dict(id="T3", note="a booking-only message must be handed back, with no model call", turns=[
        ("I want to book 3 tickets for tomorrow", dict(language="en"))]),
    dict(id="T4", note="a bare time answer after a question", turns=[
        ("I want to see the Hanging Obelisk", dict(language="en")), ("2 hours", dict(language="en"))]),
    dict(id="T5", note="booking words must not become interests or places", turns=[
        ("I have 3 hours and I like kings. Please book 4 tickets for next Sunday under the name Aya Hassan.", dict(booking_handled=True, language="en"))]),
]


def evaluate(scenario: dict, turns: list[dict], used: list[tuple], catalog) -> list[tuple[str, bool, str]]:
    sid, checks = scenario["id"], []

    def check(what: str, ok: bool, detail: str = "") -> None:
        checks.append((f"{sid}: {what}", bool(ok), detail or ("ok" if ok else "see the report")))

    first, last = turns[0], turns[-1]
    check("the caller's conversation id is kept", all(t["conversation_id"] == turns[0]["conversation_id"] for t in turns))
    if sid in ("T1", "T2"):
        check("first turn made a plan for 120 minutes", first["status"] == "plan_created" and first["time_budget_minutes"] == 120,
              f"status {first['status']}, minutes {first['time_budget_minutes']}")
        check("plan_presented is true", first["plan_presented"] is True)
        check("no handoff, booking words ignored", first["handoff"] is None and not any(
            w in " ".join(first["unmatched_requests"]).lower() for w in ("ticket", "friday", "book", "تذكر", "الجمعة", "احجز", "أحجز")),
              "unmatched: " + ", ".join(first["unmatched_requests"]))
        check("plan rules hold", not plan_problems(first, catalog, 120), "; ".join(plan_problems(first, catalog, 120)))
        check("follow-up updated the SAME plan to 90 minutes, not 90 visitors",
              last["status"] == "plan_updated" and last["time_budget_minutes"] == 90, f"status {last['status']}, minutes {last['time_budget_minutes']}")
        check("interests kept", {i["key"] for i in first["preferences"]["interests"]} <= {i["key"] for i in last["preferences"]["interests"]})
        check("follow-up plan rules hold", not plan_problems(last, catalog, 90), "; ".join(plan_problems(last, catalog, 90)))
        if sid == "T1":
            check("Grand Stairs removed", "grand-stairs" not in [s["key"] for s in last["plan"]["stops"]])
        if sid == "T2":
            check("Egyptian Arabic kept in both turns", first["register"] == "eg" and last["register"] == "eg", f"{first['register']} / {last['register']}")
    elif sid == "T3":
        check("handed back to the booking system", first["status"] == "handoff" and first["handoff"]["target"] == "booking_system" and first["plan"] is None)
        check("ZERO model calls", used[0][0] == 0, f"{used[0][0]} model call(s)")
    elif sid == "T4":
        check("one short question first", first["status"] == "needs_clarification" and first["plan_presented"] is False, f"status {first['status']}")
        check("then a plan with the must-see kept", last["status"] == "plan_created" and last["plan_presented"] is True
              and [m["key"] for m in last["preferences"]["must_see"]] == ["hanging-obelisk"], f"status {last['status']}")
    elif sid == "T5":
        check("a plan for 180 minutes", first["status"] == "plan_created" and first["time_budget_minutes"] == 180, f"status {first['status']}")
        check("no booking word became an interest or place", not any(w in " ".join(first["unmatched_requests"]).lower() for w in ("ticket", "sunday", "aya", "hassan")),
              "unmatched: " + ", ".join(first["unmatched_requests"]))
        check("the visitor's name is not repeated", "aya" not in first["reply"].lower() and "hassan" not in first["reply"].lower())
    return checks


def scenarios_section(services: Services, report: Report, checks: list, secrets: list[str]) -> None:
    report.add("## 1. Scenarios (real OpenAI chat model + real Supabase entity tables)\n")
    meter = Meter(services)
    catalog = services.planner.catalog()
    try:
        for scenario in SCENARIOS:
            conversation_id = f"smoke-{scenario['id'].lower()}-conversation"
            report.add(f"### {scenario['id']}  {scenario['note']}")
            turns, used = [], []
            for message, extra in scenario["turns"]:
                before, trace = meter.snapshot(), {}
                turn = services.planner.turn(SMOKE_USER, message, conversation_id, extra.get("language"), extra.get("booking_handled", False), trace)
                after = meter.snapshot()
                turns.append(turn)
                used.append((after[0] - before[0], after[1] - before[1]))
                report.add(f"**Booking Agent sends:** {message}  `{extra}`")
                report.add(f"**Planner tool ({turn['status']}, {turn['register']}, plan_presented={turn['plan_presented']}):**\n\n{turn['reply']}\n")
                understood = trace.get("extracted")
                if understood:
                    report.add("_model understood: " + ", ".join(f"{k}={v}" for k, v in understood.items() if v not in (None, [], False)) + "_")
                report.add(f"_model calls: {used[-1][0]} · embedding calls: {used[-1][1]}_\n")
            for name, ok, detail in evaluate(scenario, turns, used, catalog):
                checks.append((name, ok, detail))
            leaked = [s for s in secrets if s and any(s in t["reply"] for t in turns)]
            checks.append((f"{scenario['id']}: no key or token in the reply", not leaked, "clean" if not leaked else "A SECRET APPEARS IN A REPLY"))
    finally:
        meter.restore()


def auth_section(services: Services, token: str, report: Report, checks: list) -> None:
    report.add("## 2. Authentication of POST /planner/turn\n")
    client = TestClient(app)
    meter = Meter(services)
    publishable = services.settings.supabase_publishable_key
    body = {"message": "hello", "conversation_id": "smoke-auth-conversation"}
    try:
        before = meter.snapshot()
        report.add("| Request | Expected | Got |\n|---|---|---|")
        for name, headers in (
            ("no Authorization header", {}),
            ("Authorization is not a Bearer token", {"Authorization": "Basic dGVzdDp0ZXN0"}),
            ("Bearer token that is not a real login", {"Authorization": "Bearer smoke.test." + "a" * 40}),
            ("the public (publishable) key used as a token", {"Authorization": f"Bearer {publishable}"}),
        ):
            response = client.post("/planner/turn", json=body, headers=headers)
            ok = response.status_code == 401 and response.json() == {"error": "UNAUTHORIZED"}
            report.add(f"| {name} | 401 UNAUTHORIZED | {response.status_code} {response.json().get('error', '')} |")
            checks.append((f"auth: {name} is refused", ok, f"status {response.status_code}"))
        spent = meter.snapshot()
        cost = sum(spent) - sum(before)
        checks.append(("auth: refused requests never reached OpenAI", cost == 0, f"{cost} OpenAI call(s) made by refused requests"))
        report.add(f"\nOpenAI calls made by the refused requests: **{cost}** (must be 0).\n")
        invalid = client.post("/planner/turn", json={"message": "hi", "conversation_id": "short"}, headers={"Authorization": "Bearer smoke.test." + "a" * 40})
        checks.append(("auth: a bad body is refused before anything else runs", invalid.status_code in (401, 422), f"status {invalid.status_code}"))

        if not token:
            report.add("A valid login was **not tested**: there is no SMOKE_TEST_ACCESS_TOKEN in .env and none was typed.\n")
            checks.append(("auth: a valid login is accepted", None, "skipped (no token)"))
            return
        headers = {"Authorization": f"Bearer {token}"}
        cid = "smoke-valid-login-conversation"
        first = client.post("/planner/turn", json={"message": "I have two hours and want the Golden Throne", "conversation_id": cid, "language": "en"}, headers=headers)
        if first.status_code != 200:
            code = first.json().get("error")
            hint = {"UNAUTHORIZED": "the token is expired or wrong: copy a fresh one",
                    "GUESTS_NOT_ALLOWED": "this is a guest token: set ALLOW_GUEST_USERS=true (APP_ENV=development, FRONTEND_ORIGIN=http://localhost:5600) in .env"}.get(code, "")
            report.add(f"Valid login: {first.status_code} {code} {hint}\n")
            checks.append(("auth: a valid login is accepted", False, f"{first.status_code} {code} {hint}".strip()))
            return
        data = first.json()
        report.add(f"Valid login (the token is never shown or saved): 200, status {data['status']}, plan_presented {data['plan_presented']}.\n")
        checks.append(("auth: a valid login is accepted", data["status"] == "plan_created" and data["plan_presented"] is True, f"status {data['status']}"))
        second = client.post("/planner/turn", json={"message": "make it 90 minutes", "conversation_id": cid, "language": "en"}, headers=headers)
        checks.append(("auth: the same login and conversation id update the same plan",
                       second.status_code == 200 and second.json()["status"] == "plan_updated" and second.json()["time_budget_minutes"] == 90, f"status {second.status_code}"))
        spoof = client.post("/planner/turn", json={"message": "hello", "conversation_id": cid, "user_id": "someone-else"}, headers=headers)
        checks.append(("auth: a user id in the body is ignored", spoof.status_code == 200, f"status {spoof.status_code}"))
    finally:
        meter.restore()


def run(services: Services, token: str = "", report_path: Path | None = None, echo=print) -> int:
    settings = services.settings
    secrets = [settings.openai_api_key, settings.supabase_secret_key, settings.supabase_publishable_key, token]
    report = Report(secrets, echo)
    checks: list = []

    def save():
        if report_path:
            report_path.write_text("\n".join(report.lines) + "\n", encoding="utf-8")

    app.dependency_overrides[get_services] = lambda: services
    try:
        report.add("# GEM Explorer AI: POST /planner/turn smoke test (real OpenAI + real Supabase)\n")
        report.add(f"Run: {datetime.now().strftime('%Y-%m-%d %H:%M')} · chat model: {settings.openai_chat_model} · {len(SCENARIOS)} scenarios")
        report.add("Read-only: nothing was written to Supabase and no booking system was contacted. No key or token is shown.\n")
        try:
            scenarios_section(services, report, checks, secrets)
        except Exception as error:
            report.add(f"**STOPPED:** a request failed ({type(error).__name__}: {getattr(error, 'service', '')} {getattr(error, 'status', '')}).")
            save()
            return 1
        auth_section(services, token, report, checks)
    finally:
        app.dependency_overrides.pop(get_services, None)

    report.add("## 3. Summary\n")
    report.add("| Check | Result | Detail |\n|---|---|---|")
    for name, ok, detail in checks:
        report.add(f"| {name} | {'SKIPPED' if ok is None else 'PASS' if ok else 'FAIL'} | {detail.replace('|', '/')} |")
    failed = [c for c in checks if c[1] is False]
    report.add(f"\n**Overall: {'ALL CHECKS PASSED' if not failed else str(len(failed)) + ' CHECK(S) FAILED'}**" +
               (" (a valid login was not tested)" if any(c[1] is None for c in checks) else ""))
    report.add("Remember: these checks look at structure. Read the replies and the 'model understood' lines yourself.")
    save()
    if report_path:
        echo(f"\nReport saved to {report_path.name}")
    return 1 if failed else 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    settings = get_settings()
    missing = [name for name, value in (
        ("SUPABASE_URL", settings.supabase_url), ("SUPABASE_SECRET_KEY", settings.supabase_secret_key),
        ("SUPABASE_PUBLISHABLE_KEY", settings.supabase_publishable_key), ("OPENAI_API_KEY", settings.openai_api_key),
        ("OPENAI_CHAT_MODEL", settings.openai_chat_model)) if not value]
    if missing:
        print("Cannot run: these values are empty in ai_service\\.env: " + ", ".join(missing))
        return 2
    return run(build_services(settings), read_token(), HERE / "smoke_test_planner_turn_report.md")


if __name__ == "__main__":
    sys.exit(main())
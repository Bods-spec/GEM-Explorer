"""POST /planner/turn: the Smart Visit Planner as a TOOL of the Booking Agent (fake OpenAI and Supabase servers).

The Booking Agent (Node) chooses the conversation id, forwards the visitor's own token and shows the answer to the visitor.
These tests cover the contract and its safety rules; they do not test the Node side (that is Phase B)."""

import json
import logging
import re

import pytest

import fakes
from app.clients import UpstreamError
from app.conversations import ConversationStore
from app.planner import tool_register
from conftest import GUEST_TOKEN, OTHER_TOKEN, USER_TOKEN, auth

CONV = "booking-conv-0001"
TWO_HOURS = "I have two hours and want to see Tutankhamun's treasures and Ramesses II."


def turn(client, message, conversation_id=CONV, token=USER_TOKEN, **extra):
    body = {"message": message, "conversation_id": conversation_id, **extra}
    return client.post("/planner/turn", json=body, headers=auth(token) if token else {})


def ask(client, message, conversation_id=CONV, token=USER_TOKEN, **extra):
    response = turn(client, message, conversation_id, token, **extra)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def client(make_client, ingested):
    return make_client(planner_user_per_minute=500, planner_user_per_day=5000, planner_daily_limit=5000,
                       rag_user_per_minute=500, rag_ip_per_minute=500)


def keys(body):
    return [s["key"] for s in body["plan"]["stops"]]


# ====================== the contract ======================

def test_a_plan_for_the_callers_conversation_id(client, ingested):
    body = ask(client, TWO_HOURS, language="en")
    assert body["status"] == "plan_created" and body["conversation_id"] == CONV and body["plan_presented"] is True
    assert body["time_budget_minutes"] == 120 and "tutankhamun-galleries" in keys(body)
    assert {"reply", "plan", "preferences", "assumptions", "limitations", "handoff", "language", "register"} <= set(body)
    assert len(ingested.chat.calls("extract")) == 1 and ingested.openai.requests == []


def test_the_same_conversation_id_updates_the_same_plan(client):
    first = ask(client, TWO_HOURS)
    second = ask(client, "Make it 90 minutes and remove the Grand Stairs")
    assert second["status"] == "plan_updated" and second["plan_presented"] is True and second["conversation_id"] == CONV
    assert second["time_budget_minutes"] == 90 and "grand-stairs" not in keys(second)
    assert [i["key"] for i in second["preferences"]["interests"]] == [i["key"] for i in first["preferences"]["interests"]]


def test_a_clarification_is_not_a_presented_plan(client):
    body = ask(client, "I want to see the Golden Throne")
    assert body["status"] == "needs_clarification" and body["plan_presented"] is False and body["plan"] is None
    assert ask(client, "2 hours")["plan_presented"] is True


@pytest.mark.parametrize("message", ["hello", "What is the Golden Throne made of?", "I have 20 minutes and I must see the Golden Throne"])
def test_other_statuses_are_not_presented_plans(client, message):
    assert ask(client, message)["plan_presented"] is False


def test_90_minutes_is_time_not_visitors(client):
    ask(client, TWO_HOURS)
    body = ask(client, "make it 90 minutes")
    assert body["time_budget_minutes"] == 90 and body["status"] == "plan_updated"
    def all_keys(node):
        if isinstance(node, dict):
            for k, v in node.items():
                yield k
                yield from all_keys(v)
        elif isinstance(node, list):
            for item in node:
                yield from all_keys(item)
    assert not {"visitors", "ticket_count", "visit_date", "visitor_name"} & set(all_keys(body))


def test_a_planner_answer_never_contains_booking_fields(client):
    body = ask(client, TWO_HOURS)
    names = set(re.findall(r'"([a-z_]+)":', json.dumps(body)))
    assert not {"ticket_count", "visitor_name", "booking_reference", "booking_id", "visit_date", "visitors", "draft"} & names


# ====================== combined requests ======================

def test_a_booking_only_message_is_handed_back_when_the_caller_did_not_take_it(client, ingested):
    body = ask(client, "I want to book 2 tickets for Friday")
    assert body["status"] == "handoff" and body["handoff"]["target"] == "booking_system" and body["plan_presented"] is False
    assert ingested.chat.requests == []


def test_a_combined_message_is_planned_when_the_caller_took_the_booking_part(client, ingested):
    body = ask(client, "Plan a 2-hour visit and book 2 tickets for Friday", booking_handled=True)
    assert body["status"] == "plan_created" and body["time_budget_minutes"] == 120 and body["handoff"] is None
    assert body["unmatched_requests"] == [] and "ticket" not in " ".join(s["name"].lower() for s in body["plan"]["stops"])
    assert len(ingested.chat.calls("extract")) == 1
    prompt = ingested.chat.calls("extract")[0]["json"]["messages"]
    assert "Booking words" in prompt[0]["content"]


def test_booking_handled_does_not_switch_off_any_other_protection(client, ingested):
    assert ask(client, "plan 2 hours at the Louvre Museum in Paris", booking_handled=True)["status"] == "out_of_scope"
    assert ask(client, "hello", booking_handled=True)["status"] == "smalltalk"
    assert ingested.chat.requests == []


def test_the_planner_only_reads_and_never_touches_bookings(client, ingested):
    ingested.supabase.requests.clear()
    ask(client, TWO_HOURS, booking_handled=True)
    ask(client, "book 2 tickets")
    assert {(r["method"], r["path"]) for r in ingested.supabase.requests} <= {
        ("GET", "/auth/v1/user"), ("GET", "/rest/v1/museum_entities"), ("GET", "/rest/v1/museum_sources")}


# ====================== language ======================

def test_arabic_from_the_booking_agent_is_answered_in_egyptian_arabic(client):
    body = ask(client, "أريد زيارة تدوم ساعتين لمشاهدة كنوز توت عنخ آمون")
    assert body["register"] == "eg" and body["language"] == "ar" and "تقديرات فريقنا" in body["reply"]


def test_a_message_without_letters_follows_the_page_language():
    assert tool_register("90", "ar") == "eg" and tool_register("90", "en") == "en" and tool_register("90", None) == "en"
    assert tool_register("two hours", "ar") == "en"            # the message itself wins when it has words
    assert tool_register("ساعتين", "en") == "eg" and tool_register("عايز ساعتين", None) == "eg"


def test_egyptian_arabic_is_kept_in_follow_ups(client):
    assert ask(client, "عايز اشوف الدهب في ساعتين")["register"] == "eg"
    assert ask(client, "خليها 90 دقيقة وشيل الدرج العظيم")["register"] == "eg"


# ====================== authentication and isolation ======================

def test_the_visitors_own_verified_token_is_required(client, ingested):
    assert turn(client, TWO_HOURS, token=None).status_code == 401
    assert turn(client, TWO_HOURS, token="not-a-known-token-0000000000").status_code == 401
    assert ingested.chat.requests == []


def test_guests_follow_the_same_rule_as_the_rest_of_the_api(make_client, ingested):
    assert turn(make_client(allow_guest_users=False), TWO_HOURS, token=GUEST_TOKEN).status_code == 403
    assert turn(make_client(allow_guest_users=True), TWO_HOURS, token=GUEST_TOKEN).status_code == 200


def test_a_user_id_in_the_body_is_never_used(client):
    ask(client, TWO_HOURS, user_id="user-b", userId="user-b")
    store = client.services.planner._store
    assert store.get_or_start("user-a", CONV).state and not store.get_or_start("user-b", CONV).state


def test_two_users_with_the_same_conversation_id_never_see_each_other(client):
    mine = ask(client, TWO_HOURS)
    theirs = ask(client, "I want to see the Golden Throne", token=OTHER_TOKEN)             # same id, other user
    assert theirs["status"] == "needs_clarification" and theirs["plan"] is None            # a fresh conversation: no shared plan
    again = ask(client, "make it 90 minutes")
    assert again["status"] == "plan_updated" and [i["key"] for i in again["preferences"]["interests"]] == [i["key"] for i in mine["preferences"]["interests"]]
    other = ask(client, "2 hours", token=OTHER_TOKEN)
    assert other["status"] == "plan_created" and [m["key"] for m in other["preferences"]["must_see"]] == ["golden-throne"]


def test_the_turn_and_chat_endpoints_do_not_share_conversations(client):
    chat = client.post("/planner/chat", json={"message": TWO_HOURS}, headers=auth()).json()
    other = turn(client, "make it 90 minutes", chat["conversation_id"]).json()
    assert other["status"] == "plan_created" and other["preferences"]["interests"] == []        # a new conversation: nothing carried over


@pytest.mark.parametrize("body", [
    {}, {"message": TWO_HOURS}, {"conversation_id": CONV}, {"message": "", "conversation_id": CONV}, {"message": "  ", "conversation_id": CONV},
    {"message": "x" * 2001, "conversation_id": CONV}, {"message": 5, "conversation_id": CONV},
    {"message": "hi", "conversation_id": "short"}, {"message": "hi", "conversation_id": "x" * 129}, {"message": "hi", "conversation_id": "bad id with spaces"},
    {"message": "hi", "conversation_id": "ok-conversation", "language": "fr"}, {"message": "hi", "conversation_id": "ok-conversation", "booking_handled": "maybe"},
])
def test_invalid_requests_get_a_fixed_error(client, body):
    response = client.post("/planner/turn", json=body, headers=auth())
    assert response.status_code == 422 and response.json() == {"error": "INVALID_REQUEST"}


def test_the_booking_agents_limits_are_accepted(client):
    assert turn(client, "hello " * 300, "a" * 128).status_code == 200            # a 1800-character message and a 128-character id
    assert turn(client, "hello", "a" * 8).status_code == 200


# ====================== availability, limits, logs ======================

def test_off_without_a_chat_model(make_client, ingested):
    assert turn(make_client(openai_chat_model=""), TWO_HOURS).json() == {"error": "PLANNER_NOT_CONFIGURED"}


def test_a_model_failure_is_a_fixed_unavailable_status(client, ingested):
    ingested.chat.script["extract"] = UpstreamError("openai-chat", 500)
    body = ask(client, TWO_HOURS)
    assert body["status"] == "unavailable" and body["plan"] is None and body["plan_presented"] is False


def test_a_database_failure_is_a_fixed_502(make_client, ingested):
    ingested.supabase.tables["museum_entities"].clear()
    ingested.supabase.missing_tables = True
    response = turn(make_client(planner_user_per_minute=100), TWO_HOURS)
    assert response.status_code == 502 and response.json() == {"error": "KNOWLEDGE_UNAVAILABLE"} and "museum_" not in response.text


def test_the_planner_limits_apply_to_the_tool_endpoint_too(make_client, ingested):
    client = make_client(planner_user_per_minute=2)
    assert [turn(client, "hello").status_code for _ in range(3)] == [200, 200, 429]
    assert turn(client, "hello", token=OTHER_TOKEN).status_code == 200


def test_no_token_and_no_visitor_text_is_logged(client, ingested, caplog):
    caplog.set_level(logging.DEBUG)
    ask(client, "SECRETWORD-12345 I have two hours and like gold")
    ask(client, "I want to book 2 tickets")
    ingested.chat.script["extract"] = UpstreamError("openai-chat", 500)
    ask(client, TWO_HOURS)
    turn(client, TWO_HOURS, token="not-a-known-token-0000000000")
    logs = "\n".join(r.getMessage() for r in caplog.records)
    for secret in (*fakes.ALL_SECRETS, USER_TOKEN, "SECRETWORD", "not-a-known-token"):
        assert secret not in logs
    assert "planner status=plan_created" in logs


def test_no_secret_in_any_response(client):
    texts = [turn(client, m).text for m in (TWO_HOURS, "hello", "book tickets")] + [turn(client, TWO_HOURS, token=None).text]
    for secret in (*fakes.ALL_SECRETS, USER_TOKEN):
        assert all(secret not in t for t in texts)


# ====================== the in-memory store ======================

def test_conversations_expire_and_a_restart_forgets_them(client):
    store = client.services.planner._store
    ask(client, TWO_HOURS)
    assert store.get_or_start("user-a", CONV).state
    now = [0.0]
    short = ConversationStore(ttl=100, clock=lambda: now[0])
    first = short.get_or_start("u1", CONV)
    first.state["x"] = 1
    now[0] = 50
    assert short.get_or_start("u1", CONV).state == {"x": 1}
    now[0] = 200
    assert short.get_or_start("u1", CONV).state == {}


def test_the_store_is_bounded_per_user_and_overall():
    store = ConversationStore(max_total=3, max_per_user=2)
    for n in range(4):
        store.get_or_start("u1", f"conversation-{n}")
    assert [store.get_or_start("u1", f"conversation-{n}").state == {} for n in (2, 3)] == [True, True]
    store = ConversationStore(max_total=3, max_per_user=5)
    for n in range(5):
        store.get_or_start(f"user-{n}", "same-conversation-id")
    assert len(store._items) <= 3


def test_one_users_conversations_cannot_evict_anothers_beyond_the_overall_cap():
    store = ConversationStore(max_total=10, max_per_user=2)
    keep = store.get_or_start("good", "conversation-keep")
    keep.state["k"] = 1
    for n in range(20):
        store.get_or_start("noisy", f"conversation-{n}")
    assert store.get_or_start("good", "conversation-keep").state == {"k": 1}
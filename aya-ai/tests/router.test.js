"use strict";

// Unit tests for the Phase B message router (pure functions, no server).

const test = require("node:test");
const assert = require("node:assert/strict");
const router = require("../chatbot/router");
const parser = require("../chatbot/parser");

const route = (m, ctx) => router.classify(m, ctx).route;

test("durations are detected in English", () => {
  for (const m of [
    "90 minutes", "Make it 90 minutes", "I have 2 hours", "two hours", "a 2-hour visit", "3 hrs",
    "an hour", "half an hour", "1 hour 30 minutes", "two and a half hours", "2.5 hours",
    "an hour and a half", "a couple of hours", "45 mins", "2h",
  ]) {
    assert.equal(router.hasDuration(m), true, m);
  }
});

test("durations are detected in Arabic and clock times are not durations", () => {
  for (const m of ["عندي ساعتين", "3 ساعات", "تلات ساعات", "ساعة ونص", "نص ساعة", "ربع ساعة", "90 دقيقة", "٣ ساعات"]) {
    assert.equal(router.hasDuration(m), true, m);
  }
  assert.equal(router.hasDuration("الساعة 3 احجز"), false);
  assert.equal(router.hasDuration("الساعة ٣ العصر"), false);
});

test("things that are not durations stay out", () => {
  for (const m of ["book 2 tickets for Friday", "my name is Hour Han", "3 people", "Friday", "أحمد محمد", "10 visitors"]) {
    assert.equal(router.hasDuration(m), false, m);
  }
});

test("stripDurations removes the duration and keeps everything else", () => {
  assert.equal(router.stripDurations("Plan a 2-hour visit and book 2 tickets for Friday"), "Plan a visit and book 2 tickets for Friday");
  assert.equal(router.stripDurations("Make it 90 minutes"), "Make it");
  assert.equal(router.stripDurations("Aya Hassan, book for 2 hours and a half"), "Aya Hassan, book for");
  assert.equal(router.stripDurations("خطة لمدة 3 ساعات واحجزلي"), "خطة لمدة واحجزلي");
});

test("stripDurations keeps names exactly as written (no Arabic folding)", () => {
  assert.equal(router.stripDurations("فاطمة احجز لمدة ساعتين"), "فاطمة احجز لمدة");
  assert.equal(router.stripDurations("Zoë O'Neil 2 hours"), "Zoë O'Neil");
});

test("the booking parser really would misread a duration, and the stripped text is safe", () => {
  // This documents WHY the router exists.
  const raw = parser.parseMessage("Make it 90 minutes", new Date("2026-11-26T10:00:00Z"));
  assert.notEqual(raw.count.status, "none");
  const clean = parser.parseMessage(router.stripDurations("Make it 90 minutes"), new Date("2026-11-26T10:00:00Z"));
  assert.equal(clean.count.status, "none");
});

test("routing: booking, planning and combined messages", () => {
  assert.equal(route("book 2 tickets for Friday"), "booking");
  assert.equal(route("احجزلي ٢ تذاكر الجمعة"), "booking");
  assert.equal(route("Plan my visit"), "planner");
  assert.equal(route("I have two hours"), "planner");
  assert.equal(route("Make it 90 minutes"), "planner");
  assert.equal(route("عايز خطة للزيارة"), "planner");
  assert.equal(route("Plan a 2-hour visit and book 2 tickets for Friday"), "both");
  assert.equal(route("خطة لمدة ساعتين واحجزلي تذكرتين"), "both");
});

test("'visit' alone is not booking intent, so 'plan my visit' stays a planning request", () => {
  const c = router.classify("Plan my 2 hour visit");
  assert.equal(c.route, "planner");
  assert.equal(c.bookingWords, false);
});

test("confirmations and cancellations always stay with the booking engine", () => {
  for (const m of ["yes", "yes, confirm", "confirm the booking", "أيوه أكد", "cancel", "ألغي الحجز", "start over"]) {
    assert.equal(route(m, { planPresented: true, awaitingPlanner: true }), "booking", m);
  }
});

test("plan edits are routed to the planner only after a plan was shown", () => {
  assert.equal(route("remove the Tutankhamun gallery"), "booking");
  assert.equal(route("remove the Tutankhamun gallery", { planPresented: true }), "planner");
  assert.equal(route("ضيف المومياوات", { planPresented: true }), "planner");
});

test("booking details never go to the planner just because a plan exists", () => {
  assert.equal(route("my name is Aya Hassan", { planPresented: true }), "booking");
  assert.equal(route("add 2 more visitors", { planPresented: true }), "booking");
  assert.equal(route("3", { planPresented: true }), "booking");
});

test("an answer to a planner question goes to the planner, booking details do not", () => {
  assert.equal(route("the mummies and the gold", { awaitingPlanner: true }), "planner");
  assert.equal(route("for 2 people on Friday", { awaitingPlanner: true }), "booking");
});

test("'what should I see' is a planning request, but not 'show my booking summary'", () => {
  assert.equal(route("What should I see?"), "planner");
  assert.equal(route("I want to see my booking summary"), "booking");
});
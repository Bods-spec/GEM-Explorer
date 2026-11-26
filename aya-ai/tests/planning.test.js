"use strict";

// MOCKED integration tests for Phase B: the REAL server.js, the REAL booking
// engine and the REAL planning flow, against an in-memory Supabase fake and a
// FAKE Python planner (helpers/fake-planner.js). Nothing here touches a real
// Supabase project, a real planner or an AI model.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server-harness");
const { startFakePlanner, planBody, statusBody } = require("./helpers/fake-planner");
const { cairoToday, addDays } = require("../backend/chatbot");

let h;
let planner;
test.before(async () => {
  planner = await startFakePlanner({ validTokens: ["test-token-user-a", "test-token-user-b"] });
  h = await startServer({ planner, plannerTimeoutMs: 600 });
});
test.after(async () => { await h.close(); await planner.close(); });

let counter = 0;
const conv = () => `plan-conv-${Date.now()}-${++counter}`;
const say = (token, c, message, extra = {}) => h.chat(token, c, message, { language: "en", ...extra });
const A = (c, m, extra) => say(h.TOKEN_A, c, m, extra);
const draftOf = (c, user = h.USER_A) =>
  h.db.tables.booking_drafts.find((d) => d.conversation_id === c && d.user_id === user);
const calls = () => planner.requests.length;
const lastCall = () => planner.requests[planner.requests.length - 1];
const PLAN_TEXT = "PLAN: Test Gallery (30 min).";
const tomorrow = () => addDays(cairoToday(), 1);

/** Capture console.error during `fn` (the server logs failures there). */
async function withLogs(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(" ")); };
  try { await fn(); } finally { console.error = original; }
  return lines;
}

// ------------------------------------------------------------------ planning only

test("1. a planning-only request calls the planner with the visitor's own token and saves nothing", async () => {
  const c = conv();
  const before = calls();
  planner.queue({ body: planBody(PLAN_TEXT) });
  const r = await A(c, "Plan a 2-hour visit for me");

  assert.equal(r.status, 200);
  assert.equal(r.data.reply, PLAN_TEXT);
  assert.equal(r.data.planner_status, "plan_created");
  assert.ok(r.data.plan.stops.length > 0);
  assert.equal(r.data.draft_saved, false);
  assert.equal(draftOf(c), undefined, "planning alone writes no booking draft");

  assert.equal(calls(), before + 1);
  const call = lastCall();
  assert.equal(call.token, h.TOKEN_A, "the visitor's own bearer token is forwarded");
  assert.equal(call.body.message, "Plan a 2-hour visit for me");
  assert.equal(call.body.conversation_id, c);
  assert.equal(call.body.booking_handled, false);
  assert.equal(call.body.language, "en");
  assert.equal(Object.hasOwn(call.body, "user_id"), false, "no user id is ever sent in the body");
});

test("2. booking-only messages never call the planner", async () => {
  const c = conv();
  const before = calls();
  const r = await A(c, "book 2 tickets for tomorrow");
  assert.equal(r.status, 200);
  assert.equal(r.data.extracted.ticket_count, 2);
  assert.equal(r.data.planner_status, undefined);
  assert.equal(calls(), before);
});

test("3. a visit duration is never read as a visitor count", async () => {
  const c = conv();
  await A(c, "book for tomorrow");
  planner.queue({ body: planBody(PLAN_TEXT) });
  const r = await A(c, "Make it 90 minutes");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.data.reply, /between 1 and 10/);
  assert.equal(r.data.extracted.ticket_count, null);
  assert.equal(draftOf(c).visitors, null);
  assert.equal(lastCall().body.message, "Make it 90 minutes", "the planner gets the original wording");
});

// ------------------------------------------------------------------ combined

test("4. a combined request keeps BOTH intents: the plan first, then the booking continues", async () => {
  const c = conv();
  const before = calls();
  planner.queue({ body: planBody(PLAN_TEXT) });
  const r = await A(c, "Plan a 2-hour visit and book 2 tickets for tomorrow");

  assert.equal(r.status, 200);
  assert.equal(calls(), before + 1);
  assert.equal(lastCall().body.booking_handled, true, "Python is told Node handles the booking half");
  assert.ok(r.data.reply.startsWith(PLAN_TEXT), "the plan comes first");
  assert.match(r.data.reply, /What name should the booking be under/, "then the booking continues");
  assert.equal(r.data.plan.totals.minutes, 30);

  const d = draftOf(c);
  assert.equal(d.visitors, 2, "2 tickets, not 120 minutes");
  assert.equal(d.visit_date, tomorrow());
});

test("5. plan, then booking review with the demo notice, then explicit confirmation", async () => {
  const c = conv();
  planner.queue({ body: planBody(PLAN_TEXT) });
  await A(c, "Plan a 2-hour visit and book 2 tickets for tomorrow");

  const bookingsBefore = h.db.tables.bookings.length;
  let r = await A(c, "Sara Ali");
  assert.match(r.data.reply, /Here are your booking details/);
  assert.match(r.data.reply, /This is a demo booking, not an official museum ticket\./);
  assert.equal(r.data.plan_pending, undefined);
  const revision = r.data.confirmation_revision;
  assert.ok(Number.isSafeInteger(revision));
  assert.equal(h.db.tables.bookings.length, bookingsBefore, "nothing is booked before 'yes'");

  r = await A(c, "yes confirm", { confirmation_revision: revision });
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "confirm");
  assert.equal(r.data.demo, true);
  assert.equal(r.data.booking.demo, true);
  assert.match(r.data.booking.booking_reference, /^GEM-/);
  assert.equal(r.data.booking.ticket_count, 2);
  assert.match(r.data.reply, /demo booking/);
});

test("6. the booking limit stays 1 to 10 in a combined request", async () => {
  const c = conv();
  planner.queue({ body: planBody(PLAN_TEXT) });
  const r = await A(c, "Plan a 2-hour visit and book 11 tickets for tomorrow");
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /between 1 and 10/);
  assert.equal(draftOf(c)?.visitors ?? null, null);
});

test("7. Arabic combined request: ساعتين is a duration and 2 تذاكر is the count", async () => {
  const c = conv();
  planner.queue({ body: planBody("الخطة: قاعة تجريبية.", { language: "ar" }) });
  const r = await say(h.TOKEN_A, c, "خطة لمدة ساعتين واحجزلي 2 تذاكر بكرة", { language: "ar" });
  assert.equal(r.status, 200);
  assert.ok(r.data.reply.startsWith("الخطة: قاعة تجريبية."));
  assert.equal(draftOf(c).visitors, 2);
  assert.equal(lastCall().body.language, "ar");
});

// ------------------------------------------------------------------ the plan-before-booking gate

test("8. the planner asks a question: booking details are kept, the summary is NOT presented, 'yes' confirms nothing", async () => {
  const c = conv();
  planner.queue({ body: statusBody("needs_clarification", "How much time do you have?") });
  let r = await A(c, "Plan a visit and book 2 tickets for tomorrow my name is Sara Ali");

  assert.equal(r.data.reply, "How much time do you have?", "only the planner question");
  assert.equal(r.data.plan_pending, true);
  assert.equal(r.data.confirmation_revision, null, "no booking summary is presented yet");
  const d = draftOf(c);
  assert.deepEqual([d.visitors, d.visit_date, d.visitor_name], [2, tomorrow(), "Sara Ali"], "details saved silently");
  assert.equal(d.presented_revision ?? null, null);

  const bookingsBefore = h.db.tables.bookings.length;
  r = await A(c, "yes confirm", { confirmation_revision: d.revision });
  assert.equal(r.status, 200);
  assert.equal(r.data.action, null);
  assert.equal(r.data.plan_pending, true);
  assert.equal(h.db.tables.bookings.length, bookingsBefore, "no booking without the plan");

  planner.queue({ body: planBody(PLAN_TEXT) });
  r = await A(c, "I have 2 hours");
  assert.ok(r.data.reply.startsWith(PLAN_TEXT));
  assert.match(r.data.reply, /Here are your booking details/);
  assert.ok(Number.isSafeInteger(r.data.confirmation_revision));
  assert.equal(lastCall().body.message, "I have 2 hours");

  r = await A(c, "yes confirm", { confirmation_revision: r.data.confirmation_revision });
  assert.equal(r.data.action, "confirm");
  assert.equal(r.data.demo, true);
});

test("9. while a plan question is open, booking details are still accepted but nothing can be presented", async () => {
  const c = conv();
  planner.queue({ body: statusBody("needs_clarification", "How much time do you have?") });
  await A(c, "Plan a visit please");
  const before = calls();
  let r = await A(c, "book 3 tickets for tomorrow");
  assert.equal(calls(), before, "a booking-only message does not call the planner");
  assert.match(r.data.reply, /Before the booking summary/);
  assert.match(r.data.reply, /How much time do you have\?/);
  assert.equal(r.data.confirmation_revision, null);
  r = await A(c, "Sara Ali");
  assert.equal(r.data.confirmation_revision, null, "still no summary until the plan is done");
  assert.equal(draftOf(c).visitor_name, "Sara Ali");
});

test("10. 'booking only' drops the plan request on purpose", async () => {
  const c = conv();
  planner.queue({ body: statusBody("needs_clarification", "How much time do you have?") });
  await A(c, "Plan a visit and book 2 tickets for tomorrow my name is Sara Ali");
  const before = calls();
  const r = await A(c, "booking only please");
  assert.equal(calls(), before);
  assert.match(r.data.reply, /continue with the booking only/);
  assert.match(r.data.reply, /Here are your booking details/);
  assert.ok(Number.isSafeInteger(r.data.confirmation_revision));
});

// ------------------------------------------------------------------ plan changes

test("11. a plan change after the plan was shown goes to the planner and re-presents the booking", async () => {
  const c = conv();
  planner.queue({ body: planBody(PLAN_TEXT) });
  await A(c, "Plan a 2-hour visit and book 2 tickets for tomorrow");
  let r = await A(c, "Sara Ali");
  const first = r.data.confirmation_revision;

  planner.queue({ body: planBody("PLAN v2 without the gold.", { status: "plan_updated" }) });
  r = await A(c, "remove the gold gallery");
  assert.equal(lastCall().body.message, "remove the gold gallery");
  assert.equal(r.data.planner_status, "plan_updated");
  assert.ok(r.data.reply.startsWith("PLAN v2 without the gold."));
  assert.match(r.data.reply, /Here are your booking details/);
  assert.ok(Number.isSafeInteger(r.data.confirmation_revision), "the booking summary is presented again after the plan");
  assert.equal(r.data.confirmation_revision, first, "same booking details, same revision");
});

test("12. changing a booking detail after the plan does not call the planner", async () => {
  const c = conv();
  planner.queue({ body: planBody(PLAN_TEXT) });
  await A(c, "Plan a 2-hour visit and book 2 tickets for tomorrow");
  await A(c, "Sara Ali");
  const before = calls();
  const r = await A(c, "change the name");
  assert.equal(calls(), before);
  assert.match(r.data.reply, /What name should the booking be under/);
});

// ------------------------------------------------------------------ failures

test("13. planner down (connection destroyed): the visitor is told, booking details are kept, nothing is confirmed", async () => {
  const c = conv();
  planner.queue({ destroy: true });
  let r;
  const logs = await withLogs(async () => {
    r = await A(c, "Plan a 2-hour visit and book 2 tickets for tomorrow my name is Sara Ali");
  });
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /can't prepare your visit plan/);
  assert.match(r.data.reply, /continue with the booking only/);
  assert.equal(r.data.planner_status, "unavailable");
  assert.equal(r.data.confirmation_revision, null);
  assert.equal(draftOf(c).visitors, 2, "the booking half was not lost");

  // "yes" here means "continue without a plan": it must NOT confirm.
  const bookingsBefore = h.db.tables.bookings.length;
  r = await A(c, "yes");
  assert.equal(h.db.tables.bookings.length, bookingsBefore);
  assert.match(r.data.reply, /continue with the booking only/);
  assert.match(r.data.reply, /Here are your booking details/);
  const revision = r.data.confirmation_revision;
  assert.ok(Number.isSafeInteger(revision));

  r = await A(c, "yes confirm", { confirmation_revision: revision });
  assert.equal(r.data.action, "confirm");
  assert.equal(h.db.tables.bookings.length, bookingsBefore + 1);

  const text = logs.join("\n");
  assert.doesNotMatch(text, new RegExp(h.TOKEN_A));
  assert.doesNotMatch(text, /Sara Ali|2-hour/);
});

test("14. planner too slow: same safe answer", async () => {
  const c = conv();
  planner.queue({ delayMs: 1500, body: planBody(PLAN_TEXT) });
  let r;
  await withLogs(async () => { r = await A(c, "Plan a 2-hour visit"); });
  assert.match(r.data.reply, /can't prepare your visit plan/);
  assert.equal(r.data.planner_status, "unavailable");
});

test("15. planner rejects the token (401), returns garbage, or an error: normal bookings keep working", async () => {
  for (const answer of [
    { status: 401, body: { error: "UNAUTHORIZED" } },
    { status: 503, body: { error: "PLANNER_NOT_CONFIGURED" } },
    { status: 429, body: { error: "RATE_LIMITED" } },
    { raw: "not json at all" },
    { body: { status: "something_new", reply: "x" } },
    { body: statusBody("unavailable", "The planner is down.") },
  ]) {
    const c = conv();
    planner.queue(answer);
    let r;
    await withLogs(async () => { r = await A(c, "Plan a 2-hour visit"); });
    assert.equal(r.status, 200, JSON.stringify(answer));
    assert.match(r.data.reply, /can't prepare your visit plan/);
  }
  // After all that, a plain booking is untouched.
  const c = conv();
  const r = await A(c, "book 2 tickets for tomorrow");
  assert.equal(r.data.extracted.ticket_count, 2);
});

test("16. a later planning message after a failure retries the planner", async () => {
  const c = conv();
  planner.queue({ status: 503, body: { error: "PLANNER_NOT_CONFIGURED" } });
  await withLogs(async () => { await A(c, "Plan a 2-hour visit and book 2 tickets for tomorrow my name is Sara Ali"); });
  planner.queue({ body: planBody(PLAN_TEXT) });
  const r = await A(c, "try the plan again, I have 2 hours");
  assert.ok(r.data.reply.startsWith(PLAN_TEXT));
  assert.match(r.data.reply, /Here are your booking details/);
});

test("17. when the planner says it is not a planning message, the booking engine handles it as before", async () => {
  const c = conv();
  planner.queue({ body: statusBody("not_planning", "") });
  const r = await A(c, "when is the schedule for friday? book 2 tickets for tomorrow");
  assert.equal(r.status, 200);
  assert.equal(r.data.extracted.ticket_count, 2);
  assert.equal(r.data.planner_status, "not_planning");
});

// ------------------------------------------------------------------ security and isolation

test("18. no token: 401 and the planner is never called", async () => {
  const before = calls();
  const r = await h.api("POST", "/api/ai/chat", { body: { message: "Plan a visit", conversation_id: conv(), language: "en" } });
  assert.equal(r.status, 401);
  assert.equal(calls(), before);
});

test("19. the flow state is private to the user: another visitor's same conversation id is unaffected", async () => {
  const c = conv();
  planner.queue({ body: statusBody("needs_clarification", "How much time do you have?") });
  await A(c, "Plan a visit please");

  const r = await say(h.TOKEN_B, c, "book 2 tickets for tomorrow for Bob Brown");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.data.reply, /How much time/, "B never sees A's planner question");
  assert.equal(r.data.plan_pending, undefined);
  assert.ok(Number.isSafeInteger(r.data.confirmation_revision), "B's booking is not held by A's plan request");
});

test("20. the planner is never asked for, or given, booking powers", async () => {
  const c = conv();
  planner.queue({ body: planBody(PLAN_TEXT) });
  await A(c, "Plan a 2-hour visit and book 2 tickets for tomorrow my name is Sara Ali");
  for (const call of planner.requests) {
    assert.deepEqual(Object.keys(call.body).sort(), ["booking_handled", "conversation_id", "language", "message"]);
  }
  assert.equal(h.outgoing.length, 0, "the only outgoing calls were to the planner");
});

test("21. a cancel resets the booking and forgets the plan request", async () => {
  const c = conv();
  planner.queue({ body: statusBody("needs_clarification", "How much time do you have?") });
  await A(c, "Plan a visit and book 2 tickets for tomorrow my name is Sara Ali");
  const r = await A(c, "cancel");
  assert.equal(r.data.action, "reset");
  const fresh = conv();
  const r2 = await A(fresh, "book 2 tickets for tomorrow my name is Sara Ali");
  assert.ok(Number.isSafeInteger(r2.data.confirmation_revision));
});

// ------------------------------------------------------------------ confirmed-booking flows are untouched

test("22. cancel / modify talk about a CONFIRMED booking never reaches the planner", async () => {
  const before = calls();
  let r = await A(conv(), "cancel booking GEM-ABCDEF1234");
  assert.equal(r.status, 200);
  assert.equal(r.data.planner_status, undefined);
  r = await A(conv(), "change booking GEM-ABCDEF1234 to 2 hours");
  assert.equal(r.status, 200);
  assert.equal(r.data.planner_status, undefined);
  assert.equal(calls(), before, "no planner request was made for either message");
});

test("23. a real confirmed booking can still be cancelled with the planner enabled", async () => {
  const c = conv();
  planner.queue({ body: planBody(PLAN_TEXT) });
  await A(c, "Plan a 2-hour visit and book 2 tickets for tomorrow");
  let r = await A(c, "my name is Sara Ali");
  r = await A(c, "yes confirm", { confirmation_revision: r.data.confirmation_revision });
  const reference = r.data.booking.booking_reference;
  assert.equal(r.data.demo, true);

  const before = calls();
  const c2 = conv();
  r = await A(c2, `cancel booking ${reference}`);
  assert.match(r.data.reply, new RegExp(reference));
  r = await A(c2, "yes");
  assert.equal(r.data.action, "cancel_booking");
  assert.equal(calls(), before, "the cancellation flow made no planner request");
});
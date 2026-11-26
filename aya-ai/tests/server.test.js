"use strict";

// MOCKED integration tests: the REAL server.js, the REAL chatbot engine,
// the REAL booking-drafts.js and confirm-booking.js, running against an
// in-memory Supabase fake (see helpers/fake-supabase.js).
// Nothing here touches a real Supabase project or n8n.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer } = require("./helpers/server-harness");
const { cairoToday, addDays } = require("../backend/chatbot");

let h;
test.before(async () => { h = await startServer(); });
test.after(async () => { await h.close(); });

let counter = 0;
const newConversation = () => `conv-test-${Date.now()}-${++counter}`;

/** Drive a conversation to the REVIEW state; returns the final chat data. */
async function reachReview(token, conv, { lang = "ar", count = 3, name } = {}) {
  const person = name || (lang === "ar" ? "أحمد محمد" : "Sara Ali");
  const msgs = lang === "ar"
    ? ["عايز أحجز زيارة للمتحف", "بكرة", String(count), person]
    : ["hello", "tomorrow", String(count), person];
  let last;
  for (const m of msgs) {
    last = await h.chat(token, conv, m, { language: lang });
    assert.equal(last.status, 200, m);
  }
  return last.data;
}

const draftOf = (conv, user = h.USER_A) =>
  h.db.tables.booking_drafts.find((d) => d.conversation_id === conv && d.user_id === user);
const confirmPhrase = (lang) => (lang === "ar" ? "أيوه أكد" : "yes confirm");

const tomorrow = () => addDays(cairoToday(), 1);

// ---------------------------------------------------------------------

test("1. Arabic booking conversation, end to end, with a real booking reference", async () => {
  const conv = newConversation();
  const t = (m, extra) => h.chat(h.TOKEN_A, conv, m, extra);

  let r = await t("عايز أحجز زيارة للمتحف.");
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /تحب تزور المتحف إمتى/);
  assert.equal(r.data.draft_saved, false);
  assert.equal(draftOf(conv), undefined, "nothing is stored before the visitor gives a detail");

  r = await t("بكرة");
  assert.equal(r.data.draft_saved, true);
  assert.equal(r.data.extracted.visit_date, tomorrow());
  assert.equal(r.data.confirmation_revision, null, "a partial draft can never be confirmed");
  assert.equal(draftOf(conv).visitors, null);
  assert.match(r.data.reply, /كام شخص/);

  r = await t("3");
  assert.equal(r.data.extracted.ticket_count, 3);
  assert.equal(r.data.confirmation_revision, null);
  assert.match(r.data.reply, /باسم مين/);

  r = await t("أحمد محمد");
  assert.equal(r.data.draft_saved, true);
  assert.equal(r.data.extracted.visitor_name, "أحمد محمد");
  assert.match(r.data.reply, /تمام يا أحمد/);
  const revision = r.data.confirmation_revision;
  assert.equal(revision, draftOf(conv).revision);
  assert.equal(draftOf(conv).presented_revision, revision);

  r = await t("أيوه أكد.", { confirmation_revision: revision });
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "confirm");
  assert.match(r.data.booking.booking_reference, /^GEM-[0-9A-F]{10}$/);
  assert.equal(r.data.booking.visitor_name, "أحمد محمد");
  assert.equal(r.data.booking.ticket_count, 3);
  assert.match(r.data.reply, new RegExp(r.data.booking.booking_reference));
  assert.equal(draftOf(conv).status, "completed");
  assert.equal(h.db.tables.bookings.filter((b) => b.draft_id === draftOf(conv).id).length, 1);
});

test("2. English booking conversation", async () => {
  const conv = newConversation();
  const data = await reachReview(h.TOKEN_A, conv, { lang: "en", count: 1 });
  assert.equal(data.language, "en");
  assert.match(data.reply, /Thanks, Sara!/);
  const r = await h.chat(h.TOKEN_A, conv, "yes confirm", { language: "en", confirmation_revision: data.confirmation_revision });
  assert.equal(r.status, 200);
  assert.equal(r.data.language, "en");
  assert.match(r.data.reply, /Booking reference: GEM-/);
});

test("3. changing details bumps the revision and the new revision must be used (outdated revision)", async () => {
  const conv = newConversation();
  const first = await reachReview(h.TOKEN_A, conv);
  const oldRevision = first.confirmation_revision;

  const changed = await h.chat(h.TOKEN_A, conv, "غير العدد ل 5");
  assert.equal(changed.data.extracted.ticket_count, 5);
  assert.ok(changed.data.confirmation_revision > oldRevision);

  let r = await h.chat(h.TOKEN_A, conv, "أيوه أكد", { confirmation_revision: oldRevision });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "BOOKING_REVISION_NOT_PRESENTED");
  assert.equal(h.db.tables.bookings.filter((b) => b.draft_id === draftOf(conv).id).length, 0);

  r = await h.chat(h.TOKEN_A, conv, "أيوه أكد", { confirmation_revision: changed.data.confirmation_revision });
  assert.equal(r.status, 200);
  assert.equal(r.data.booking.ticket_count, 5);
});

test("4. an unrelated message mid-review does not break confirmation", async () => {
  const conv = newConversation();
  const review = await reachReview(h.TOKEN_A, conv);
  const again = await h.chat(h.TOKEN_A, conv, "؟؟");
  assert.equal(again.status, 200);
  assert.equal(again.data.confirmation_revision, review.confirmation_revision, "same details keep the same revision");
  assert.equal(draftOf(conv).presented_revision, review.confirmation_revision, "it is presented again");
  const r = await h.chat(h.TOKEN_A, conv, "أيوه أكد", { confirmation_revision: review.confirmation_revision });
  assert.equal(r.status, 200);
});

test("5. confirming an incomplete booking creates nothing", async () => {
  const conv = newConversation();
  await h.chat(h.TOKEN_A, conv, "بكرة");
  await h.chat(h.TOKEN_A, conv, "2");
  const before = h.db.tables.bookings.length;
  const r = await h.chat(h.TOKEN_A, conv, "أيوه أكد", { confirmation_revision: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.action, null);
  assert.match(r.data.reply, /لسه محتاج/);
  assert.equal(h.db.tables.bookings.length, before);
});

test("6. missing revision, or an explicit 'yes' that was never presented, is refused", async () => {
  const conv = newConversation();
  const review = await reachReview(h.TOKEN_A, conv);
  let r = await h.chat(h.TOKEN_A, conv, "أيوه أكد");
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "CONFIRMATION_REVISION_REQUIRED");

  // The visitor edits (presentation is revoked), then the page sends the old revision.
  h.db.tables.booking_drafts.find((d) => d.conversation_id === conv).presented_revision = null;
  r = await h.chat(h.TOKEN_A, conv, "أيوه أكد", { confirmation_revision: review.confirmation_revision });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "BOOKING_REVISION_NOT_PRESENTED");
  assert.equal(h.db.tables.bookings.filter((b) => b.draft_id === draftOf(conv).id).length, 0);
});

test("7. duplicate confirmation (sequential) returns the SAME booking", async () => {
  const conv = newConversation();
  const review = await reachReview(h.TOKEN_A, conv);
  const body = { confirmation_revision: review.confirmation_revision };
  const a = await h.chat(h.TOKEN_A, conv, "أيوه أكد", body);
  const b = await h.chat(h.TOKEN_A, conv, "أيوه أكد", body);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.data.booking.booking_reference, b.data.booking.booking_reference);
  assert.equal(a.data.booking.replayed, false);
  assert.equal(b.data.booking.replayed, true);
  assert.equal(h.db.tables.bookings.filter((x) => x.draft_id === draftOf(conv).id).length, 1);
});

test("8. duplicate confirmation (8 simultaneous requests) creates exactly one booking", async () => {
  const conv = newConversation();
  const review = await reachReview(h.TOKEN_A, conv, { lang: "en" });
  const body = { language: "en", confirmation_revision: review.confirmation_revision };
  const results = await Promise.all(Array.from({ length: 8 }, () => h.chat(h.TOKEN_A, conv, "yes confirm", body)));
  for (const r of results) assert.equal(r.status, 200);
  const refs = new Set(results.map((r) => r.data.booking.booking_reference));
  assert.equal(refs.size, 1);
  assert.equal(h.db.tables.bookings.filter((x) => x.draft_id === draftOf(conv).id).length, 1);
});

test("9. a message after confirmation asks for a new conversation", async () => {
  const conv = newConversation();
  const review = await reachReview(h.TOKEN_A, conv);
  await h.chat(h.TOKEN_A, conv, "أيوه أكد", { confirmation_revision: review.confirmation_revision });
  const r = await h.chat(h.TOKEN_A, conv, "عايز احجز تاني");
  assert.equal(r.status, 200);
  assert.equal(r.data.new_conversation_required, true);
  assert.equal(r.data.draft_saved, false);
  assert.match(r.data.reply, /اتأكد/);
});

test("10. cancellation before confirmation", async () => {
  const conv = newConversation();
  await reachReview(h.TOKEN_A, conv);
  const r = await h.chat(h.TOKEN_A, conv, "الغي الحجز");
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "reset");
  assert.equal(r.data.new_conversation_required, true);
  assert.deepEqual(r.data.extracted, { visit_date: null, ticket_count: null, visitor_name: null });
  assert.equal(draftOf(conv).status, "cancelled");
  assert.equal(h.db.tables.bookings.filter((b) => b.draft_id === draftOf(conv).id).length, 0);
  // the cancelled draft can no longer be confirmed
  const after = await h.chat(h.TOKEN_A, conv, "أيوه أكد", { confirmation_revision: 1 });
  assert.notEqual(after.data?.action, "confirm");
  assert.equal(h.db.tables.bookings.filter((b) => b.draft_id === draftOf(conv).id).length, 0);
});

test("10b. cancelling when nothing exists is a polite no-op", async () => {
  const r = await h.chat(h.TOKEN_A, newConversation(), "cancel the booking", { language: "en" });
  assert.equal(r.status, 200);
  assert.equal(r.data.action, null);
  assert.match(r.data.reply, /reference of the booking you want to cancel/);
});

test("11. starting a new conversation is independent of the old one", async () => {
  const a = newConversation();
  const b = newConversation();
  await reachReview(h.TOKEN_A, a);
  const r = await h.chat(h.TOKEN_A, b, "بكرة");
  assert.equal(r.data.extracted.ticket_count, null);
  assert.equal(r.data.extracted.visitor_name, null);
  assert.notEqual(draftOf(a).id, draftOf(b).id);
});

test("12. unauthorized requests are rejected", async () => {
  const conv = newConversation();
  let r = await h.api("POST", "/api/ai/chat", { body: { message: "hi", conversation_id: conv } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "UNAUTHORIZED");
  r = await h.chat("not-a-real-token", conv, "hi");
  assert.equal(r.status, 401);
  r = await h.api("GET", "/api/bookings");
  assert.equal(r.status, 401);
  r = await h.api("GET", "/api/bookings", { token: "bad" });
  assert.equal(r.status, 401);
  r = await h.api("POST", "/api/ai/chat", { headers: { Authorization: "Basic abc" }, body: { message: "hi", conversation_id: conv } });
  assert.equal(r.status, 401);
  assert.equal(draftOf(conv), undefined);
});

test("12b. a foreign browser origin is refused", async () => {
  const r = await h.api("GET", "/api/health", { headers: { Origin: "http://evil.example" } });
  assert.equal(r.status, 403);
  const ok = await h.api("GET", "/api/health", { headers: { Origin: h.ORIGIN } });
  assert.equal(ok.status, 200);
});

test("13. cross-user isolation: the same conversation id gives each user a separate draft", async () => {
  const conv = newConversation();
  const reviewA = await reachReview(h.TOKEN_A, conv, { count: 3, name: "Alice Smith", lang: "en" });
  // user B uses the SAME conversation id
  const rB = await h.chat(h.TOKEN_B, conv, "بكرة");
  assert.equal(rB.data.extracted.visitor_name, null, "B must not inherit A's name");
  assert.equal(rB.data.extracted.ticket_count, null);
  assert.equal(h.db.tables.booking_drafts.filter((d) => d.conversation_id === conv).length, 2);

  // B cannot confirm A's booking, even with A's revision number
  const attack = await h.chat(h.TOKEN_B, conv, "أيوه أكد", { confirmation_revision: reviewA.confirmation_revision });
  assert.notEqual(attack.data?.action, "confirm");
  assert.equal(h.db.tables.bookings.filter((b) => b.user_id === h.USER_B).length, 0);

  // B cannot cancel A's booking either
  await h.chat(h.TOKEN_B, conv, "cancel", { language: "en" });
  assert.equal(draftOf(conv, h.USER_A).status, "awaiting_confirmation");
});

test("14. booking history: own bookings only, newest first, correct fields", async () => {
  const userBConv = newConversation();
  const reviewB = await reachReview(h.TOKEN_B, userBConv, { name: "Bob Jones", lang: "en" });
  await h.chat(h.TOKEN_B, userBConv, "yes confirm", { language: "en", confirmation_revision: reviewB.confirmation_revision });

  const a = await h.api("GET", "/api/bookings", { token: h.TOKEN_A });
  const b = await h.api("GET", "/api/bookings", { token: h.TOKEN_B });
  assert.equal(a.status, 200);
  assert.ok(a.data.bookings.length >= 1);
  assert.ok(a.data.bookings.every((x) => h.db.tables.bookings.find((r) => r.id === x.id).user_id === h.USER_A));
  assert.ok(b.data.bookings.every((x) => h.db.tables.bookings.find((r) => r.id === x.id).user_id === h.USER_B));
  assert.equal(b.data.bookings[0].visitor_name, "Bob Jones");
  assert.match(b.data.bookings[0].booking_reference, /^GEM-/);
  assert.equal(b.data.bookings[0].status, "confirmed");
  assert.equal(typeof b.data.bookings[0].ticket_count, "number");
  const times = a.data.bookings.map((x) => x.created_at);
  assert.deepEqual([...times].sort().reverse(), times, "newest first");
  assert.equal(Object.hasOwn(a.data.bookings[0], "user_id"), false, "user_id is never returned");
});

test("15. backend errors are reported safely", async () => {
  const conv = newConversation();

  h.db.failNext = { table: "booking_drafts", op: "select" };
  let r = await h.chat(h.TOKEN_A, conv, "بكرة");
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "BOOKING_DRAFT_LOOKUP_FAILED");

  h.db.failNext = { table: "booking_drafts", op: "upsert" };
  r = await h.chat(h.TOKEN_A, conv, "بكرة");
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "BOOKING_DRAFT_SAVE_FAILED");

  await h.chat(h.TOKEN_A, conv, "بكرة");
  h.db.failNext = { table: "booking_drafts", op: "update" };
  r = await h.chat(h.TOKEN_A, conv, "3");
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "BOOKING_PRESENTATION_RESET_FAILED");

  h.db.failNext = { table: "bookings", op: "select" };
  r = await h.api("GET", "/api/bookings", { token: h.TOKEN_A });
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "Could not retrieve bookings");

  // After a failure the server keeps working.
  r = await h.chat(h.TOKEN_A, conv, "3");
  assert.equal(r.status, 200);
});

test("15b. malformed requests", async () => {
  const conv = newConversation();
  let r = await h.api("POST", "/api/ai/chat", { token: h.TOKEN_A, raw: "{not json" });
  assert.equal(r.status, 400);
  r = await h.api("POST", "/api/ai/chat", { token: h.TOKEN_A, body: { conversation_id: conv } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "INVALID_CHAT_REQUEST");
  r = await h.api("POST", "/api/ai/chat", { token: h.TOKEN_A, body: { message: "hi", conversation_id: "x" } });
  assert.equal(r.status, 400);
  r = await h.api("POST", "/api/ai/chat", { token: h.TOKEN_A, body: { message: "a".repeat(2001), conversation_id: conv } });
  assert.equal(r.status, 400);
  r = await h.api("POST", "/api/ai/chat", { token: h.TOKEN_A, headers: { "Content-Type": "text/plain" }, raw: "hi" });
  assert.equal(r.status, 415);
  r = await h.api("POST", "/api/ai/chat", { token: h.TOKEN_A, raw: JSON.stringify({ message: "x".repeat(20000), conversation_id: conv }) });
  assert.equal(r.status, 413);
  r = await h.api("GET", "/api/nope", { token: h.TOKEN_A });
  assert.equal(r.status, 404);
});

test("16. the conversation survives a server restart / page reload (state is in the database)", async () => {
  const conv = newConversation();
  await h.chat(h.TOKEN_A, conv, "بكرة");
  await h.chat(h.TOKEN_A, conv, "4");
  // "Reload": a brand-new request that carries only the conversation id.
  const r = await h.chat(h.TOKEN_A, conv, "أحمد محمد");
  assert.equal(r.data.extracted.ticket_count, 4);
  assert.equal(r.data.extracted.visit_date, tomorrow());
  assert.ok(r.data.confirmation_revision);
});

test("16b. an expired unconfirmed draft starts over instead of resurrecting old details", async () => {
  const conv = newConversation();
  await reachReview(h.TOKEN_A, conv);
  draftOf(conv).expires_at = new Date(Date.now() - 1000).toISOString();
  const r = await h.chat(h.TOKEN_A, conv, "بعد بكرة");
  assert.equal(r.status, 200);
  assert.equal(r.data.extracted.visit_date, addDays(cairoToday(), 2));
  assert.equal(r.data.extracted.ticket_count, null);
  assert.equal(r.data.extracted.visitor_name, null);
  assert.equal(r.data.confirmation_revision, null);
  assert.ok(new Date(draftOf(conv).expires_at) > new Date(), "expiry is renewed");
});

test("17. modifying a field after review clears it and cannot be confirmed until re-entered", async () => {
  const conv = newConversation();
  const review = await reachReview(h.TOKEN_A, conv);
  const cleared = await h.chat(h.TOKEN_A, conv, "غير الاسم");
  assert.equal(cleared.data.extracted.visitor_name, null);
  assert.equal(cleared.data.confirmation_revision, null);
  assert.ok(draftOf(conv).revision > review.confirmation_revision);

  const early = await h.chat(h.TOKEN_A, conv, "أيوه أكد", { confirmation_revision: review.confirmation_revision });
  assert.notEqual(early.data?.action, "confirm");
  assert.equal(h.db.tables.bookings.filter((b) => b.draft_id === draftOf(conv).id).length, 0);

  const done = await h.chat(h.TOKEN_A, conv, "كريم حسن");
  assert.equal(done.data.extracted.visitor_name, "كريم حسن");
  assert.ok(done.data.confirmation_revision > review.confirmation_revision);
});

test("18. the invalid-details guard: nothing invalid can reach the database", async () => {
  const conv = newConversation();
  await h.chat(h.TOKEN_A, conv, "بكرة");
  for (const bad of ["0", "11", "-3", "3.5"]) {
    const r = await h.chat(h.TOKEN_A, conv, bad);
    assert.equal(r.status, 200, bad);
    assert.equal(r.data.extracted.ticket_count, null, bad);
  }
  for (const d of h.db.tables.booking_drafts) {
    assert.ok(d.visitors === null || (d.visitors >= 1 && d.visitors <= 10));
    assert.ok(d.visit_date === null || d.visit_date >= cairoToday());
  }
});

test("19. no booking reference is ever invented by the chat layer", async () => {
  const conv = newConversation();
  const messages = ["hi", "tomorrow", "2", "Mona Ali", "yes", "banana", "change the date"];
  for (const m of messages) {
    const r = await h.chat(h.TOKEN_A, conv, m, { language: "en", confirmation_revision: 1 });
    if (r.status === 200) assert.doesNotMatch(r.data.reply, /GEM-/, m);
  }
});

test("20. the chatbot runs without n8n: no n8n settings, no outgoing requests, no n8n code", async () => {
  assert.equal(process.env.N8N_WEBHOOK_URL, undefined);
  assert.equal(process.env.N8N_WEBHOOK_SECRET, undefined);
  assert.deepEqual(h.outgoing, [], "server.js made no fetch() call at all");
  const source = fs.readFileSync(path.join(__dirname, "..", "backend", "server.js"), "utf8");
  assert.doesNotMatch(source, /N8N_|require\(["']openai|api\.openai/i, "no n8n settings or OpenAI client in server.js");
  assert.doesNotMatch(source, /fetch\(/, "server.js itself never calls fetch (only planner-client.js does, and only when enabled)");
  const bot = fs.readFileSync(path.join(__dirname, "..", "backend", "chatbot.js"), "utf8");
  assert.doesNotMatch(bot, /fetch\(|require\(["'](?:node:)?(?:http|https|net)["']\)|require\(["']openai|N8N_/i, "chatbot.js");
});

// ---------------------------------------------------------------------
// TEMPORARY GUEST MODE (Supabase anonymous users)
// ---------------------------------------------------------------------

test("21. guest (anonymous) users are refused unless ALLOW_GUEST_USERS=true", async () => {
  const guestId = "33333333-3333-4333-8333-333333333333";
  h.db.guestTokens.set("guest-token-1", guestId);
  delete process.env.ALLOW_GUEST_USERS;

  let r = await h.chat("guest-token-1", newConversation(), "hi");
  assert.equal(r.status, 401);
  r = await h.api("GET", "/api/bookings", { token: "guest-token-1" });
  assert.equal(r.status, 401);

  // a signed-in (non-anonymous) user is unaffected by the setting
  assert.equal((await h.chat(h.TOKEN_A, newConversation(), "hi")).status, 200);

  process.env.ALLOW_GUEST_USERS = "false";
  assert.equal((await h.chat("guest-token-1", newConversation(), "hi")).status, 401);
  delete process.env.ALLOW_GUEST_USERS;
});

test("22. with ALLOW_GUEST_USERS=true a guest can book, and sees only their own bookings", async () => {
  const guestId = "44444444-4444-4444-8444-444444444444";
  const other = "55555555-5555-4555-8555-555555555555";
  h.db.guestTokens.set("guest-token-2", guestId);
  h.db.guestTokens.set("guest-token-3", other);
  process.env.ALLOW_GUEST_USERS = "true";
  try {
    const conv = newConversation();
    const review = await reachReview("guest-token-2", conv, { lang: "en", name: "Guest Visitor" });
    const r = await h.chat("guest-token-2", conv, "yes confirm", { language: "en", confirmation_revision: review.confirmation_revision });
    assert.equal(r.status, 200);
    assert.match(r.data.booking.booking_reference, /^GEM-/);
    assert.equal(h.db.tables.bookings.find((b) => b.id === r.data.booking.id).user_id, guestId);

    const mine = await h.api("GET", "/api/bookings", { token: "guest-token-2" });
    const theirs = await h.api("GET", "/api/bookings", { token: "guest-token-3" });
    assert.equal(mine.data.bookings.length, 1);
    assert.equal(theirs.data.bookings.length, 0, "another guest sees nothing");
    // an invalid token is still rejected even with guests allowed
    assert.equal((await h.chat("guest-token-bogus", newConversation(), "hi")).status, 401);
  } finally {
    delete process.env.ALLOW_GUEST_USERS;
  }
});
// ---------------------------------------------------------------------
// Phase B: the planner feature flag is OFF by default

test("P1. with the planner flag off, a planning message is handled exactly as before and nothing is fetched", async () => {
  const conv1 = newConversation();
  const r = await h.chat(h.TOKEN_A, conv1, "Plan a 2 hour visit", { language: "en" });
  assert.equal(r.status, 200);
  assert.equal(r.data.planner_status, undefined);
  assert.equal(r.data.plan, undefined);
  assert.equal(r.data.plan_pending, undefined);
  assert.equal(h.outgoing.length, 0, "no outgoing request: the planner is not called when disabled");
});

test("P2. the booking review carries the demo notice (English and Egyptian Arabic)", async () => {
  const en = await reachReview(h.TOKEN_A, newConversation(), { lang: "en" });
  assert.match(en.reply, /This is a demo booking, not an official museum ticket\./);
  assert.match(en.reply, /Would you like to confirm the booking/);
  const ar = await reachReview(h.TOKEN_A, newConversation(), { lang: "ar" });
  assert.match(ar.reply, /ده حجز تجريبي مش تذكرة رسمية للمتحف\./);
});

test("P3. a confirmed booking is marked demo: true, additively (all existing fields stay)", async () => {
  const conv2 = newConversation();
  const data = await reachReview(h.TOKEN_A, conv2, { lang: "en" });
  const r = await h.chat(h.TOKEN_A, conv2, "yes confirm", { language: "en", confirmation_revision: data.confirmation_revision });
  assert.equal(r.status, 200);
  assert.equal(r.data.demo, true);
  assert.equal(r.data.booking.demo, true);
  for (const field of ["id", "booking_reference", "visitor_name", "visit_date", "ticket_count"]) {
    assert.ok(field in r.data.booking || field === "id", `booking.${field} is still returned`);
  }
  assert.equal(r.data.action, "confirm");
  assert.equal(r.data.draft_saved, false);
  assert.equal(r.data.extracted.ticket_count, r.data.booking.ticket_count);
});
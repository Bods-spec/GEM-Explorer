"use strict";

// MOCKED integration tests for cancelling a CONFIRMED booking through Egyxos.
// The REAL backend/server.js and backend/chatbot.js run against the in-memory
// Supabase fake (helpers/fake-supabase.js), which includes a port of the
// SQL function cancel_egyxos_booking. Nothing here touches real Supabase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server-harness");
const { cairoToday, addDays } = require("../backend/chatbot");

let h;
test.before(async () => { h = await startServer(); });
test.after(async () => { await h.close(); });

let counter = 0;
const newConversation = () => `conv-cancel-${Date.now()}-${++counter}`;

/** Make a real CONFIRMED booking through the chat (the same path the page uses). */
async function makeBooking(token, { lang = "en", name } = {}) {
  const conv = newConversation();
  const person = name || (lang === "ar" ? "أحمد محمد" : "Sara Ali");
  const msgs = lang === "ar" ? ["عايز أحجز زيارة", "بكرة", "3", person] : ["hello", "tomorrow", "3", person];
  let last;
  for (const m of msgs) last = await h.chat(token, conv, m, { language: lang });
  const done = await h.chat(token, conv, lang === "ar" ? "أيوه أكد" : "yes confirm", {
    language: lang,
    confirmation_revision: last.data.confirmation_revision,
  });
  assert.equal(done.status, 200);
  assert.equal(done.data.action, "confirm");
  return { reference: done.data.booking.booking_reference, id: done.data.booking.id, conv };
}

const row = (id) => h.db.tables.bookings.find((b) => b.id === id);
const pendingRows = (user, conv) => h.db.tables.booking_cancellation_requests.filter((r) => r.user_id === user && r.status === "pending" && (!conv || r.conversation_id === conv));
const ask = (token, conv, text, extra = {}) => h.chat(token, conv, text, { language: /[a-z]/i.test(text) ? "en" : "ar", ...extra });

// The only actions a visitor's browser may ever receive.
const publicAction = (r) => assert.ok([null, "confirm", "reset", "cancel_booking"].includes(r.data.action), `leaked action ${r.data.action}`);

// ---------------------------------------------------------------------

test("1. valid cancellation in Arabic: nothing changes until the explicit yes", async () => {
  const b = await makeBooking(h.TOKEN_A, { lang: "ar" });
  const conv = newConversation(); // a fresh visit to the page

  let r = await ask(h.TOKEN_A, conv, `عايز ألغي حجز رقم ${b.reference}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.action, null);
  assert.match(r.data.reply, /لقيت الحجز بتاعك/);
  assert.match(r.data.reply, new RegExp(b.reference));
  assert.equal(row(b.id).status, "confirmed", "asking is not cancelling");
  assert.equal(pendingRows(h.USER_A, conv).length, 1);
  publicAction(r);

  r = await ask(h.TOKEN_A, conv, "أيوه، ألغي الحجز.");
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "cancel_booking");
  assert.match(r.data.reply, /تم إلغاء الحجز بنجاح/);
  assert.equal(r.data.booking.status, "cancelled");
  assert.equal(r.data.booking.booking_reference, b.reference);
  assert.equal(row(b.id).status, "cancelled");
  assert.ok(h.db.tables.bookings.some((x) => x.id === b.id), "the record is kept, never deleted");
  assert.equal(pendingRows(h.USER_A, conv).length, 0);

  // My Bookings shows it as cancelled
  const list = await h.api("GET", "/api/bookings", { token: h.TOKEN_A });
  const shown = list.data.bookings.find((x) => x.id === b.id);
  assert.equal(shown.status, "cancelled");
});

test("2. valid cancellation in English", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  let r = await ask(h.TOKEN_A, conv, `Cancel booking ${b.reference}`);
  assert.match(r.data.reply, /I found your booking/);
  assert.equal(row(b.id).status, "confirmed");
  r = await ask(h.TOKEN_A, conv, "Yes, cancel it.");
  assert.equal(r.data.action, "cancel_booking");
  assert.match(r.data.reply, /Your booking has been cancelled successfully/);
  assert.equal(row(b.id).status, "cancelled");
  assert.ok(row(b.id).updated_at);
});

test("3. a lower-case reference works too", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  const r = await ask(h.TOKEN_A, conv, `cancel booking ${b.reference.toLowerCase()}`);
  assert.match(r.data.reply, /I found your booking/);
});

test("4. invalid reference: explained, nothing stored, nothing changed", async () => {
  const conv = newConversation();
  const before = JSON.stringify(h.db.tables.bookings);
  let r = await ask(h.TOKEN_A, conv, "الغي حجز رقم GEM-123");
  assert.match(r.data.reply, /رقم الحجز مش مكتوب صح/);
  r = await ask(h.TOKEN_A, conv, "cancel booking GEM-12345", {});
  assert.match(r.data.reply, /doesn't look right/);
  assert.equal(pendingRows(h.USER_A, conv).length, 0);
  assert.equal(JSON.stringify(h.db.tables.bookings), before);
});

test("5. an unknown reference and another user's reference get the SAME answer and leak nothing", async () => {
  const mine = await makeBooking(h.TOKEN_A, { name: "Private Person" });
  const convB = newConversation();

  const other = await ask(h.TOKEN_B, convB, `cancel booking ${mine.reference}`);
  const unknown = await ask(h.TOKEN_B, newConversation(), "cancel booking GEM-0000000000");
  assert.equal(other.status, 200);
  assert.equal(other.data.reply, unknown.data.reply, "identical reply, so a reference cannot be probed");
  assert.match(other.data.reply, /couldn't find a booking/);
  assert.doesNotMatch(JSON.stringify(other.json), /Private Person/);
  assert.equal(pendingRows(h.USER_B, convB).length, 0);

  // even a following "yes" cannot cancel it
  const yes = await ask(h.TOKEN_B, convB, "Yes, cancel it.");
  assert.notEqual(yes.data.action, "cancel_booking");
  assert.equal(row(mine.id).status, "confirmed");
});

test("6. an already cancelled booking is reported, with no new question and no state change", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  await ask(h.TOKEN_A, conv, "yes");
  assert.equal(row(b.id).status, "cancelled");
  const stamp = row(b.id).updated_at;

  const conv2 = newConversation();
  const again = await ask(h.TOKEN_A, conv2, `cancel booking ${b.reference}`);
  assert.match(again.data.reply, /already been cancelled/);
  assert.equal(again.data.action, null);
  assert.equal(pendingRows(h.USER_A, conv2).length, 0);
  assert.equal(row(b.id).updated_at, stamp);
});

test("7. the visitor declines: the booking stays and a later 'yes' does nothing", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  const no = await ask(h.TOKEN_A, conv, "no");
  assert.match(no.data.reply, /Nothing was changed/);
  assert.equal(row(b.id).status, "confirmed");
  assert.equal(pendingRows(h.USER_A, conv).length, 0, "the question is closed");
  const late = await ask(h.TOKEN_A, conv, "yes");
  assert.notEqual(late.data.action, "cancel_booking");
  assert.equal(row(b.id).status, "confirmed");
});

test("8. the visitor changes their mind (Arabic and English)", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `الغي حجز ${b.reference}`);
  let r = await ask(h.TOKEN_A, conv, "غيرت رأيي");
  assert.match(r.data.reply, /مفيش حاجة اتغيرت/);
  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  r = await ask(h.TOKEN_A, conv, "I changed my mind");
  assert.match(r.data.reply, /Nothing was changed/);
  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  r = await ask(h.TOKEN_A, conv, "no, don't cancel it");
  assert.equal(row(b.id).status, "confirmed");
});

test("9. a reference alone, or an unrelated message in between, never cancels", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, b.reference); // just the reference
  assert.equal(row(b.id).status, "confirmed");
  assert.equal(pendingRows(h.USER_A, conv).length, 0);

  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  await ask(h.TOKEN_A, conv, "what time does the museum open?"); // unrelated: closes the question
  assert.equal(pendingRows(h.USER_A, conv).length, 0);
  const yes = await ask(h.TOKEN_A, conv, "yes, cancel it");
  assert.notEqual(yes.data.action, "cancel_booking");
  assert.equal(row(b.id).status, "confirmed");

  // a negated request is not a request
  const conv3 = newConversation();
  const neg = await ask(h.TOKEN_A, conv3, `don't cancel booking ${b.reference}`);
  assert.match(neg.data.reply, /Nothing was changed/);
  assert.equal(pendingRows(h.USER_A, conv3).length, 0);
});

test("10. a conversation reset while the question is pending closes it", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  assert.equal(pendingRows(h.USER_A, conv).length, 1);
  await ask(h.TOKEN_A, conv, "start over");
  assert.equal(pendingRows(h.USER_A, conv).length, 0);
  const yes = await ask(h.TOKEN_A, conv, "yes");
  assert.notEqual(yes.data.action, "cancel_booking");
  assert.equal(row(b.id).status, "confirmed");
});

test("11. the pending question belongs to ONE conversation: a new conversation id cannot answer it", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const oldConv = newConversation();
  await ask(h.TOKEN_A, oldConv, `cancel booking ${b.reference}`);
  const yes = await ask(h.TOKEN_A, newConversation(), "Yes, cancel it.");
  assert.notEqual(yes.data.action, "cancel_booking");
  assert.equal(row(b.id).status, "confirmed");
});

test("12. an expired question cannot be answered, and the visitor is told", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  const pending = pendingRows(h.USER_A, conv)[0];
  pending.expires_at = new Date(Date.now() - 1000).toISOString();

  const r = await ask(h.TOKEN_A, conv, "Yes, cancel it.");
  assert.equal(r.status, 200);
  assert.notEqual(r.data.action, "cancel_booking");
  assert.match(r.data.reply, /expired/);
  assert.equal(row(b.id).status, "confirmed");
  assert.equal(pendingRows(h.USER_A, conv).length, 0, "the expired row is closed");
  // Arabic wording too
  await ask(h.TOKEN_A, conv, `الغي حجز ${b.reference}`);
  pendingRows(h.USER_A, conv)[0].expires_at = new Date(Date.now() - 1000).toISOString();
  const ar = await ask(h.TOKEN_A, conv, "أيوه، ألغي الحجز.");
  assert.match(ar.data.reply, /انتهت مدته/);
  assert.equal(row(b.id).status, "confirmed");
});

test("13. simultaneous 'yes' messages: exactly one cancellation, the rest are told it is already cancelled", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  const results = await Promise.all(Array.from({ length: 8 }, () => ask(h.TOKEN_A, conv, "Yes, cancel it.")));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  const first = results.filter((r) => r.data.booking && r.data.booking.replayed === false);
  assert.equal(first.length, 1, "one request changed the booking");
  // late arrivals either see the same final state ("already cancelled") or find no open question; none errors
  for (const r of results) {
    publicAction(r);
    if (r.data.action === "cancel_booking") assert.equal(r.data.booking.status, "cancelled");
  }
  assert.equal(row(b.id).status, "cancelled");
  assert.equal(h.db.tables.bookings.filter((x) => x.id === b.id).length, 1);
});

test("14. a visit date that has already passed cannot be cancelled", async () => {
  const b = await makeBooking(h.TOKEN_A);
  row(b.id).visit_date = addDays(cairoToday(), -2);
  const conv = newConversation();
  const r = await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  assert.match(r.data.reply, /already passed/);
  assert.equal(pendingRows(h.USER_A, conv).length, 0);
  assert.equal(row(b.id).status, "confirmed");
});

test("15. nothing the browser adds to the request can cancel or redirect anything", async () => {
  const mine = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  const r = await h.api("POST", "/api/ai/chat", {
    token: h.TOKEN_B,
    body: {
      message: "yes", conversation_id: conv, language: "en",
      user_id: h.USER_A, booking_reference: mine.reference, booking_id: mine.id,
      cancel: true, confirm_cancellation: true, cancellation_confirmed: true, status: "cancelled",
    },
  });
  assert.equal(r.status, 200);
  assert.notEqual(r.data.action, "cancel_booking");
  assert.equal(row(mine.id).status, "confirmed");
});

test("16. guests: a guest cancels only their own booking; a lost or fake session is refused", async () => {
  const guest = "77777777-7777-4777-8777-777777777777";
  h.db.guestTokens.set("guest-cancel-1", guest);
  process.env.ALLOW_GUEST_USERS = "true";
  try {
    const b = await makeBooking("guest-cancel-1");
    const conv = newConversation();
    await ask("guest-cancel-1", conv, `cancel booking ${b.reference}`);

    // the session is lost / replaced by garbage: nothing happens
    const lost = await ask("expired-or-fake-token", conv, "Yes, cancel it.");
    assert.equal(lost.status, 401);
    assert.equal(row(b.id).status, "confirmed");
    const none = await h.api("POST", "/api/ai/chat", { body: { message: "yes", conversation_id: conv, language: "en" } });
    assert.equal(none.status, 401);

    // a different user cannot continue this guest's conversation
    const stolen = await ask(h.TOKEN_B, conv, "Yes, cancel it.");
    assert.notEqual(stolen.data.action, "cancel_booking");
    assert.equal(row(b.id).status, "confirmed");

    const ok = await ask("guest-cancel-1", conv, "Yes, cancel it.");
    assert.equal(ok.data.action, "cancel_booking");
    assert.equal(row(b.id).status, "cancelled");
  } finally {
    delete process.env.ALLOW_GUEST_USERS;
  }
  // guests are refused again once Guest Mode is off
  const off = await ask("guest-cancel-1", newConversation(), "cancel booking GEM-0000000000");
  assert.equal(off.status, 401);
});

test("17. normal booking still works after a cancellation, in the same conversation", async () => {
  const old = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `cancel booking ${old.reference}`);
  await ask(h.TOKEN_A, conv, "yes");
  assert.equal(row(old.id).status, "cancelled");

  let last;
  for (const m of ["I want to book a visit", "tomorrow", "2", "Mona Said"]) last = await ask(h.TOKEN_A, conv, m);
  assert.match(last.data.reply, /confirm the booking/i);
  const done = await ask(h.TOKEN_A, conv, "yes confirm", { confirmation_revision: last.data.confirmation_revision });
  assert.equal(done.data.action, "confirm");
  assert.notEqual(done.data.booking.booking_reference, old.reference);
  assert.equal(row(done.data.booking.id).status, "confirmed");
  assert.equal(row(old.id).status, "cancelled");
});

test("18. cancelling a booking while another summary is on screen keeps that summary confirmable", async () => {
  const old = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  let last;
  for (const m of ["hello", "tomorrow", "4", "Omar Adel"]) last = await ask(h.TOKEN_A, conv, m);
  const revision = last.data.confirmation_revision;
  assert.ok(revision >= 1);

  let r = await ask(h.TOKEN_A, conv, `cancel booking ${old.reference}`);
  assert.equal(r.data.confirmation_revision, revision, "the summary the visitor sees stays valid");
  assert.equal(r.data.extracted.visitor_name, "Omar Adel");
  r = await ask(h.TOKEN_A, conv, "Yes, cancel it.");
  assert.equal(r.data.action, "cancel_booking");
  assert.equal(r.data.confirmation_revision, revision);
  assert.equal(row(old.id).status, "cancelled");

  const done = await ask(h.TOKEN_A, conv, "yes confirm", { confirmation_revision: revision });
  assert.equal(done.data.action, "confirm");
  assert.equal(done.data.booking.visitor_name, "Omar Adel");
});

test("19. a repeated 'yes' after the cancellation changes nothing and creates nothing", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  await ask(h.TOKEN_A, conv, "yes");
  const count = h.db.tables.bookings.length;
  const again = await ask(h.TOKEN_A, conv, "yes");
  assert.notEqual(again.data.action, "cancel_booking");
  assert.equal(h.db.tables.bookings.length, count);
  assert.equal(row(b.id).status, "cancelled");
});

test("20. database failures are reported safely and never cancel by accident", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();

  h.db.failNext = { table: "bookings", op: "select" };
  let r = await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "BOOKING_LOOKUP_FAILED");

  h.db.failNext = { table: "booking_cancellation_requests", op: "upsert" };
  r = await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "CANCELLATION_SAVE_FAILED");

  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  h.db.failNext = { table: "rpc", op: "cancel_egyxos_booking" };
  r = await ask(h.TOKEN_A, conv, "yes");
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "BOOKING_CANCELLATION_FAILED");
  assert.equal(row(b.id).status, "confirmed");
  assert.doesNotMatch(JSON.stringify(r.json), /simulated/);

  // the question could not be read: the server refuses to guess
  h.db.failNext = { table: "booking_cancellation_requests", op: "select" };
  r = await ask(h.TOKEN_A, conv, "yes");
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "CANCELLATION_LOOKUP_FAILED");
  assert.equal(row(b.id).status, "confirmed");

  // and the visitor can still finish normally afterwards
  r = await ask(h.TOKEN_A, conv, "yes");
  assert.equal(r.data.action, "cancel_booking");
});

test("21. the new endpoints stay inside the contract: no internal action, no secrets, no other user's data", async () => {
  const b = await makeBooking(h.TOKEN_A, { name: "Contract Person" });
  const conv = newConversation();
  const seen = [];
  for (const text of [`cancel booking ${b.reference}`, "maybe", `cancel booking ${b.reference}`, "yes"]) {
    const r = await ask(h.TOKEN_A, conv, text);
    publicAction(r);
    seen.push(JSON.stringify(r.json));
  }
  assert.doesNotMatch(seen.join(""), /sb_secret|FAKE_FOR_TESTS|cancel_booking_(lookup|confirm|decline|expired)|user_id/);
  const other = await h.api("GET", "/api/bookings", { token: h.TOKEN_B });
  assert.ok(!other.data.bookings.some((x) => x.id === b.id));
});

test("22. the app still starts without n8n or any AI service while using the new tables", async () => {
  assert.deepEqual(h.outgoing, [], "server.js made no fetch() call at all");
});

test("23. an expired cancellation question never blocks confirming a real booking draft", async () => {
  const old = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  let last;
  for (const m of ["hello", "tomorrow", "2", "Laila Hassan"]) last = await ask(h.TOKEN_A, conv, m);
  await ask(h.TOKEN_A, conv, `cancel booking ${old.reference}`);
  pendingRows(h.USER_A, conv)[0].expires_at = new Date(Date.now() - 1000).toISOString();
  const done = await ask(h.TOKEN_A, conv, "yes confirm", { confirmation_revision: last.data.confirmation_revision });
  assert.equal(done.data.action, "confirm");
  assert.equal(row(old.id).status, "confirmed", "the old booking was not touched");
});

test("24. while a cancellation question is open, 'yes' answers THAT question, not the booking draft", async () => {
  const old = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  let last;
  for (const m of ["hello", "tomorrow", "2", "Laila Hassan"]) last = await ask(h.TOKEN_A, conv, m);
  const bookingsBefore = h.db.tables.bookings.length;
  await ask(h.TOKEN_A, conv, `cancel booking ${old.reference}`);
  const r = await ask(h.TOKEN_A, conv, "yes", { confirmation_revision: last.data.confirmation_revision });
  assert.equal(r.data.action, "cancel_booking");
  assert.equal(row(old.id).status, "cancelled");
  assert.equal(h.db.tables.bookings.length, bookingsBefore, "no new booking was created by that 'yes'");
});
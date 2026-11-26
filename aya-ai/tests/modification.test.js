"use strict";

// MOCKED integration tests for MODIFYING a CONFIRMED booking through Egyxos.
// The REAL backend/server.js and backend/chatbot.js run against the in-memory
// Supabase fake (helpers/fake-supabase.js), which includes a port of the SQL
// function modify_egyxos_booking. Nothing here touches real Supabase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server-harness");
const { cairoToday, addDays } = require("../backend/chatbot");

let h;
test.before(async () => { h = await startServer(); });
test.after(async () => { await h.close(); });

let counter = 0;
const newConversation = () => `conv-modify-${Date.now()}-${++counter}`;

/** Make a real CONFIRMED booking through the chat (the same path the page uses). */
async function makeBooking(token, { lang = "en", name, visitors = 3 } = {}) {
  const conv = newConversation();
  const person = name || (lang === "ar" ? "أحمد محمد" : "Sara Ali");
  const msgs = lang === "ar"
    ? ["عايز أحجز زيارة", "بكرة", String(visitors), person]
    : ["hello", "tomorrow", String(visitors), person];
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
const requestsOf = (user, conv) => h.db.tables.booking_modification_requests.filter((r) => r.user_id === user && (!conv || r.conversation_id === conv));
const pendingOf = (user, conv) => requestsOf(user, conv).filter((r) => r.status === "pending");
const ask = (token, conv, text, extra = {}) => h.chat(token, conv, text, { language: /[a-z]/i.test(text) ? "en" : "ar", ...extra });
const snapshot = () => JSON.stringify({ bookings: h.db.tables.bookings, drafts: h.db.tables.booking_drafts });
const counts = () => ({ bookings: h.db.tables.bookings.length, drafts: h.db.tables.booking_drafts.length });
const inDays = (n) => addDays(cairoToday(), n);

// The only actions a visitor's browser may ever receive.
const publicAction = (r) =>
  assert.ok([null, "confirm", "reset", "cancel_booking", "modify_booking"].includes(r.data.action), `leaked action ${r.data.action}`);

// ---------------------------------------------------------------------

test("1. the example from the brief: 1 visitor -> 3 visitors, same booking, same reference", async () => {
  const b = await makeBooking(h.TOKEN_A, { visitors: 1 });
  const before = counts();
  const createdAt = row(b.id).created_at;
  const conv = newConversation(); // a fresh visit to the page

  let r = await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 3 visitors.`);
  assert.equal(r.status, 200);
  assert.equal(r.data.action, null);
  assert.match(r.data.reply, /I found your booking/);
  assert.match(r.data.reply, /You currently have 1 visitor\./);
  assert.match(r.data.reply, /Would you like to update it to 3 visitors\?/);
  assert.equal(row(b.id).visitors, 1, "asking is not changing");
  assert.equal(pendingOf(h.USER_A, conv).length, 1);
  assert.equal(r.data.draft_saved, false);
  publicAction(r);

  r = await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "modify_booking");
  assert.match(r.data.reply, /Your booking has been updated successfully\./);
  assert.match(r.data.reply, new RegExp(`Your booking reference remains ${b.reference}`));
  assert.equal(r.data.booking.id, b.id);
  assert.equal(r.data.booking.booking_reference, b.reference);
  assert.equal(r.data.booking.status, "confirmed");
  assert.equal(r.data.booking.ticket_count, 3);

  const stored = row(b.id);
  assert.equal(stored.visitors, 3);
  assert.equal(stored.status, "confirmed", "a modification never cancels");
  assert.equal(stored.booking_reference, b.reference);
  assert.equal(stored.created_at, createdAt);
  assert.notEqual(stored.updated_at, createdAt);
  assert.deepEqual(counts(), before, "no booking and no draft was created");
  assert.equal(pendingOf(h.USER_A, conv).length, 0);
  publicAction(r);
});

test("2. change the visit date (English)", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  const target = inDays(12);
  let r = await ask(h.TOKEN_A, conv, `Please change the date of booking ${b.reference} to ${target}`);
  assert.match(r.data.reply, /Date: from .* to /);
  assert.equal(row(b.id).visit_date, inDays(1));
  r = await ask(h.TOKEN_A, conv, "yes, confirm");
  assert.equal(r.data.action, "modify_booking");
  assert.equal(row(b.id).visit_date, target);
  assert.equal(row(b.id).visitors, 3, "other fields untouched");
  assert.equal(row(b.id).visitor_name, "Sara Ali");
});

test("3. change the visit date and count in Arabic", async () => {
  const b = await makeBooking(h.TOKEN_A, { lang: "ar" });
  const conv = newConversation();
  let r = await ask(h.TOKEN_A, conv, `غير حجز ${b.reference} ل 4 اشخاص`);
  assert.match(r.data.reply, /لقيت حجزك/);
  assert.match(r.data.reply, /عدد الزوار الحالي 3/);
  assert.equal(row(b.id).visitors, 3);
  r = await ask(h.TOKEN_A, conv, "أيوه، أكد");
  assert.equal(r.data.action, "modify_booking");
  assert.match(r.data.reply, /تم تعديل حجزك بنجاح/);
  assert.equal(row(b.id).visitors, 4);

  const conv2 = newConversation();
  await ask(h.TOKEN_A, conv2, `غير تاريخ الحجز ${b.reference} لبعد 5 ايام`);
  r = await ask(h.TOKEN_A, conv2, "أيوه، أكد");
  assert.equal(r.data.action, "modify_booking");
  assert.equal(row(b.id).visit_date, inDays(5));
});

test("4. change the visitor name", async () => {
  const b = await makeBooking(h.TOKEN_A, { name: "Old Visitor" });
  const conv = newConversation();
  let r = await ask(h.TOKEN_A, conv, `Change the name on booking ${b.reference} to Mona Said`);
  assert.match(r.data.reply, /Name: from Old Visitor to Mona Said/);
  r = await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.equal(r.data.action, "modify_booking");
  assert.equal(row(b.id).visitor_name, "Mona Said");
  assert.equal(r.data.booking.visitor_name, "Mona Said");
});

test("5. date, visitors and name together", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  const target = inDays(20);
  let r = await ask(h.TOKEN_A, conv, `update ${b.reference}: 2 visitors, date ${target}, name: Omar Hassan`);
  assert.match(r.data.reply, /Here is what would change/);
  r = await ask(h.TOKEN_A, conv, "yes");
  assert.equal(r.data.action, "modify_booking");
  const s = row(b.id);
  assert.deepEqual([s.visit_date, s.visitors, s.visitor_name, s.status], [target, 2, "Omar Hassan", "confirmed"]);
});

test("6. another user's reference and an unknown reference get the SAME answer and leak nothing", async () => {
  const mine = await makeBooking(h.TOKEN_A, { name: "Private Person" });
  const convB = newConversation();
  const before = snapshot();

  const other = await ask(h.TOKEN_B, convB, `Change booking ${mine.reference} to 5 visitors`, { user_id: h.USER_A });
  const unknown = await ask(h.TOKEN_B, newConversation(), "Change booking GEM-0000000000 to 5 visitors");
  assert.equal(other.status, 200);
  assert.equal(other.data.reply, unknown.data.reply);
  assert.match(other.data.reply, /couldn't find a booking/);
  assert.doesNotMatch(JSON.stringify(other.json), /Private Person/);
  assert.equal(pendingOf(h.USER_B, convB).length, 0);

  // a following "yes" cannot change it either
  const yes = await ask(h.TOKEN_B, convB, "Yes, confirm.");
  assert.notEqual(yes.data.action, "modify_booking");
  assert.equal(snapshot(), before);
});

test("7. a cancelled booking cannot be modified", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const c1 = newConversation();
  await ask(h.TOKEN_A, c1, `cancel booking ${b.reference}`);
  await ask(h.TOKEN_A, c1, "Yes, cancel it.");
  assert.equal(row(b.id).status, "cancelled");
  const before = snapshot();

  const conv = newConversation();
  const r = await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 2 visitors`);
  assert.match(r.data.reply, /has been cancelled, so it can't be changed/);
  assert.equal(r.data.action, null);
  assert.equal(pendingOf(h.USER_A, conv).length, 0);
  const yes = await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.notEqual(yes.data.action, "modify_booking");
  assert.equal(snapshot(), before);
  assert.equal(row(b.id).status, "cancelled", "status never changes by a modification");
});

test("8. a booking whose visit date has passed cannot be modified", async () => {
  const b = await makeBooking(h.TOKEN_A);
  row(b.id).visit_date = addDays(cairoToday(), -2);
  const conv = newConversation();
  const r = await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 2 visitors`);
  assert.match(r.data.reply, /already passed/);
  assert.equal(pendingOf(h.USER_A, conv).length, 0);
  assert.equal(row(b.id).visitors, 3);
});

test("9. declining keeps the booking, and a later 'yes' does nothing", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 6 visitors`);
  let r = await ask(h.TOKEN_A, conv, "No");
  assert.match(r.data.reply, /Nothing was changed/);
  assert.equal(row(b.id).visitors, 3);
  assert.equal(pendingOf(h.USER_A, conv).length, 0);
  r = await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.notEqual(r.data.action, "modify_booking");
  assert.equal(row(b.id).visitors, 3);

  // Arabic decline
  const conv2 = newConversation();
  await ask(h.TOKEN_A, conv2, `غير حجز ${b.reference} ل 6 اشخاص`);
  r = await ask(h.TOKEN_A, conv2, "لا");
  assert.match(r.data.reply, /مفيش حاجة اتغيرت/);
  assert.equal(row(b.id).visitors, 3);
});

test("10. repeating the same confirmation applies nothing twice", async () => {
  const b = await makeBooking(h.TOKEN_A, { visitors: 2 });
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 5 visitors`);
  const first = await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.equal(first.data.action, "modify_booking");
  const stamp = row(b.id).updated_at;
  const before = counts();
  const rpcBefore = h.db.calls.filter((c) => c.table === "rpc" && c.op === "modify_egyxos_booking").length;

  const again = await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.equal(again.status, 200);
  assert.equal(again.data.action, "modify_booking");
  assert.match(again.data.reply, /updated successfully/);
  assert.equal(again.data.booking.ticket_count, 5);
  assert.equal(row(b.id).updated_at, stamp, "not applied a second time");
  assert.deepEqual(counts(), before);
  assert.equal(
    h.db.calls.filter((c) => c.table === "rpc" && c.op === "modify_egyxos_booking").length,
    rpcBefore,
    "the database function is not called again"
  );
});

test("11. a modify request never creates or edits a booking draft, even mid-draft", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();

  // an unfinished booking in this conversation, summary on screen
  let last;
  for (const m of ["hello", "in 4 days", "2", "Nadia Fouad"]) last = await ask(h.TOKEN_A, conv, m);
  const revision = last.data.confirmation_revision;
  assert.ok(revision, "summary presented");
  const draftBefore = JSON.stringify(h.db.tables.booking_drafts.find((d) => d.conversation_id === conv));
  const before = counts();

  let r = await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 7 visitors`);
  assert.match(r.data.reply, /I found your booking/);
  assert.equal(r.data.draft_saved, false);
  assert.deepEqual(r.data.extracted, { visit_date: inDays(4), ticket_count: 2, visitor_name: "Nadia Fouad" });
  assert.equal(r.data.confirmation_revision, revision, "the summary on screen stays valid");
  assert.equal(JSON.stringify(h.db.tables.booking_drafts.find((d) => d.conversation_id === conv)), draftBefore);

  r = await ask(h.TOKEN_A, conv, "Yes, confirm.", { confirmation_revision: revision });
  assert.equal(r.data.action, "modify_booking", "the open modification question gets the yes");
  assert.equal(row(b.id).visitors, 7);
  assert.deepEqual(counts(), before, "the modification created nothing");
  assert.equal(h.db.tables.booking_drafts.find((d) => d.conversation_id === conv).status, "awaiting_confirmation");

  // the unfinished booking can still be confirmed normally, creating its own booking
  r = await ask(h.TOKEN_A, conv, "Yes, confirm.", { confirmation_revision: revision });
  assert.equal(r.data.action, "confirm");
  assert.equal(h.db.tables.bookings.length, before.bookings + 1);
  assert.equal(row(b.id).visitors, 7, "the first booking is not touched by the new one");
});

test("12. a modification answered with a 'yes' does not confirm a draft, and vice versa", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  for (const m of ["hello", "in 6 days", "2", "Nadia Fouad"]) await ask(h.TOKEN_A, conv, m);
  const bookingsBefore = h.db.tables.bookings.length;

  // modification question dismissed by an unrelated message; the next yes belongs to the draft
  await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 8 visitors`);
  await ask(h.TOKEN_A, conv, "thanks");
  assert.equal(pendingOf(h.USER_A, conv).length, 0);
  assert.equal(row(b.id).visitors, 3);
  assert.equal(h.db.tables.bookings.length, bookingsBefore);
});

test("13. validation: bad values are explained and nothing is stored", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const before = snapshot();
  const cases = [
    [`Change booking ${b.reference} to 11 visitors`, /between 1 and 10/],
    [`Change booking ${b.reference} to 0 visitors`, /between 1 and 10/],
    [`Change booking ${b.reference} to ${addDays(cairoToday(), 400)}`, /one year ahead/],
    [`Change booking ${b.reference} to 3 visitors and 4 visitors`, /more than one visitor count/],
    [`Change the name on booking ${b.reference} to R2D2`, /letters only/],
  ];
  for (const [text, expected] of cases) {
    const conv = newConversation();
    const r = await ask(h.TOKEN_A, conv, text);
    assert.equal(r.status, 200, text);
    assert.match(r.data.reply, expected, text);
    assert.equal(r.data.action, null);
    assert.equal(pendingOf(h.USER_A, conv).length, 0, text);
  }
  assert.equal(snapshot(), before);
});

test("14. a malformed reference, a missing reference and a missing change are handled without storing anything", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const before = snapshot();

  let conv = newConversation();
  let r = await ask(h.TOKEN_A, conv, "Change booking GEM-123 to 3 visitors");
  assert.match(r.data.reply, /doesn't look right/);

  r = await ask(h.TOKEN_A, conv, "I want to change my booking");
  assert.match(r.data.reply, /send me the reference of the booking and what to change/);

  r = await ask(h.TOKEN_A, conv, "عايز اغير حجزي");
  assert.match(r.data.reply, /ابعتلي رقم الحجز والتعديل/);

  r = await ask(h.TOKEN_A, conv, `Change booking ${b.reference}`);
  assert.match(r.data.reply, /What would you like to change on booking/);

  conv = newConversation();
  r = await ask(h.TOKEN_A, conv, `Don't change booking ${b.reference}`);
  assert.match(r.data.reply, /Nothing was changed/);
  r = await ask(h.TOKEN_A, conv, `مش عايز اغير الحجز ${b.reference}`);
  assert.match(r.data.reply, /مفيش حاجة اتغيرت/);

  assert.equal(pendingOf(h.USER_A).filter((x) => x.booking_reference === b.reference).length, 0);
  assert.equal(snapshot(), before);
});

test("15. asking for what the booking already has changes nothing and stores no question", async () => {
  const b = await makeBooking(h.TOKEN_A, { visitors: 3 });
  const conv = newConversation();
  const before = snapshot();
  const r = await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 3 visitors`);
  assert.match(r.data.reply, /already has those details/);
  assert.equal(pendingOf(h.USER_A, conv).length, 0);
  assert.equal(snapshot(), before);
});

test("16. an expired question cannot be answered", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 9 visitors`);
  pendingOf(h.USER_A, conv)[0].expires_at = new Date(Date.now() - 1000).toISOString();

  const r = await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.match(r.data.reply, /has expired/);
  assert.notEqual(r.data.action, "modify_booking");
  assert.equal(row(b.id).visitors, 3);
  assert.equal(pendingOf(h.USER_A, conv).length, 0);
});

test("17. a stale proposal is refused: the booking changed after it was shown", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const c1 = newConversation();
  const c2 = newConversation();
  await ask(h.TOKEN_A, c1, `Change booking ${b.reference} to 5 visitors`);
  await ask(h.TOKEN_A, c2, `Change booking ${b.reference} to 8 visitors`);

  // the second conversation answers first
  let r = await ask(h.TOKEN_A, c2, "Yes, confirm.");
  assert.equal(r.data.action, "modify_booking");
  assert.equal(row(b.id).visitors, 8);

  // the first one was shown a booking that no longer exists in that form
  r = await ask(h.TOKEN_A, c1, "Yes, confirm.");
  assert.match(r.data.reply, /changed after I showed you the proposal/);
  assert.notEqual(r.data.action, "modify_booking");
  assert.equal(row(b.id).visitors, 8, "the stale proposal did not overwrite the newer change");
});

test("18. a booking cancelled after the proposal is not modified", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 5 visitors`);

  const cancelConv = newConversation();
  await ask(h.TOKEN_A, cancelConv, `cancel booking ${b.reference}`);
  await ask(h.TOKEN_A, cancelConv, "yes");
  assert.equal(row(b.id).status, "cancelled");

  const r = await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.match(r.data.reply, /has been cancelled, so it can't be changed/);
  assert.equal(row(b.id).status, "cancelled");
  assert.equal(row(b.id).visitors, 3);
});

test("19. two simultaneous confirmations: the change is applied exactly once", async () => {
  const b = await makeBooking(h.TOKEN_A, { visitors: 2 });
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 6 visitors`);
  const rpcBefore = h.db.calls.filter((c) => c.table === "rpc" && c.op === "modify_egyxos_booking").length;

  const [x, y] = await Promise.all([
    ask(h.TOKEN_A, conv, "Yes, confirm."),
    ask(h.TOKEN_A, conv, "Yes, confirm."),
  ]);
  for (const r of [x, y]) {
    assert.equal(r.status, 200);
    assert.equal(r.data.action, "modify_booking", "the loser reports the same result");
    assert.equal(r.data.booking.ticket_count, 6);
  }
  assert.equal(row(b.id).visitors, 6);
  assert.equal(requestsOf(h.USER_A, conv).filter((r) => r.status === "used").length, 1);
  assert.ok(h.db.calls.filter((c) => c.table === "rpc" && c.op === "modify_egyxos_booking").length >= rpcBefore + 1);
});

test("20. two open conversations on the same booking: only the first yes applies", async () => {
  const b = await makeBooking(h.TOKEN_A, { visitors: 2 });
  const c1 = newConversation();
  const c2 = newConversation();
  await ask(h.TOKEN_A, c1, `Change booking ${b.reference} to 4 visitors`);
  await ask(h.TOKEN_A, c2, `Change booking ${b.reference} to 9 visitors`);

  const [x, y] = await Promise.all([
    ask(h.TOKEN_A, c1, "Yes, confirm."),
    ask(h.TOKEN_A, c2, "Yes, confirm."),
  ]);
  const applied = [x, y].filter((r) => r.data.action === "modify_booking");
  assert.equal(applied.length, 1, "exactly one proposal wins");
  assert.ok([4, 9].includes(row(b.id).visitors));
  assert.equal(row(b.id).visitors, applied[0].data.booking.ticket_count);
});

test("21. a question belongs to its own conversation and its own user", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 5 visitors`);

  // another conversation of the same user
  let r = await ask(h.TOKEN_A, newConversation(), "Yes, confirm.");
  assert.notEqual(r.data.action, "modify_booking");
  // the same conversation id used by another user
  r = await ask(h.TOKEN_B, conv, "Yes, confirm.");
  assert.notEqual(r.data.action, "modify_booking");
  assert.equal(row(b.id).visitors, 3);
  assert.equal(pendingOf(h.USER_A, conv).length, 1, "still waiting for its own conversation");

  r = await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.equal(r.data.action, "modify_booking");
});

test("22. only the explicit yes applies a change: 'ok', 'sure', 'cancel it' and other words do not", async () => {
  const b = await makeBooking(h.TOKEN_A);
  for (const text of ["ok", "sure", "Yes, cancel it.", "maybe", "go for it", "👍"]) {
    const conv = newConversation();
    await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 5 visitors`);
    const r = await ask(h.TOKEN_A, conv, text);
    assert.notEqual(r.data.action, "modify_booking", text);
    assert.notEqual(r.data.action, "cancel_booking", text);
    assert.equal(row(b.id).visitors, 3, text);
    assert.equal(row(b.id).status, "confirmed", text);
    assert.equal(pendingOf(h.USER_A, conv).length, 0, `${text}: the question is closed`);
  }
});

test("23. a new request replaces the open question; a cancel question and a modify question never coexist", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();

  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  assert.equal(h.db.tables.booking_cancellation_requests.filter((r) => r.conversation_id === conv && r.status === "pending").length, 1);

  await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 5 visitors`);
  assert.equal(h.db.tables.booking_cancellation_requests.filter((r) => r.conversation_id === conv && r.status === "pending").length, 0, "the cancel question was closed");
  assert.equal(pendingOf(h.USER_A, conv).length, 1);

  await ask(h.TOKEN_A, conv, `cancel booking ${b.reference}`);
  assert.equal(pendingOf(h.USER_A, conv).length, 0, "the modify question was closed");
  const r = await ask(h.TOKEN_A, conv, "Yes, cancel it.");
  assert.equal(r.data.action, "cancel_booking");
  assert.equal(row(b.id).status, "cancelled");
  assert.equal(row(b.id).visitors, 3, "the closed modification was never applied");
});

test("24. two questions open at once (simultaneous requests): both are closed, nothing happens", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  const future = new Date(Date.now() + 60_000).toISOString();
  h.db.tables.booking_cancellation_requests.push({
    id: "c-1", user_id: h.USER_A, conversation_id: conv, booking_id: b.id,
    booking_reference: b.reference, status: "pending", created_at: new Date().toISOString(), expires_at: future,
  });
  h.db.tables.booking_modification_requests.push({
    id: "m-1", user_id: h.USER_A, conversation_id: conv, booking_id: b.id, booking_reference: b.reference,
    proposed_visit_date: row(b.id).visit_date, proposed_visitors: 9, proposed_visitor_name: row(b.id).visitor_name,
    base_visit_date: row(b.id).visit_date, base_visitors: row(b.id).visitors, base_visitor_name: row(b.id).visitor_name,
    base_updated_at: row(b.id).updated_at, status: "pending", created_at: new Date().toISOString(), expires_at: future,
  });
  const before = snapshot();

  const r = await ask(h.TOKEN_A, conv, "Yes");
  assert.equal(r.status, 200);
  assert.equal(r.data.action, null);
  assert.match(r.data.reply, /two open requests/);
  assert.equal(snapshot(), before);
  assert.equal(pendingOf(h.USER_A, conv).length, 0);
  assert.equal(h.db.tables.booking_cancellation_requests.filter((x) => x.conversation_id === conv && x.status === "pending").length, 0);
});

test("25. cancellation and normal booking creation still work next to modification", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 4 visitors`);
  await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.equal(row(b.id).visitors, 4);

  // a modified booking can still be cancelled
  const cancelConv = newConversation();
  await ask(h.TOKEN_A, cancelConv, `cancel booking ${b.reference}`);
  const c = await ask(h.TOKEN_A, cancelConv, "Yes, cancel it.");
  assert.equal(c.data.action, "cancel_booking");
  assert.equal(row(b.id).status, "cancelled");

  // and a brand new booking is created normally
  const created = await makeBooking(h.TOKEN_A, { visitors: 2 });
  assert.notEqual(created.id, b.id);
  assert.equal(row(created.id).status, "confirmed");
});

test("26. My Bookings shows the updated details of the same booking", async () => {
  const b = await makeBooking(h.TOKEN_A, { visitors: 1, name: "Layla Hassan" });
  const conv = newConversation();
  const target = inDays(15);
  await ask(h.TOKEN_A, conv, `update ${b.reference}: 5 visitors, date ${target}, name: Layla Mansour`);
  await ask(h.TOKEN_A, conv, "Yes, confirm.");

  const list = await h.api("GET", "/api/bookings", { token: h.TOKEN_A });
  const shown = list.data.bookings.filter((x) => x.booking_reference === b.reference);
  assert.equal(shown.length, 1, "still one booking with this reference");
  assert.equal(shown[0].id, b.id);
  assert.equal(shown[0].ticket_count, 5);
  assert.equal(shown[0].visit_date, target);
  assert.equal(shown[0].visitor_name, "Layla Mansour");
  assert.equal(shown[0].status, "confirmed");
});

test("27. database failures fail closed and change nothing", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const before = snapshot();

  // the pending lookup fails: the visitor's message is not processed at all
  h.db.failNext = { table: "booking_modification_requests", op: "select" };
  let r = await ask(h.TOKEN_A, newConversation(), `Change booking ${b.reference} to 5 visitors`);
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "MODIFICATION_LOOKUP_FAILED");

  // saving the question fails
  h.db.failNext = { table: "booking_modification_requests", op: "upsert" };
  r = await ask(h.TOKEN_A, newConversation(), `Change booking ${b.reference} to 5 visitors`);
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "MODIFICATION_SAVE_FAILED");

  // the atomic function fails
  const conv = newConversation();
  await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 5 visitors`);
  h.db.failNext = { table: "rpc", op: "modify_egyxos_booking" };
  r = await ask(h.TOKEN_A, conv, "Yes, confirm.");
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "BOOKING_MODIFICATION_FAILED");
  assert.equal(row(b.id).visitors, 3);
  assert.equal(row(b.id).status, "confirmed");

  // and the booking is still intact afterwards
  assert.equal(JSON.stringify(h.db.tables.bookings), JSON.stringify(JSON.parse(before).bookings));
});

test("28. no request without a valid sign-in, and no internal action ever reaches the browser", async () => {
  const b = await makeBooking(h.TOKEN_A);
  const anon = await h.api("POST", "/api/ai/chat", {
    body: { message: `Change booking ${b.reference} to 5 visitors`, conversation_id: newConversation(), language: "en" },
  });
  assert.equal(anon.status, 401);

  const conv = newConversation();
  const seen = [];
  seen.push(await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 5 visitors`));
  seen.push(await ask(h.TOKEN_A, conv, "No"));
  seen.push(await ask(h.TOKEN_A, conv, `Change booking ${b.reference} to 5 visitors`));
  seen.push(await ask(h.TOKEN_A, conv, "Yes, confirm."));
  seen.push(await ask(h.TOKEN_A, conv, "Yes, confirm."));
  for (const r of seen) publicAction(r);
  assert.equal(h.outgoing.length, 0, "the server made no outgoing network calls");
});
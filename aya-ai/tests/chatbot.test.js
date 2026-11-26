"use strict";

// Unit tests for backend/chatbot.js (pure functions: no database, no network).

const test = require("node:test");
const assert = require("node:assert/strict");
const { converse } = require("./helpers/converse");
const {
  processMessage, isConfirmation, isCancel, detectLanguage, parseMessage,
  parseBareCount, parseBareName, cairoToday, checkVisitDate, modifyText,
} = require("../backend/chatbot");

// ===== Parser =====


// Thursday 26 November 2026, 12:00 in Cairo.
const NOW = new Date("2026-11-26T10:00:00Z");
const date = (text, now = NOW) => parseMessage(text, now).date;
const count = (text) => parseMessage(text, NOW).count;

test("valid dates in supported formats", () => {
  const cases = {
    "2026-12-05": "2026-12-05",
    "27/11/2026": "2026-11-27",
    "27-11-2026": "2026-11-27",
    "27.11.2026": "2026-11-27",
    "27 نوفمبر": "2026-11-27",
    "٢٧ نوفمبر ٢٠٢٦": "2026-11-27",
    "27 نوفمبر 2026": "2026-11-27",
    "27th of November": "2026-11-27",
    "November 27": "2026-11-27",
    "27 Nov": "2026-11-27",
    "5 ديسمبر": "2026-12-05",
    "1 يناير": "2027-01-01", // already passed this year -> next year
    "27/11": "2026-11-27",
  };
  for (const [text, expected] of Object.entries(cases)) {
    const d = date(text);
    assert.equal(d.status, "ok", text);
    assert.equal(d.value, expected, text);
  }
});

test("invalid dates are rejected with a reason", () => {
  assert.deepEqual(pickError("31 فبراير"), "invalid");
  assert.deepEqual(pickError("2026-02-30"), "invalid");
  assert.deepEqual(pickError("1 jan 2020"), "past");
  assert.deepEqual(pickError("2026-11-25"), "past"); // yesterday
  assert.deepEqual(pickError("2028-01-01"), "far"); // beyond 365 days
  assert.deepEqual(pickError("2027-11-27"), "far"); // 366 days ahead
  function pickError(text) {
    const d = date(text);
    assert.equal(d.status, "error", text);
    return d.reason;
  }
});

test("booking window edges: today ok, +365 ok, +366 rejected", () => {
  assert.equal(checkVisitDate("2026-11-26", NOW), "ok");
  assert.equal(checkVisitDate("2027-11-26", NOW), "ok");
  assert.equal(checkVisitDate("2027-11-27", NOW), "far");
  assert.equal(checkVisitDate("2026-11-25", NOW), "past");
});

test("relative dates (Arabic and English)", () => {
  const cases = {
    "النهارده": "2026-11-26",
    "اليوم": "2026-11-26",
    "today": "2026-11-26",
    "بكرة": "2026-11-27",
    "بكره": "2026-11-27",
    "لبكرة": "2026-11-27",
    "tomorrow": "2026-11-27",
    "بعد بكرة": "2026-11-28",
    "day after tomorrow": "2026-11-28",
    "in 3 days": "2026-11-29",
    "بعد 3 ايام": "2026-11-29",
    "بعد يومين": "2026-11-28",
    "in a week": "2026-12-03",
  };
  for (const [text, expected] of Object.entries(cases)) {
    const d = date(text);
    assert.equal(d.value, expected, text);
  }
});

test("weekdays mean the first such day AFTER today (today is Thursday)", () => {
  const cases = {
    "next Friday": "2026-11-27",
    "Friday": "2026-11-27",
    "الجمعة الجاية": "2026-11-27",
    "يوم الجمعة": "2026-11-27",
    "للجمعة": "2026-11-27",
    "Sunday": "2026-11-29",
    "الأحد": "2026-11-29",
    "يوم الاتنين": "2026-11-30",
    "Thursday": "2026-12-03", // never "today": say "today" for that
    "الخميس": "2026-12-03",
  };
  for (const [text, expected] of Object.entries(cases)) {
    assert.equal(date(text).value, expected, text);
  }
});

test("relative dates use Africa/Cairo, not UTC", () => {
  // 22:30 UTC on 26 Nov is already 00:30 on 27 Nov in Cairo (UTC+2 in winter).
  const lateUtcWinter = new Date("2026-11-26T22:30:00Z");
  assert.equal(cairoToday(lateUtcWinter), "2026-11-27");
  assert.equal(date("today", lateUtcWinter).value, "2026-11-27");
  assert.equal(date("tomorrow", lateUtcWinter).value, "2026-11-28");
  assert.equal(date("بكرة", lateUtcWinter).value, "2026-11-28");

  // Just before midnight in Cairo it is still the same day.
  const beforeMidnight = new Date("2026-11-26T21:59:00Z");
  assert.equal(cairoToday(beforeMidnight), "2026-11-26");

  // Summer: Egypt uses UTC+3, so 21:30 UTC is 00:30 the next day.
  const lateUtcSummer = new Date("2026-07-15T21:30:00Z");
  assert.equal(cairoToday(lateUtcSummer), "2026-07-16");
  assert.equal(date("tomorrow", lateUtcSummer).value, "2026-07-17");
  assert.equal(cairoToday(new Date("2026-07-15T20:59:00Z")), "2026-07-15");

  // A date that is "today" in Cairo is accepted, "yesterday" is not.
  assert.equal(date("2026-11-27", lateUtcWinter).status, "ok");
  assert.equal(date("2026-11-26", lateUtcWinter).status, "error");
});

test("several different dates in one message are ambiguous", () => {
  assert.equal(date("بكرة او بعد بكرة").status, "ambiguous");
  assert.equal(date("27 نوفمبر او 28 نوفمبر").status, "ambiguous");
});

test("visitor counts 1 to 10 (digits, Arabic digits, words)", () => {
  for (let n = 1; n <= 10; n += 1) {
    assert.deepEqual(pickOk(`${n} people`), n, `${n} people`);
    assert.deepEqual(pickOk(`${n} أشخاص`), n, `${n} أشخاص`);
    assert.deepEqual(parseBareCount(String(n)), { status: "ok", value: n });
  }
  assert.equal(pickOk("٣ أشخاص"), 3);
  assert.equal(pickOk("شخصين"), 2);
  assert.equal(pickOk("لشخصين"), 2);
  assert.equal(pickOk("تلاتة أشخاص"), 3);
  assert.equal(pickOk("خمس زوار"), 5);
  assert.equal(pickOk("two people"), 2);
  assert.equal(pickOk("for 4"), 4);
  assert.equal(pickOk("for two"), 2);
  assert.equal(pickOk("لـ 6"), 6);
  assert.equal(pickOk("just me"), 1);
  assert.equal(pickOk("only me"), 1);
  assert.equal(pickOk("أنا بس"), 1);
  assert.equal(pickOk("لوحدي"), 1);
  assert.equal(pickOk("شخص واحد"), 1);
  assert.equal(pickOk("عدد الزوار 7"), 7);
  assert.equal(pickOk("visitors: 8"), 8);
  assert.deepEqual(parseBareCount("تلاتة"), { status: "ok", value: 3 });
  assert.deepEqual(parseBareCount("ten"), { status: "ok", value: 10 });
  function pickOk(text) {
    const c = count(text);
    assert.equal(c.status, "ok", text);
    return c.value;
  }
});

test("visitor counts outside 1-10 or unclear are rejected", () => {
  for (const text of ["0 people", "11 people", "100 اشخاص", "2.5 people"]) {
    assert.equal(count(text).status, "error", text);
  }
  assert.deepEqual(parseBareCount("0"), { status: "error", reason: "range" });
  assert.deepEqual(parseBareCount("11"), { status: "error", reason: "range" });
  assert.equal(count("3 adults 2 kids").status, "ambiguous");
  assert.equal(count("3 people or 4 people").status, "ambiguous");
  assert.equal(count("ثلاثة أطفال").status, "ambiguous");
});

test("a date is never mistaken for a visitor count (and the reverse)", () => {
  const r = parseMessage("عايز احجز 27 نوفمبر لـ 3 اشخاص", NOW);
  assert.equal(r.date.value, "2026-11-27");
  assert.equal(r.count.value, 3);
  const r2 = parseMessage("book 2 people on 5 December", NOW);
  assert.equal(r2.date.value, "2026-12-05");
  assert.equal(r2.count.value, 2);
});

test("names: explicit lead-ins and bare names", () => {
  const name = (text) => parseMessage(text, NOW).name;
  assert.equal(name("اسمي سارة علي").value, "سارة علي");
  assert.equal(name("الحجز باسم أحمد محمد").value, "أحمد محمد");
  assert.equal(name("my name is Sara Ali").value, "Sara Ali");
  assert.equal(name("booking under the name Omar Hassan").value, "Omar Hassan");
  assert.equal(name("حجز بكرة لشخصين باسم أحمد محمد").value, "أحمد محمد");
  assert.equal(parseBareName("أحمد محمد").value, "أحمد محمد");
  assert.equal(parseBareName("Sara").value, "Sara");
  assert.equal(parseBareName("عبد الله").value, "عبد الله");
  assert.equal(parseBareName("O'Neil-Smith Jr.").value, "O'Neil-Smith Jr"); // a trailing full stop is dropped
});

test("names: invalid input is rejected", () => {
  for (const bad of ["Ahmed3", "123", "A", "x".repeat(101), "<script>", "أحمد@محمد", "http://evil.com"]) {
    assert.equal(parseBareName(bad).status !== "ok", true, bad);
  }
  // Command words and greetings are never saved as names.
  for (const word of ["yes", "تمام", "cancel", "الغي", "hello", "مرحبا", "عايز احجز", "no"]) {
    assert.notEqual(parseBareName(word).status, "ok", word);
  }
  assert.equal(parseBareName("what is your name?").status, "none");
});

test("confirmation phrases: every phrase the old server accepted still works", () => {
  const old = ["أيوه", "ايوه", "نعم", "أكد", "اكد", "أكد الحجز", "اكد الحجز", "أيوه أكد الحجز",
    "ايوه اكد الحجز", "تمام أكد الحجز", "yes", "yes confirm", "confirm", "go ahead"];
  for (const phrase of old) assert.equal(isConfirmation(phrase), true, phrase);
  // The example from the task description.
  for (const phrase of ["أيوه أكد", "أيوه أكد.", "YES, CONFIRM!", "yes please", "confirm my booking",
    "ايوا اكد", "نعم اكد الحجز", "اكد الحجز من فضلك"]) {
    assert.equal(isConfirmation(phrase), true, phrase);
  }
});

test("confirmation phrases: anything unclear or negative is NOT a confirmation", () => {
  for (const phrase of ["تمام", "ok", "okay", "maybe", "لا", "لا اكد", "مش عايز اكد", "don't confirm",
    "no", "confirm cancel", "yes but change the date", "اكد بس غير التاريخ", "", "   ", "confirm 3 people",
    "yes confirm yes confirm yes confirm yes"]) {
    assert.equal(isConfirmation(phrase), false, JSON.stringify(phrase));
  }
  assert.equal(isConfirmation(null), false);
  assert.equal(isConfirmation(undefined), false);
  assert.equal(isConfirmation({}), false);
});

test("cancellation phrases", () => {
  for (const phrase of ["الغي الحجز", "ألغي الحجز ده", "عايز الغي الحجز", "عايزة الغي الحجز", "ابدأ من جديد",
    "عايز ابدأ من جديد", "cancel", "cancel this booking", "Cancel the booking.", "start over", "never mind", "حجز جديد"]) {
    assert.equal(isCancel(phrase), true, phrase);
  }
  for (const phrase of ["لا تلغي", "don't cancel", "yes", "بكرة", "what happens if I cancel?", "cancel the date"]) {
    assert.equal(isCancel(phrase), false, phrase);
  }
});

test("language detection", () => {
  assert.equal(detectLanguage("hello there", "ar"), "en");
  assert.equal(detectLanguage("مرحبا", "en"), "ar");
  assert.equal(detectLanguage("3", "en"), "en"); // no letters: keep the page language
  assert.equal(detectLanguage("3", "ar"), "ar");
});

test("signed or decimal numbers are never accepted as a visitor count", () => {
  for (const text of ["-3", "+3", "-3 people", "3.5", "−2"]) {
    const bare = parseBareCount(text);
    const inMsg = parseMessage(text, NOW).count;
    assert.notEqual(bare.status, "ok", text);
    assert.notEqual(inMsg.status, "ok", text);
  }
  assert.deepEqual(parseBareCount(" 3. "), { status: "ok", value: 3 });
  assert.deepEqual(parseBareCount("3؟"), { status: "ok", value: 3 });
});

// ===== Conversation engine =====



test("Arabic booking conversation (the example from the task)", () => {
  const { turns, draft } = converse(
    ["عايز أحجز زيارة للمتحف.", "بكرة", "3", "أحمد محمد", "أيوه أكد."],
    { lang: "ar", now: NOW },
  );
  assert.match(turns[0].reply, /تحب تزور المتحف إمتى/);
  assert.equal(turns[0].state, "START");
  assert.match(turns[1].reply, /كام شخص/);
  assert.equal(turns[1].state, "ASK_VISITORS");
  assert.match(turns[2].reply, /باسم مين/);
  assert.equal(turns[2].state, "ASK_NAME");
  assert.equal(turns[3].state, "REVIEW_BOOKING");
  assert.match(turns[3].reply, /تمام يا أحمد/);
  assert.match(turns[3].reply, /الجمعة 27 نوفمبر 2026/);
  assert.match(turns[3].reply, /عدد الزوار: 3/);
  assert.match(turns[3].reply, /الاسم: أحمد محمد/);
  assert.match(turns[3].reply, /تأكد الحجز ولا تعدل/);
  assert.equal(turns[4].action, "confirm");
  assert.deepEqual(turns[4].extracted, { visit_date: "2026-11-27", ticket_count: 3, visitor_name: "أحمد محمد" });
  assert.equal(draft.visitor_name, "أحمد محمد");
});

test("English booking conversation", () => {
  const { turns } = converse(["hello", "next Friday", "just me", "Sara Ali", "yes confirm"], { lang: "en", now: NOW });
  assert.match(turns[0].reply, /When would you like to visit/);
  assert.match(turns[1].reply, /How many people/);
  assert.match(turns[2].reply, /What name/);
  assert.match(turns[3].reply, /Thanks, Sara!/);
  assert.match(turns[3].reply, /Friday, 27 November 2026/);
  assert.equal(turns[4].action, "confirm");
  for (const t of turns.slice(0, 4)) assert.equal(t.language, "en");
});

test("several details in one message are all understood", () => {
  const { last } = converse(["حجز بعد بكرة لشخصين باسم منى سيد"], { now: NOW });
  assert.equal(last.state, "REVIEW_BOOKING");
  assert.deepEqual(last.extracted, { visit_date: "2026-11-28", ticket_count: 2, visitor_name: "منى سيد" });
  const en = converse(["book 4 people on 5 December, my name is Omar Hassan"], { lang: "en", now: NOW });
  assert.deepEqual(en.last.extracted, { visit_date: "2026-12-05", ticket_count: 4, visitor_name: "Omar Hassan" });
  const two = converse(["بكرة لشخصين"], { now: NOW });
  assert.equal(two.last.state, "ASK_NAME");
});

test("one field at a time, in order: date -> visitors -> name", () => {
  const { turns } = converse(["hi", "tomorrow", "3 people", "Ahmed Ali"], { lang: "en", now: NOW });
  assert.deepEqual(turns.map((t) => t.state), ["START", "ASK_VISITORS", "ASK_NAME", "REVIEW_BOOKING"]);
});

test("invalid input keeps the same question and explains the problem", () => {
  const { turns } = converse(
    ["عايز احجز", "امبارح", "1 يناير 2020", "31 فبراير", "27 نوفمبر", "0", "11", "3 اطفال و 2 كبار", "10", "Ahmed3", "123", "Mona Ali"],
    { lang: "ar", now: NOW },
  );
  assert.match(turns[2].reply, /عدّى/);
  assert.equal(turns[2].state, "START");
  assert.match(turns[3].reply, /مش صحيح/);
  assert.equal(turns[4].state, "ASK_VISITORS");
  assert.match(turns[5].reply, /من 1 لـ 10/);
  assert.match(turns[6].reply, /من 1 لـ 10/);
  assert.match(turns[7].reply, /العدد الإجمالي/);
  assert.equal(turns[8].state, "ASK_NAME");
  assert.match(turns[9].reply, /حروف بس/);
  assert.match(turns[10].reply, /حروف بس/);
  assert.equal(turns[11].state, "REVIEW_BOOKING");
});

test("a bare number is never guessed to be a date", () => {
  const { last } = converse(["hello", "5"], { lang: "en", now: NOW });
  assert.match(last.reply, /number on its own/);
  assert.equal(last.extracted.visit_date, null);
});

test("past, far-future and impossible dates are refused", () => {
  assert.match(converse(["2026-11-25"], { lang: "en", now: NOW }).last.reply, /already passed/);
  assert.match(converse(["2028-01-01"], { lang: "en", now: NOW }).last.reply, /one year ahead/);
  assert.match(converse(["31 February 2027"], { lang: "en", now: NOW }).last.reply, /isn't a valid date/);
});

test("MODIFY: change the date, the visitors, the name (value given or asked)", () => {
  const start = ["بكرة لشخصين باسم منى سيد"];

  // value in the same message
  let r = converse([...start, "غير التاريخ لبعد بكرة"], { now: NOW });
  assert.equal(r.last.extracted.visit_date, "2026-11-28");
  assert.equal(r.last.state, "REVIEW_BOOKING");
  r = converse([...start, "خليهم 4"], { now: NOW });
  assert.equal(r.last.extracted.ticket_count, 4);
  r = converse([...start, "change the name to Sara Ali"], { lang: "en", now: NOW });
  assert.equal(r.last.extracted.visitor_name, "Sara Ali");
  r = converse([...start, "اسمي كريم حسن"], { now: NOW });
  assert.equal(r.last.extracted.visitor_name, "كريم حسن");

  // asked first, answered next
  r = converse([...start, "غير التاريخ"], { now: NOW });
  assert.equal(r.last.state, "ASK_DATE");
  assert.equal(r.last.extracted.visit_date, null);
  assert.equal(r.last.extracted.ticket_count, 2);
  r = converse([...start, "غير التاريخ", "الاتنين"], { now: NOW });
  assert.equal(r.last.state, "REVIEW_BOOKING");
  assert.equal(r.last.extracted.visit_date, "2026-11-30");

  r = converse([...start, "عدل عدد الزوار", "7"], { now: NOW });
  assert.equal(r.last.extracted.ticket_count, 7);
  r = converse([...start, "change the name", "Omar Ali"], { lang: "en", now: NOW });
  assert.equal(r.last.extracted.visitor_name, "Omar Ali");

  // several fields
  r = converse([...start, "change the date and the name"], { lang: "en", now: NOW });
  assert.equal(r.last.state, "ASK_DATE");
  assert.equal(r.last.extracted.visitor_name, null);

  // "I want to change something" -> ask what
  r = converse([...start, "عايز اغير حاجة"], { now: NOW });
  assert.match(r.last.reply, /تحب تغيّر إيه/);
  assert.equal(r.last.state, "REVIEW_BOOKING");
  r = converse([...start, "no"], { lang: "en", now: NOW });
  assert.match(r.last.reply, /What would you like to change/);
});

test("MODIFY: invalid new value keeps the old one", () => {
  const r = converse(["بكرة لشخصين باسم منى سيد", "غير العدد ل 15"], { now: NOW });
  assert.equal(r.last.extracted.ticket_count, 2);
  assert.match(r.last.reply, /من 1 لـ 10/);
});

test("CONFIRM on an incomplete booking is refused politely", () => {
  const r = converse(["بكرة", "أيوه أكد"], { now: NOW });
  assert.equal(r.last.action, null);
  assert.match(r.last.reply, /لسه محتاج/);
  assert.match(r.last.reply, /كام شخص/);
  const en = converse(["tomorrow", "3", "yes"], { lang: "en", now: NOW });
  assert.equal(en.last.action, null);
  assert.match(en.last.reply, /I still need/);
  assert.match(en.last.reply, /What name/);
  assert.equal(converse(["yes confirm"], { lang: "en", now: NOW }).last.action, null);
});

test("'تمام' / 'ok' alone never confirm a booking", () => {
  for (const word of ["تمام", "ok", "okay", "ماشي"]) {
    const r = converse(["بكرة لشخصين باسم منى سيد", word], { now: NOW });
    assert.equal(r.last.action, null, word);
  }
});

test("CANCEL / start over", () => {
  let r = converse(["بكرة", "الغي الحجز"], { now: NOW });
  assert.equal(r.last.action, "reset");
  assert.equal(r.last.newConversationRequired, true);
  assert.equal(r.last.state, "CANCELLED");
  assert.doesNotMatch(r.last.reply, /تبدأي|حابة/); // neutral wording
  r = converse(["cancel this booking"], { lang: "en", now: NOW });
  assert.equal(r.last.action, null); // no draft: Egyxos asks which booking (by reference)
  assert.match(r.last.reply, /reference of the booking/);
  r = converse(["cancel"], { lang: "en", now: NOW });
  assert.equal(r.last.action, null); // a bare "cancel" with nothing in progress is still a polite no-op
  assert.match(r.last.reply, /no booking in progress/);
  r = converse(["بكرة لشخصين باسم منى سيد", "start over"], { lang: "en", now: NOW });
  assert.equal(r.last.action, "reset");
});

test("finished conversations", () => {
  const completed = { status: "completed", visit_date: "2026-11-27", visitors: 2, visitor_name: "منى سيد" };
  let r = processMessage({ message: "عايز احجز تاني", uiLanguage: "ar", draft: completed, now: NOW });
  assert.equal(r.newConversationRequired, true);
  assert.equal(r.action, null);
  assert.equal(r.save, false);
  // a repeated "yes" goes to the database, which replays the SAME booking
  r = processMessage({ message: "yes confirm", uiLanguage: "en", draft: completed, now: NOW });
  assert.equal(r.action, "confirm");
  r = processMessage({ message: "بكرة", uiLanguage: "ar", draft: { ...completed, status: "cancelled" }, now: NOW });
  assert.equal(r.newConversationRequired, true);
});

test("language: follows the page, switches on a clear message, ignores names", () => {
  // Latin-script name inside an Arabic conversation must not flip the language
  const ar = converse(["بكرة", "3", "Mona Ali"], { lang: "ar", now: NOW });
  assert.equal(ar.last.language, "ar");
  assert.match(ar.last.reply, /تمام يا Mona/);
  // Arabic name inside an English conversation
  const en = converse(["tomorrow", "3", "منى سيد"], { lang: "en", now: NOW });
  assert.equal(en.last.language, "en");
  // a clear message in the other language switches
  assert.equal(converse(["hello"], { lang: "ar", now: NOW }).last.language, "en");
});

test("nothing recognisable at the start gets the welcome, mid-way gets a gentle retry", () => {
  assert.match(converse(["blah blah"], { lang: "en", now: NOW }).last.reply, /Hello! When would you like/);
  const mid = converse(["tomorrow", "banana"], { lang: "en", now: NOW });
  assert.match(mid.last.reply, /didn't get that/);
  assert.match(mid.last.reply, /How many people/);
  assert.equal(mid.last.state, "ASK_VISITORS");
});

test("replies are never empty (except the confirm action) and never invent a reference", () => {
  const msgs = ["hi", "tomorrow", "x", "3", "??", "Sara Ali", "change the date", "banana", "Sunday", "cancel"];
  const { turns } = converse(msgs, { lang: "en", now: NOW });
  for (const t of turns) {
    assert.ok(t.reply.length > 0);
    assert.doesNotMatch(t.reply, /GEM-/);
  }
});

test("the engine is pure and deterministic", () => {
  const input = { message: "بكرة لشخصين باسم منى سيد", uiLanguage: "ar", draft: null, now: NOW };
  assert.deepEqual(processMessage(input), processMessage(input));
});

test("every suggestion chip on the page is understood", () => {
  // The chip texts defined in frontend/js/visit.js (CHIPS and CONFIRM_PHRASE).
  const draftBase = { status: "awaiting_confirmation", visit_date: "2026-11-27", visitors: 2, visitor_name: "منى سيد" };
  const run = (message, draft, lang) => processMessage({ message, uiLanguage: lang, draft, now: NOW });
  const none = null;
  assert.equal(run("I want to visit tomorrow", none, "en").extracted.visit_date, "2026-11-27");
  assert.deepEqual(
    [run("Day after tomorrow for 2 people", none, "en").extracted.visit_date, run("Day after tomorrow for 2 people", none, "en").extracted.ticket_count],
    ["2026-11-28", 2]);
  assert.equal(run("Tomorrow", none, "en").extracted.visit_date, "2026-11-27");
  assert.equal(run("In 7 days", none, "en").extracted.visit_date, "2026-12-03");
  assert.equal(run("أريد زيارة المتحف غدًا", none, "ar").extracted.visit_date, "2026-11-27");
  const both = run("بعد غد لشخصين", none, "ar");
  assert.deepEqual([both.extracted.visit_date, both.extracted.ticket_count], ["2026-11-28", 2]);
  assert.equal(run("غدًا", none, "ar").extracted.visit_date, "2026-11-27");
  assert.equal(run("بعد غد", none, "ar").extracted.visit_date, "2026-11-28");
  assert.equal(run("بعد 7 أيام", none, "ar").extracted.visit_date, "2026-12-03");

  const dated = { ...draftBase, visitors: null, visitor_name: null };
  for (const [text, lang, n] of [["Just me", "en", 1], ["2 people", "en", 2], ["4 people", "en", 4],
    ["أنا لوحدي", "ar", 1], ["شخصان", "ar", 2], ["4 أشخاص", "ar", 4]]) {
    assert.equal(run(text, dated, lang).extracted.ticket_count, n, text);
  }

  // Confirm chips (API mode): the phrase is a real confirmation; "change something" asks what.
  assert.equal(run("Yes confirm", draftBase, "en").action, "confirm");
  assert.equal(run("أيوه أكد الحجز", draftBase, "ar").action, "confirm");
  assert.match(run("Change something", draftBase, "en").reply, /What would you like to change/);
  assert.match(run("أريد التعديل", draftBase, "ar").reply, /تحب تغيّر إيه/);

  // "Show my booking summary" repeats the review without a confusion message.
  const en = run("Show my booking summary", draftBase, "en");
  assert.match(en.reply, /Here are your booking details/);
  assert.doesNotMatch(en.reply, /didn't get that/);
  const ar = run("اعرض ملخص حجزي", draftBase, "ar");
  assert.match(ar.reply, /دي تفاصيل حجزك/);
  assert.doesNotMatch(ar.reply, /مفهمتش/);
});

// ===== Cancelling a confirmed booking =====

const { extractBookingReference, detectCancelBooking, isCancelConfirmation, isCancelDecline, cancelText } = require("../backend/chatbot");
const PENDING = { reference: "GEM-424B0D9F4C" };
const run = (message, { lang = "ar", draft = null, pending = null } = {}) =>
  processMessage({ message, uiLanguage: lang, draft, now: NOW, pendingCancellation: pending });

test("booking references are found in Arabic and English sentences, in any letter case", () => {
  for (const text of [
    "عايز ألغي حجز رقم GEM-424B0D9F4C",
    "Cancel booking GEM-424B0D9F4C",
    "cancel booking gem-424b0d9f4c please",
    "الغي الحجز GEM 424B0D9F4C",
    "GEM-424B0D9F4C",
    "الغي حجز ‏GEM‑424B0D9F4C", // non-breaking hyphen and a direction mark
  ]) {
    assert.equal(extractBookingReference(text), "GEM-424B0D9F4C", text);
  }
  for (const text of ["GEM-12345", "GEM-424B0D9F4C99", "GEMS 424B0D9F4C", "I love the GEM", "", "XGEM-424B0D9F4C"]) {
    assert.equal(extractBookingReference(text), null, text);
  }
});

test("cancel-a-booking requests: the reference decides, a malformed one is explained, 'cancel' alone is not enough", () => {
  let r = run("عايز ألغي حجز رقم GEM-424B0D9F4C");
  assert.equal(r.action, "cancel_booking_lookup");
  assert.equal(r.cancelReference, "GEM-424B0D9F4C");
  r = run("Cancel booking GEM-424B0D9F4C", { lang: "en" });
  assert.equal(r.action, "cancel_booking_lookup");
  r = run("الغي حجز رقم GEM-123");
  assert.equal(r.action, null);
  assert.match(r.reply, /رقم الحجز مش مكتوب صح/);
  r = run("عايز ألغي حجزي");
  assert.equal(r.action, null);
  assert.match(r.reply, /ابعتلي رقم الحجز/);
  // not a cancellation request
  assert.equal(detectCancelBooking("عايز احجز بكره").intent, false);
  assert.equal(detectCancelBooking("I want to visit on GEM day").intent, false);
  assert.equal(detectCancelBooking("GEM-424B0D9F4C").intent, false, "a reference alone is never a cancellation");
});

test("negated cancellation requests never start a cancellation", () => {
  for (const text of ["don't cancel GEM-424B0D9F4C", "do not cancel booking GEM-424B0D9F4C", "مش عايز الغي حجز GEM-424B0D9F4C", "متلغيش GEM-424B0D9F4C"]) {
    const r = run(text, { lang: /[a-z]/i.test(text) ? "en" : "ar" });
    assert.equal(r.action, null, text);
    assert.match(r.reply, /Nothing was changed|مفيش حاجة اتغيرت/, text);
  }
});

test("an unfinished draft keeps its own 'cancel' behaviour; a reference always means the confirmed booking", () => {
  const draft = { status: "awaiting_confirmation", visit_date: "2026-11-27", visitors: 2, visitor_name: null };
  assert.equal(run("الغي الحجز", { draft }).action, "reset");
  assert.equal(run("cancel booking GEM-424B0D9F4C", { lang: "en", draft }).action, "cancel_booking_lookup");
  // a finished or cancelled conversation: "cancel my booking" asks which booking
  for (const status of ["completed", "cancelled"]) {
    const r = run("cancel my booking", { lang: "en", draft: { ...draft, status } });
    assert.match(r.reply, /reference of the booking/);
  }
});

test("only a clear yes confirms a pending cancellation", () => {
  for (const yes of ["أيوه، ألغي الحجز.", "Yes, cancel it.", "yes", "نعم", "Yes please", "confirm", "yes cancel", "ايوه الغي", "cancel it", "الغي"]) {
    assert.equal(run(yes, { pending: PENDING, lang: /[a-z]/i.test(yes) ? "en" : "ar" }).action, "cancel_booking_confirm", yes);
  }
  for (const notYes of ["ok", "تمام", "maybe", "hello", "3", "عايز احجز بكره", "yes cancel my other booking GEM-AAAAAAAAAA", "start over", "ماشي"]) {
    assert.notEqual(run(notYes, { pending: PENDING, lang: /[a-z]/i.test(notYes) ? "en" : "ar" }).action, "cancel_booking_confirm", notYes);
  }
});

test("declining, or changing their mind, keeps the booking; a decline word beats a yes", () => {
  for (const no of ["no", "لا", "غيرت رأيي", "I changed my mind", "no, don't cancel it", "yes dont cancel", "مش عايز ألغي", "keep it", "never mind", "خلاص مش عايز ألغي", "wait"]) {
    const r = run(no, { pending: PENDING, lang: /[a-z]/i.test(no) ? "en" : "ar" });
    assert.equal(r.action, "cancel_booking_decline", no);
    assert.match(r.reply, /Nothing was changed|مفيش حاجة اتغيرت/);
  }
  assert.equal(isCancelDecline("yes"), false);
  assert.equal(isCancelConfirmation("no"), false);
});

test("without a pending question a bare yes never cancels anything", () => {
  for (const text of ["yes", "أيوه", "Yes, cancel it.", "أيوه، ألغي الحجز.", "confirm", "الغي"]) {
    assert.notEqual(run(text, { lang: /[a-z]/i.test(text) ? "en" : "ar" }).action, "cancel_booking_confirm", text);
  }
});

test("while a cancellation is pending, other messages are understood normally (and the server closes the question)", () => {
  const r = run("عايز احجز بكره", { pending: PENDING });
  assert.equal(r.action, null);
  assert.equal(r.extracted.visit_date, "2026-11-27");
  assert.equal(r.cancelFlow, undefined);
  const again = run("cancel booking GEM-AAAAAAAAAA", { lang: "en", pending: PENDING });
  assert.equal(again.action, "cancel_booking_lookup");
  assert.equal(again.cancelReference, "GEM-AAAAAAAAAA");
});

test("cancellation replies exist in both languages and show only the booking's own details", () => {
  const booking = { booking_reference: "GEM-424B0D9F4C", visitor_name: "Sara Ali", visit_date: "2026-11-27", ticket_count: 3 };
  for (const lang of ["ar", "en"]) {
    for (const key of ["found", "done", "kept", "notFound", "invalidRef", "askRef", "already", "past", "expired"]) {
      const text = cancelText(key, lang, booking);
      assert.ok(text.length > 10, `${lang}/${key}`);
    }
    assert.match(cancelText("found", lang, booking), /GEM-424B0D9F4C/);
    assert.doesNotMatch(cancelText("notFound", lang, booking), /GEM-424B0D9F4C|Sara/);
  }
  assert.match(cancelText("found", "ar", booking), /لقيت الحجز بتاعك/);
  assert.match(cancelText("done", "ar", booking), /تم إلغاء الحجز بنجاح/);
  assert.match(cancelText("found", "en", booking), /I found your booking/);
  assert.match(cancelText("done", "en", booking), /Your booking has been cancelled successfully/);
});

// ===== Modifying a confirmed booking (pure engine: no database) =====

const MREF = "GEM-76026E4F29";
const mrun = (message, { lang = "en", draft = null, pending = null } = {}) =>
  processMessage({ message, uiLanguage: lang, draft, now: NOW, pendingModification: pending });
const MPENDING = { reference: MREF };

test("modify: a reference and a change become a lookup, never a draft", () => {
  const cases = [
    [`Change booking ${MREF} to 3 visitors.`, { visitors: 3 }],
    [`change ${MREF} to 4 people`, { visitors: 4 }],
    [`Move ${MREF} to 3 December`, { visit_date: "2026-12-03" }],
    [`Reschedule my reservation ${MREF} to tomorrow`, { visit_date: "2026-11-27" }],
    [`Change the name on booking ${MREF} to Sara Ali`, { visitor_name: "Sara Ali" }],
    [`change the name on booking ${MREF} to Sara Ali and the visitors to 4`, { visitors: 4, visitor_name: "Sara Ali" }],
    [`update ${MREF}: 2 visitors, date 10 December, name: Omar Hassan`, { visit_date: "2026-12-10", visitors: 2, visitor_name: "Omar Hassan" }],
    [`Make ${MREF} 5 visitors`, { visitors: 5 }],
    [`Please change the date of booking ${MREF} to 2026-12-05`, { visit_date: "2026-12-05" }],
    [`غير حجز ${MREF} ل 3 اشخاص`, { visitors: 3 }],
    [`عدل الحجز ${MREF} لـ 4 زوار`, { visitors: 4 }],
    [`غير تاريخ الحجز ${MREF} لبكره`, { visit_date: "2026-11-27" }],
    [`غير تاريخ الحجز ${MREF} لبعد 5 ايام`, { visit_date: "2026-12-01" }],
    [`غير اسم الحجز ${MREF} ل سارة علي`, { visitor_name: "سارة علي" }],
    [`خلي الحجز ${MREF} 3 اشخاص`, { visitors: 3 }],
  ];
  for (const [text, changes] of cases) {
    const r = mrun(text, { lang: /[a-z]{4}/i.test(text.replace(MREF, "")) ? "en" : "ar" });
    assert.equal(r.action, "modify_booking_lookup", text);
    assert.equal(r.modifyReference, MREF, text);
    assert.deepEqual(r.modifyChanges, changes, text);
    assert.equal(r.modifyFlow, true, text);
    assert.equal(r.save, false, text);
  }
});

test("modify: the reference's own letters and digits are never read as a date, count or name", () => {
  const r = mrun("Change GEM-12345E4F29 to 2 visitors");
  assert.deepEqual(r.modifyChanges, { visitors: 2 });
  const lower = mrun("change booking gem-76026e4f29 to 4 visitors");
  assert.equal(lower.modifyReference, MREF);
  assert.deepEqual(lower.modifyChanges, { visitors: 4 });
});

test("modify: a draft in progress is left alone", () => {
  const draft = { status: "awaiting_confirmation", visit_date: "2026-12-01", visitors: 2, visitor_name: "Nadia Fouad" };
  const r = mrun(`Change ${MREF} to 3 visitors`, { draft });
  assert.equal(r.action, "modify_booking_lookup");
  assert.equal(r.save, false);
  assert.deepEqual(r.extracted, { visit_date: "2026-12-01", ticket_count: 2, visitor_name: "Nadia Fouad" });

  // without a reference the draft logic still handles "change ..."
  const edit = mrun("غير عدد الزوار ل 4", { lang: "ar", draft });
  assert.equal(edit.modifyFlow, undefined);
  assert.equal(edit.extracted.ticket_count, 4);
  assert.equal(edit.save, true);
  const date5 = mrun("change the date to Friday", { draft });
  assert.equal(date5.modifyFlow, undefined);
  assert.equal(date5.extracted.visit_date, "2026-11-27");
});

test("modify: invalid values refuse the whole request and explain why", () => {
  const cases = [
    [`Change ${MREF} to 11 visitors`, /between 1 and 10/],
    [`Change ${MREF} to 0 visitors`, /between 1 and 10/],
    [`Change ${MREF} to 3 visitors and 4 visitors`, /more than one visitor count/],
    [`Change ${MREF} to 27 November 2030`, /one year ahead/],
    [`Change the name on ${MREF} to R2D2`, /letters only/],
    [`Change ${MREF} to 11 visitors and name Sara Ali`, /between 1 and 10/],
  ];
  for (const [text, expected] of cases) {
    const r = mrun(text);
    assert.equal(r.action, null, text);
    assert.match(r.reply, expected, text);
    assert.equal(r.modifyChanges, undefined, text);
  }
});

test("modify: no change given, no reference, bad reference, negation", () => {
  assert.match(mrun(`Change ${MREF}`).reply, /What would you like to change on booking GEM-76026E4F29/);
  assert.match(mrun("I want to modify my booking").reply, /send me the reference/);
  assert.match(mrun("عايز اغير حجزي", { lang: "ar" }).reply, /ابعتلي رقم الحجز/);
  assert.match(mrun("Change GEM-12 to 3 visitors").reply, /doesn't look right/);
  assert.match(mrun(`Don't change ${MREF}`).reply, /Nothing was changed/);
  assert.match(mrun(`مش عايز اغير الحجز ${MREF}`, { lang: "ar" }).reply, /مفيش حاجة اتغيرت/);
  for (const text of [`Don't change ${MREF}`, "Change GEM-12 to 3 visitors", "I want to modify my booking"]) {
    assert.equal(mrun(text).action, null, text);
  }
});

test("modify: ordinary booking talk is not mistaken for a modify request", () => {
  for (const text of ["make a booking for 3 people tomorrow", "book 2 tickets", "hello", "change the date to Friday", "I'd like to visit tomorrow"]) {
    const r = mrun(text);
    assert.equal(r.modifyFlow, undefined, text);
    assert.equal(r.action, null, text);
  }
});

test("modify and cancel precedence", () => {
  assert.equal(mrun(`Cancel ${MREF}`).action, "cancel_booking_lookup");
  assert.match(mrun(`Cancel ${MREF} and change it to 3 visitors`).reply, /one request at a time/);
  assert.equal(mrun(`Cancel ${MREF} and change it to 3 visitors`).action, null);
  // "don't cancel, change it" is a modification
  const r = mrun(`Don't cancel ${MREF}, change it to 3 visitors`);
  assert.equal(r.action, "modify_booking_lookup");
  assert.deepEqual(r.modifyChanges, { visitors: 3 });
  assert.equal(mrun(`Don't cancel ${MREF}`).cancelFlow, true);
});

test("modify: only the explicit yes confirms; a no declines; anything else is a normal message", () => {
  for (const text of ["yes", "Yes, confirm.", "yes confirm", "أيوه، أكد", "أيوه", "confirm"]) {
    assert.equal(mrun(text, { lang: /[a-z]/i.test(text) ? "en" : "ar", pending: MPENDING }).action, "modify_booking_confirm", text);
  }
  for (const text of ["No", "no thanks", "لا", "keep it", "I changed my mind"]) {
    const r = mrun(text, { lang: /[a-z]/i.test(text) ? "en" : "ar", pending: MPENDING });
    assert.equal(r.action, "modify_booking_decline", text);
  }
  for (const text of ["ok", "sure", "Yes, cancel it.", "maybe", "thanks", "tomorrow", "الغي"]) {
    const r = mrun(text, { lang: /[a-z]/i.test(text) ? "en" : "ar", pending: MPENDING });
    assert.notEqual(r.action, "modify_booking_confirm", text);
    assert.notEqual(r.action, "modify_booking_decline", text);
  }
  // without a pending question a "yes" never becomes a modification
  assert.notEqual(mrun("Yes, confirm.").action, "modify_booking_confirm");
  // a new request while a question is open is a new request, not an answer
  assert.equal(mrun(`Change ${MREF} to 5 visitors, keep the name`, { pending: MPENDING }).action, "modify_booking_lookup");
});

test("modify replies exist in both languages and only show what belongs to the visitor", () => {
  const current = { booking_reference: MREF, visitor_name: "Sara Ali", visit_date: "2026-11-27", ticket_count: 1 };
  const proposed = { ...current, ticket_count: 3 };
  const full = { ...current, visit_date: "2026-12-05", ticket_count: 4, visitor_name: "Mona Said" };
  for (const lang of ["ar", "en"]) {
    for (const key of ["found", "done", "kept", "same", "notFound", "cancelled", "past", "expired", "stale",
      "askRef", "askChange", "resend", "cancelOrModify", "ambiguousPending", "failed"]) {
      assert.ok(modifyText(key, lang, current, proposed).length > 10, `${lang}/${key}`);
    }
    assert.match(modifyText("found", lang, current, proposed), new RegExp(MREF));
    assert.match(modifyText("done", lang, null, proposed), new RegExp(MREF));
    assert.doesNotMatch(modifyText("notFound", lang, current), /GEM-|Sara/);
    assert.match(modifyText("found", lang, current, full), lang === "en" ? /Here is what would change/ : /دي التعديلات/);
  }
  assert.equal(
    modifyText("found", "en", current, proposed).split("\n")[0],
    `I found your booking ${MREF}. You currently have 1 visitor. Would you like to update it to 3 visitors?`,
  );
  assert.match(modifyText("done", "en", null, proposed), /Your booking has been updated successfully\. Your booking reference remains GEM-76026E4F29\./);
  assert.match(modifyText("done", "ar", null, proposed), /تم تعديل حجزك بنجاح/);
});
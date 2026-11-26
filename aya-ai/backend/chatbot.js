"use strict";

// =====================================================
// Egyxos rule-based booking chatbot (one file)
//
// Arabic (Egyptian) and English. No AI, no n8n, no network, no
// database: every function here is pure, so the whole conversation
// can be unit-tested without Supabase.
//
// Sections:
//   1. Validation   - the same rules the database enforces
//   2. Parser       - one visitor message -> structured facts
//   3. Replies      - every sentence Egyxos can say (ar / en)
//   4. Engine       - processMessage(): the conversation state machine
//
// Nothing in this file decides whether a booking is created.
// Confirmation is decided by server.js and, finally, by the
// confirm_egyxos_booking database function.
// =====================================================


// =====================================================
// 1. VALIDATION
// =====================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS_AHEAD = 365;
const MIN_VISITORS = 1;
const MAX_VISITORS = 10;

/** Today's calendar date in Cairo as "YYYY-MM-DD". `now` is injectable for tests. */
function cairoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${v.year}-${v.month}-${v.day}`;
}

function toUtcDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Add whole days to an ISO date and return an ISO date. */
function addDays(iso, days) {
  return new Date(toUtcDate(iso).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday */
function weekdayOf(iso) {
  return toUtcDate(iso).getUTCDay();
}

/** True only for a real calendar date written as YYYY-MM-DD. */
function isRealCalendarDate(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

/**
 * Checks a visit date against the booking window.
 * Returns "ok" | "invalid" | "past" | "far".
 */
function checkVisitDate(iso, now = new Date()) {
  if (!isRealCalendarDate(iso)) return "invalid";
  const today = cairoToday(now);
  if (iso < today) return "past"; // ISO dates compare correctly as strings
  if (iso > addDays(today, MAX_DAYS_AHEAD)) return "far";
  return "ok";
}

function isValidVisitorCount(n) {
  return Number.isInteger(n) && n >= MIN_VISITORS && n <= MAX_VISITORS;
}

/**
 * Same rule the server and the confirm_egyxos_booking function use:
 * letters, combining marks, spaces, . ' ’ - ; 2 to 100 characters.
 * Returns the cleaned name or null when it is not acceptable.
 */
function normalizeName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 100) return null;
  if (!/^[\p{L}\p{M}\s.'’-]+$/u.test(name)) return null;
  return name;
}

// =====================================================
// 2. PARSER
// =====================================================

// -----------------------------------------------------
// Text preparation
// -----------------------------------------------------

const DIGIT_MAP = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

/** Visible text: Unicode-normalized, Arabic digits -> ASCII, no diacritics/tatweel. */
function clean(input) {
  return String(input ?? "")
    .normalize("NFC")
    .replace(/[٠-٩۰-۹]/g, (ch) => DIGIT_MAP[ch])
    .replace(/[\u064B-\u065F\u0670\u0640\u200E\u200F\u202A-\u202E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Matching text: lower-case and Arabic letter variants merged. Same length as the input. */
function fold(text) {
  let out = "";
  for (const ch of text) {
    let c = ch;
    if ("إأآٱ".includes(c)) c = "ا";
    else if (c === "ى") c = "ي";
    else if (c === "ة") c = "ه";
    else {
      const lower = c.toLowerCase();
      if (lower.length === c.length) c = lower;
    }
    out += c;
  }
  return out;
}

/** Replace the given [start, end) spans with spaces (keeps all positions valid). */
function blank(text, spans) {
  if (!spans.length) return text;
  const chars = text.split("");
  for (const [s, e] of spans) {
    for (let i = s; i < e && i < chars.length; i += 1) chars[i] = " ";
  }
  return chars.join("");
}

/** Folded text without punctuation, as a token list. */
function tokens(input) {
  return fold(clean(input))
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

function re(source, flags = "giu") {
  return new RegExp(`${B}(?:${source})${E}`, flags);
}

function allMatches(regex, text) {
  const out = [];
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    out.push(m);
    if (m[0].length === 0) regex.lastIndex += 1;
  }
  return out;
}

const span = (m) => [m.index, m.index + m[0].length];

// -----------------------------------------------------
// Language
// -----------------------------------------------------

function detectLanguage(message, fallback = "ar") {
  const text = String(message ?? "");
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (arabic > latin) return "ar";
  if (latin > arabic) return "en";
  return fallback === "en" ? "en" : "ar";
}

// -----------------------------------------------------
// Confirmation and cancellation phrases
// (single source of truth: server.js imports these)
// -----------------------------------------------------

const AFFIRM = new Set([
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "please",
  "ايوه", "ايوا", "اه", "نعم", "تمام", "ماشي", "طبعا", "اوكي", "اوك",
  "من", "فضلك", "لو", "سمحت", "يلا",
]);
const STRONG_AFFIRM = new Set(["yes", "yeah", "yep", "yup", "ايوه", "ايوا", "اه", "نعم"]);
const CONFIRM_VERB = new Set(["confirm", "confirmed", "اكد", "اكدي", "اكده", "تاكيد", "ثبت"]);
const CONFIRM_FILL = new Set([
  "the", "my", "it", "this", "that", "booking", "reservation", "go", "ahead", "now",
  "الحجز", "حجزي", "حجز", "ده", "دا", "دي", "كده", "دلوقتي", "يا", "ريس", "باشا",
]);

/** True only for an explicit "yes, confirm" style message. */
function isConfirmation(message) {
  if (typeof message !== "string") return false;
  const t = tokens(message);
  if (t.length === 0 || t.length > 6) return false;

  const allowed = (w) =>
    AFFIRM.has(w) || CONFIRM_VERB.has(w) || CONFIRM_FILL.has(w);
  if (!t.every(allowed)) return false;

  const hasVerb = t.some((w) => CONFIRM_VERB.has(w));
  const hasGoAhead = t.includes("go") && t.includes("ahead");
  const hasStrong = t.some((w) => STRONG_AFFIRM.has(w));
  return hasVerb || hasGoAhead || hasStrong;
}

const CANCEL_VERB = new Set(["الغي", "الغيه", "الغيها", "الغاء", "cancel", "discard"]);
const CANCEL_FILL = new Set([
  "الحجز", "حجز", "حجزي", "ده", "دا", "دي", "كله", "عايز", "عايزه", "عاوز", "عاوزه",
  "من", "فضلك", "لو", "سمحت", "please", "this", "the", "my", "booking", "reservation",
  "it", "i", "want", "to", "just", "يا", "ريس",
]);

const RESTART_PATTERNS = [
  /^(?:(?:عايز|عايزه|عاوز|عاوزه|i want to|lets|let s|please|من فضلك|لو سمحت) )*(?:ابدا|نبدا|ابتدي) (?:من (?:جديد|الاول|الصفر)|تاني)$/u,
  /^(?:(?:i want to|lets|let s|please) )*(?:start (?:over|again|from scratch)|restart|reset|new booking)$/u,
  /^(?:(?:عايز|عايزه|عاوز|عاوزه) )?حجز جديد$/u,
  /^(?:never ?mind|forget it|خلاص مش عايز|مش عايز احجز|مش عايزه احجز|خلاص مش عايزه)$/u,
];

/** True for an explicit "cancel / start over" message. */
function isCancel(message) {
  if (typeof message !== "string") return false;
  const t = tokens(message);
  if (t.length === 0 || t.length > 8) return false;

  if (t.some((w) => CANCEL_VERB.has(w)) &&
      t.every((w) => CANCEL_VERB.has(w) || CANCEL_FILL.has(w))) {
    return true;
  }
  const joined = t.join(" ");
  return RESTART_PATTERNS.some((r) => r.test(joined));
}

// -----------------------------------------------------
// Cancelling an already CONFIRMED booking
//
// This is a different operation from cancelling an unfinished draft
// (isCancel above). It needs the booking reference, and nothing is
// cancelled until the visitor answers an explicit question.
// -----------------------------------------------------

const REFERENCE_RE = /(?<![A-Za-z0-9])GEM[-\u2010-\u2015\s]?([A-Za-z0-9]{10})(?![A-Za-z0-9])/i;
const REFERENCE_ATTEMPT_RE = /(?<![A-Za-z0-9])GEM[-\u2010-\u2015]\S*/i;

/** "GEM-424B0D9F4C" found in the message, upper-cased, or null. */
function extractBookingReference(message) {
  const m = REFERENCE_RE.exec(clean(message));
  return m ? `GEM-${m[1].toUpperCase()}` : null;
}

const CANCEL_BOOKING_VERB_RE = re(
  "الغي|الغيه|الغيها|الغيلي|الغاء|لغي|لغيلي|كنسل|كانسل|تلغي|تلغيه|تلغيها|متلغيش|ماتلغيش|cancel|cancelling|cancellation",
);
const BOOKING_NOUN_RE = re("حجز|حجزي|الحجز|حجوزاتي|حجزى|booking|bookings|reservation|ticket|tickets");
const NEGATION_RE = /(?:^|\s)(?:مش|لا|ما|متلغيش|ماتلغيش|dont|don t|do not|never|not)(?:\s|$)/u;

/**
 * Does this message ask to cancel a confirmed booking?
 * { intent, reference, referenceInvalid, mentionsBooking }
 */
function detectCancelBooking(message) {
  const none = { intent: false, negated: false, reference: null, referenceInvalid: false, mentionsBooking: false };
  if (typeof message !== "string") return none;
  const text = fold(clean(message)).replace(/[^\p{L}\p{N}\s-]/gu, " ");
  if (!allMatches(CANCEL_BOOKING_VERB_RE, text).length) return none;
  // "don't cancel GEM-...", "مش عايز الغي": nothing is cancelled
  if (NEGATION_RE.test(text.replace(/-/g, " "))) {
    return { ...none, negated: Boolean(extractBookingReference(message)) };
  }

  const reference = extractBookingReference(message);
  const referenceInvalid = !reference && REFERENCE_ATTEMPT_RE.test(clean(message));
  const mentionsBooking = allMatches(BOOKING_NOUN_RE, text).length > 0;
  return {
    intent: Boolean(reference || referenceInvalid || mentionsBooking),
    negated: false,
    reference,
    referenceInvalid,
    mentionsBooking,
  };
}

const DECLINE_WORDS = new Set([
  "no", "nope", "nah", "لا", "لأ", "لاء", "مش", "ما", "متلغيش", "ماتلغيش", "dont", "don", "never",
  "keep", "stop", "leave", "changed", "wait", "غيرت", "خليه", "خليها", "سيبه", "سيبها", "ابقيه",
  "استني", "استنى", "خلاص",
]);

/** Answer "no" to "do you want to cancel?" (also "I changed my mind"). */
function isCancelDecline(message) {
  if (typeof message !== "string") return false;
  const t = tokens(message);
  if (t.length === 0 || t.length > 10) return false;
  return t.some((w) => DECLINE_WORDS.has(w));
}

/**
 * Answer "yes" to "do you want to cancel?": "yes", "Yes, cancel it",
 * "أيوه، ألغي الحجز". Only used while the server holds a pending
 * cancellation for this user and conversation. Any decline word wins.
 */
function isCancelConfirmation(message) {
  if (typeof message !== "string") return false;
  const t = tokens(message);
  if (t.length === 0 || t.length > 8) return false;
  if (t.some((w) => DECLINE_WORDS.has(w))) return false;

  const allowed = (w) =>
    AFFIRM.has(w) || CONFIRM_VERB.has(w) || CONFIRM_FILL.has(w) ||
    CANCEL_VERB.has(w) || CANCEL_FILL.has(w);
  if (!t.every(allowed)) return false;

  return t.some((w) => STRONG_AFFIRM.has(w) || CONFIRM_VERB.has(w) || CANCEL_VERB.has(w));
}

// -----------------------------------------------------
// Modifying an already CONFIRMED booking
//
// A different operation from editing an unfinished draft ("change the
// date" while the summary is on screen). It needs the booking reference
// in the same message, and nothing is changed until the visitor answers
// an explicit question. This block only READS the message; the server
// looks the booking up and the database function applies the change.
// -----------------------------------------------------

const MODIFY_STRONG_VERBS =
  "غير|غيري|اغير|اغيره|اغيرها|(?:ال)?تغيير|عدل|عدلي|اعدل|اعدله|اعدلها|(?:ال)?تعديل|بدل|بدلي|ابدل|" +
  "change|changing|edit|modify|update|amend|correct|switch|reschedule|move|postpone";
// "make GEM-... 3 visitors" / "خلي الحجز ... 3 اشخاص": only with a reference.
const MODIFY_WEAK_VERBS = "make|set|خلي|خليه|خليها|خليهم";

const MODIFY_STRONG_RE = re(MODIFY_STRONG_VERBS);
const MODIFY_WEAK_RE = re(MODIFY_WEAK_VERBS);
// "don't change GEM-...", "مش عايز اغير", "متغيرش"
const MODIFY_NEGATED_RE = new RegExp(
  `${B}(?:dont|don t|do not|never|not|مش|لا|ما)\\s+(?:(?:want|wanna|need|like|عايز|عاوز|عايزه|عاوزه|محتاج)\\s+)*(?:to\\s+|ان\\s+)?(?:${MODIFY_STRONG_VERBS})${E}` +
    `|${B}(?:متغيرش|ماتغيرش|متعدلش|ماتعدلش|متبدلش|ماتبدلش)${E}`,
  "iu",
);

const REFERENCE_PHRASE_RE = new RegExp(
  `(?:${B}(?:on|of|for|in|في|على|بتاع|بتاعت|بتاعه)\\s+)?` +
    `(?:${B}(?:the|my)\\s+)?` +
    `(?:${B}(?:booking|reservation|الحجز|حجزي|حجز)\\s*(?:(?:reference|ref|number|no|id|code|رقم|كود)\\s*)?[:#-]?\\s*)?` +
    REFERENCE_RE.source,
  "giu",
);

/** The message with the booking reference (and "booking number"-style words around it) removed. */
function withoutReference(message) {
  return clean(message).replace(REFERENCE_PHRASE_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Does this message ask to modify a confirmed booking?
 * { intent, negated, reference, referenceInvalid, mentionsBooking, hasVerb }
 */
function detectModifyBooking(message) {
  const none = {
    intent: false, negated: false, reference: null,
    referenceInvalid: false, mentionsBooking: false, hasVerb: false,
  };
  if (typeof message !== "string") return none;

  const reference = extractBookingReference(message);
  const referenceInvalid = !reference && REFERENCE_ATTEMPT_RE.test(clean(message));
  const text = fold(withoutReference(message)).replace(/[^\p{L}\p{N}\s-]/gu, " ");

  const strong = allMatches(MODIFY_STRONG_RE, text).length > 0;
  const weak = allMatches(MODIFY_WEAK_RE, text).length > 0;
  const hasVerb = strong || ((reference || referenceInvalid) && weak);
  if (!hasVerb) return none;

  const mentionsBooking = allMatches(BOOKING_NOUN_RE, text).length > 0;
  const negated = MODIFY_NEGATED_RE.test(text);
  return {
    intent: Boolean(reference || referenceInvalid || mentionsBooking),
    negated,
    reference,
    referenceInvalid,
    mentionsBooking,
    hasVerb,
  };
}

/**
 * The changes asked for in a modify message, read with the reference
 * removed (so its letters and digits are never taken for a date or a count).
 * { changes: { visit_date?, visitors?, visitor_name? }, problems: [key...] }
 * Nothing is applied here; any problem means the whole request is refused.
 */
function parseBookingChanges(message, now = new Date()) {
  const p = parseMessage(withoutReference(message), now);
  const changes = {};
  const problems = [];

  if (p.date.status === "ok") changes.visit_date = p.date.value;
  else if (p.date.status === "error") {
    problems.push(p.date.reason === "past" ? "pastDate" : p.date.reason === "far" ? "farDate" : "invalidDate");
  } else if (p.date.status === "ambiguous") problems.push("severalDates");

  if (p.count.status === "ok") changes.visitors = p.count.value;
  else if (p.count.status === "error") problems.push("badVisitors");
  else if (p.count.status === "ambiguous") {
    problems.push(p.count.reason === "group" ? "groupVisitors" : "severalCounts");
  }

  if (p.name.status === "ok") changes.visitor_name = p.name.value;
  else if (p.name.status === "error") problems.push("badName");

  return { changes, problems };
}

// -----------------------------------------------------
// Greeting, booking request, "no"
// -----------------------------------------------------

const GREETING_RE =
  /^(?:hi|hello|hey|hiya|good (?:morning|evening|afternoon)|مرحبا|مرحبتين|اهلا(?: وسهلا)?|هلا|هاي|السلام عليكم(?: ورحمه الله(?: وبركاته)?)?|صباح الخير|مساء الخير|ازيك|ازيكم|عامل ايه|سلام)(?: (?:egyxos|ايجزوس|يا ايجزوس))?$/u;

function isGreeting(message) {
  return GREETING_RE.test(tokens(message).join(" "));
}

const BOOKING_WORDS = new Set([
  "احجز", "احجزلي", "حجز", "زياره", "تذكره", "تذاكر", "book", "booking", "reserve",
  "reservation", "visit", "ticket", "tickets",
]);

function hasBookingIntent(message) {
  return tokens(message).some((w) => BOOKING_WORDS.has(w));
}

const SUMMARY_WORDS = new Set([
  "summary", "details", "show", "ملخص", "تفاصيل", "اعرض", "عرض",
]);

/** "Show my booking summary" / "اعرض ملخص حجزي" */
function isSummaryRequest(message) {
  const t = tokens(message);
  return t.length > 0 && t.length <= 8 && t.some((w) => SUMMARY_WORDS.has(w));
}

function isNegative(message) {
  const joined = tokens(message).join(" ");
  return /^(?:لا|لأ|لاء|no|nope|nah|not yet|مش كده|مش دلوقتي)$/u.test(joined);
}

// -----------------------------------------------------
// Change requests ("change the date", "غير الاسم")
// -----------------------------------------------------

const MODIFY_VERB_RE = re(
  "غير|غيري|اغير|اغيره|(?:ال)?تغيير|عدل|عدلي|اعدل|اعدله|(?:ال)?تعديل|بدل|بدلي|ابدل|change|edit|modify|update|amend|correct|fix|switch",
);
const FIELD_WORDS = {
  date: "(?:ال)?(?:تاريخ|ميعاد|موعد|يوم)|date|day",
  visitors: "(?:ال)?(?:عدد|زوار|اشخاص|افراد|ناس|تذاكر)|people|visitors|guests|number|count|tickets",
  name: "(?:ال)?اسم|name",
};

function detectModify(lower) {
  const verbs = allMatches(MODIFY_VERB_RE, lower);
  if (verbs.length === 0) return { intent: false, fields: new Set() };
  const fields = new Set();
  for (const [field, source] of Object.entries(FIELD_WORDS)) {
    if (allMatches(re(source), lower).length) fields.add(field);
  }
  return { intent: true, fields };
}

// -----------------------------------------------------
// Dates
// -----------------------------------------------------

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  "يناير": 1, "فبراير": 2, "مارس": 3, "ابريل": 4, "مايو": 5, "ماي": 5,
  "يونيو": 6, "يونيه": 6, "يوليو": 7, "يوليه": 7, "اغسطس": 8,
  "سبتمبر": 9, "اكتوبر": 10, "نوفمبر": 11, "ديسمبر": 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  "احد": 0, "اثنين": 1, "اتنين": 1, "ثلاثاء": 2, "تلات": 2, "تلاتاء": 2,
  "اربعاء": 3, "اربع": 3, "اربعا": 3, "خميس": 4, "جمعه": 5, "سبت": 6,
};
const EN_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const AR_WEEKDAYS = Object.keys(WEEKDAYS).filter((k) => !EN_WEEKDAYS.includes(k)).join("|");

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Year-less date (e.g. "27 نوفمبر"): the next time that day comes around. */
function resolveYearless(month, day, today) {
  const startYear = Number(today.slice(0, 4));
  let sawReal = false;
  for (let y = startYear; y <= startYear + 4; y += 1) {
    const iso = isoOf(y, month, day);
    if (!isRealCalendarDate(iso)) continue;
    sawReal = true;
    if (iso >= today) return iso;
  }
  return sawReal ? null : "INVALID";
}

/**
 * Finds a visit date in the text.
 * status: "none" | "ok" | "error" (reason: invalid|past|far) | "ambiguous"
 */
function parseDate(lower, now = new Date(), options = {}) {
  const today = cairoToday(now);
  const found = []; // { start, end, iso|null }

  const push = (m, iso) => found.push({ span: span(m), iso });

  // 2026-11-27
  for (const m of allMatches(/(?<![\d.\/-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d.\/-])/g, lower)) {
    const iso = isoOf(m[1], Number(m[2]), Number(m[3]));
    push(m, isRealCalendarDate(iso) ? iso : null);
  }
  // 2026/11/27
  for (const m of allMatches(/(?<![\d.\/-])(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})(?![\d.\/-])/g, lower)) {
    const iso = isoOf(m[1], Number(m[2]), Number(m[3]));
    push(m, isRealCalendarDate(iso) ? iso : null);
  }
  // 27/11/2026, 27-11-2026, 27.11.2026  (day first, as in Egypt)
  for (const m of allMatches(/(?<![\d.\/-])(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?![\d.\/-])/g, lower)) {
    const iso = isoOf(m[3], Number(m[2]), Number(m[1]));
    push(m, isRealCalendarDate(iso) ? iso : null);
  }
  // 27/11  (day first, no year)
  for (const m of allMatches(/(?<![\d.\/-])(\d{1,2})\/(\d{1,2})(?![\d.\/-])/g, lower)) {
    const month = Number(m[2]);
    const day = Number(m[1]);
    if (month < 1 || month > 12) { push(m, null); continue; }
    const iso = resolveYearless(month, day, today);
    push(m, iso === "INVALID" ? null : iso || "PAST");
  }
  // 27 نوفمبر [2026]   /   27th of November
  const dayMonth = new RegExp(
    `${B}(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+|من\\s+|شهر\\s+)?(${MONTH_ALT})(?:\\s*,?\\s*(\\d{4}))?${E}`,
    "giu",
  );
  for (const m of allMatches(dayMonth, lower)) {
    const month = MONTHS[m[2]];
    const day = Number(m[1]);
    if (m[3]) {
      const iso = isoOf(m[3], month, day);
      push(m, isRealCalendarDate(iso) ? iso : null);
    } else {
      const iso = resolveYearless(month, day, today);
      push(m, iso === "INVALID" ? null : iso || "PAST");
    }
  }
  // November 27 [2026]
  const monthDay = new RegExp(
    `${B}(${MONTH_ALT})\\s*(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?${E}`,
    "giu",
  );
  for (const m of allMatches(monthDay, lower)) {
    const month = MONTHS[m[1]];
    const day = Number(m[2]);
    if (m[3]) {
      const iso = isoOf(m[3], month, day);
      push(m, isRealCalendarDate(iso) ? iso : null);
    } else {
      const iso = resolveYearless(month, day, today);
      push(m, iso === "INVALID" ? null : iso || "PAST");
    }
  }

  // day after tomorrow / tomorrow / today
  for (const m of allMatches(re("[لو]?(?:بعد\\s+(?:بكره|بكرا|غد|غدا)|day\\s+after\\s+(?:tomorrow|tmrw)|overmorrow)"), lower)) {
    push(m, addDays(today, 2));
  }
  for (const m of allMatches(re("[لو]?(?:بكره|بكرا|غدا|غد|tomorrow|tmrw|tomorow)"), lower)) {
    push(m, addDays(today, 1));
  }
  const todaySource = options.skipToday
    ? "[لو]?(?:النهارده|انهارده|النهاردا|النهارضه|today)"
    : "[لو]?(?:النهارده|انهارده|النهاردا|النهارضه|اليوم|today)";
  for (const m of allMatches(re(todaySource), lower)) {
    push(m, today);
  }
  // in 3 days / بعد 3 ايام / بعد يومين / in a week / بعد اسبوع
  for (const m of allMatches(re("(?:in|after)\\s+(\\d{1,3})\\s+days?|[لو]?بعد\\s+(\\d{1,3})\\s+(?:ايام|يوم)"), lower)) {
    push(m, addDays(today, Number(m[1] ?? m[2])));
  }
  for (const m of allMatches(re("[لو]?بعد\\s+يومين"), lower)) push(m, addDays(today, 2));
  for (const m of allMatches(re("in\\s+a\\s+week|[لو]?بعد\\s+اسبوع"), lower)) push(m, addDays(today, 7));

  // Friday / next Friday / يوم الجمعة / الجمعة الجاية  -> first such day AFTER today
  const weekday = new RegExp(
    `${B}(?:(?:next|this|coming)\\s+)?(?:ل?يوم\\s+)?(?:(${EN_WEEKDAYS.join("|")})|(?:ال|لل)(${AR_WEEKDAYS}))(?:\\s+(?:الجاي|الجايه|القادم|القادمه|دي|ده))?${E}`,
    "giu",
  );
  for (const m of allMatches(weekday, lower)) {
    const wd = WEEKDAYS[m[1] ?? m[2]];
    let delta = (wd - weekdayOf(today) + 7) % 7;
    if (delta === 0) delta = 7;
    push(m, addDays(today, delta));
  }

  if (found.length === 0) return { status: "none", spans: [] };

  // Keep non-overlapping matches, longest first.
  found.sort((a, b) => a.span[0] - b.span[0] || (b.span[1] - b.span[0]) - (a.span[1] - a.span[0]));
  const kept = [];
  for (const f of found) {
    const last = kept[kept.length - 1];
    if (last && f.span[0] < last.span[1]) continue;
    kept.push(f);
  }
  const spans = kept.map((k) => k.span);

  const isos = kept.map((k) => k.iso);
  const distinct = new Set(isos);
  if (distinct.size > 1) return { status: "ambiguous", reason: "several", spans };

  const only = isos[0];
  if (only === null) return { status: "error", reason: "invalid", spans };
  if (only === "PAST") return { status: "error", reason: "past", spans };

  const range = checkVisitDate(only, now);
  if (range !== "ok") return { status: "error", reason: range, spans };
  return { status: "ok", value: only, spans };
}

// -----------------------------------------------------
// Visitor counts
// -----------------------------------------------------

const NUMBER_WORDS = {
  "واحد": 1, "واحده": 1, one: 1,
  "اتنين": 2, "اثنين": 2, "اثنان": 2, two: 2,
  "تلاته": 3, "ثلاثه": 3, "تلات": 3, "ثلاث": 3, three: 3,
  "اربعه": 4, "اربع": 4, four: 4,
  "خمسه": 5, "خمس": 5, five: 5,
  "سته": 6, "ست": 6, six: 6,
  "سبعه": 7, "سبع": 7, seven: 7,
  "تمانيه": 8, "ثمانيه": 8, "تمن": 8, "ثمان": 8, eight: 8,
  "تسعه": 9, "تسع": 9, nine: 9,
  "عشره": 10, "عشر": 10, ten: 10,
};
const NUM_ALT = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|");
const NUM_ALT_FOR_LAM = Object.keys(NUMBER_WORDS).filter((w) => w !== "ست").sort((a, b) => b.length - a.length).join("|");
const UNITS =
  "اشخاص|شخص|زوار|زائر|افراد|فرد|ناس|تذاكر|تذكره|نفر|people|persons?|visitors?|guests?|tickets?|adults?|pax";
const DUALS = "شخصين|فردين|زائرين|تذكرتين|نفرين|شخصان|فردان";
const CHILD_WORDS = re("اطفال|طفل|اولاد|عيال|ولاد|kids?|child|children");

function numberFromToken(raw) {
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return NUMBER_WORDS[raw];
}

/**
 * Finds a visitor count in the text.
 * status: "none" | "ok" | "error" (reason: range) | "ambiguous"
 * options.loose: also accept one stand-alone number (used after "change the number").
 */
function parseCount(lower, options = {}) {
  const found = []; // { span, value }
  // A number written with a sign ("-3 people") is never a valid count.
  const push = (m, value) =>
    found.push({ span: span(m), value: /[-+]/.test(lower[m.index - 1] ?? "") ? NaN : value });

  // "3 people", "3 اشخاص", "3 x visitors"
  const numUnit = new RegExp(
    `${B}[لوب]?(\\d+(?:\\.\\d+)?)\\s*(?:x\\s*)?(?:${UNITS})${E}`, "giu");
  for (const m of allMatches(numUnit, lower)) push(m, Number(m[1]));

  // "three people", "تلاته اشخاص"
  const wordUnit = new RegExp(`${B}[لوب]?(${NUM_ALT})\\s+(?:ال)?(?:${UNITS})${E}`, "giu");
  for (const m of allMatches(wordUnit, lower)) push(m, NUMBER_WORDS[m[1]]);

  // "شخصين", "فردين"
  for (const m of allMatches(re(`[لوب]?(?:${DUALS})`), lower)) push(m, 2);

  // "شخص واحد", "visitors: 3", "عدد الزوار 3", "number of people 4"
  for (const m of allMatches(re(`(?:ال)?(?:${UNITS})\\s+(?:واحد|واحده)`), lower)) push(m, 1);
  const unitNum = new RegExp(
    `${B}(?:عدد\\s+|number\\s+of\\s+)?(?:ال)?(?:${UNITS})\\s*[:=-]?\\s*(\\d{1,3})(?!\\d)`, "giu");
  for (const m of allMatches(unitNum, lower)) push(m, Number(m[1]));

  // "just me", "لوحدي", "أنا بس"
  for (const m of allMatches(
    re("just\\s+me|only\\s+me|me\\s+only|myself|by\\s+myself|alone|on\\s+my\\s+own|انا\\s+بس|بس\\s+انا|انا\\s+لوحدي|انا\\s+فقط|لوحدي"),
    lower,
  )) push(m, 1);

  // "for 3", "for two", "لـ 3", "خليهم 4", "make it 4", "to 4"
  for (const m of allMatches(re("for\\s+(\\d{1,3})"), lower)) push(m, Number(m[1]));
  for (const m of allMatches(re(`for\\s+(${NUM_ALT})`), lower)) push(m, NUMBER_WORDS[m[1]]);
  for (const m of allMatches(re("ل\\s*(\\d{1,3})"), lower)) push(m, Number(m[1]));
  for (const m of allMatches(re(`ل(${NUM_ALT_FOR_LAM})`), lower)) push(m, NUMBER_WORDS[m[1]]);
  for (const m of allMatches(
    re("(?:خليهم|خليه|خليها|خلي|make\\s+(?:it|that|them)|set\\s+(?:it\\s+)?to|to)\\s+(\\d{1,3})"),
    lower,
  )) push(m, Number(m[1]));

  // After "change the number", accept one stand-alone number.
  if (options.loose && found.length === 0) {
    const loose = allMatches(/(?<![\p{L}\p{N}.\/-])(\d{1,3})(?![\p{L}\p{N}.\/-])/gu, lower);
    if (loose.length === 1) push(loose[0], Number(loose[0][1]));
  }

  const hasChildWords = allMatches(CHILD_WORDS, lower).length > 0;

  if (found.length === 0) {
    return hasChildWords
      ? { status: "ambiguous", reason: "group", spans: [] }
      : { status: "none", spans: [] };
  }

  // Keep non-overlapping matches, longest first.
  found.sort((a, b) => a.span[0] - b.span[0] || (b.span[1] - b.span[0]) - (a.span[1] - a.span[0]));
  const kept = [];
  for (const f of found) {
    const last = kept[kept.length - 1];
    if (last && f.span[0] < last.span[1]) continue;
    kept.push(f);
  }
  const spans = kept.map((k) => k.span);

  if (hasChildWords) return { status: "ambiguous", reason: "group", spans };

  const values = new Set(kept.map((k) => k.value));
  if (values.size > 1) return { status: "ambiguous", reason: "several", spans };

  const value = kept[0].value;
  if (!isValidVisitorCount(value)) return { status: "error", reason: "range", spans };
  return { status: "ok", value, spans };
}

/** A message that is only a number (or number word): "3", "تلاتة", "ten". */
function parseBareCount(text) {
  // Only sentence punctuation around the number is ignored; a sign is not.
  const t = fold(clean(text)).replace(/^[\s.!?؟،,]+|[\s.!?؟،,]+$/gu, "").replace(/\s+/g, " ");
  if (!t) return { status: "none" };
  if (/^[-+−]\s*\d/.test(t)) return { status: "error", reason: "range" };
  if (/^\d+(?:\.\d+)?$/.test(t)) {
    const value = Number(t);
    return isValidVisitorCount(value)
      ? { status: "ok", value }
      : { status: "error", reason: "range" };
  }
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, t)) {
    return { status: "ok", value: NUMBER_WORDS[t] };
  }
  return { status: "none" };
}

// -----------------------------------------------------
// Names
// -----------------------------------------------------

const NAME_LEAD_IN = [
  // Arabic
  "(?:الحجز\\s+)?(?:باسم|بأسم|على\\s+اسم|علي\\s+اسم)",
  "(?:ال)?اسمي|(?:ال)?اسمى|(?:ال)?اسم(?:\\s+هو)?",
  // English
  "my\\s+name\\s+is|name\\s+is|name\\s*:",
  "under\\s+the\\s+name(?:\\s+of)?|in\\s+the\\s+name\\s+of|under",
  "call\\s+me|i\\s+am|i['’]?m",
  "(?:book(?:ing)?|reserve|reservation)\\s+for",
].join("|");
const NAME_LEAD_RE = new RegExp(`${B}(?:${NAME_LEAD_IN})${E}`, "giu");
// After "change ...", the bare word "name" also introduces the new name
// ("change the name to Sara Ali").
const NAME_FIELD_LEAD_RE = new RegExp(`${B}(?:${NAME_LEAD_IN}|name(?:\\s+to)?)${E}`, "giu");

const NAME_DENY = new Set([
  "yes", "no", "ok", "okay", "confirm", "cancel", "hi", "hello", "hey", "thanks", "thank",
  "you", "please", "book", "booking", "reserve", "change", "edit", "modify", "me", "myself",
  "my", "we", "us", "i", "date", "visitors", "people", "name", "today", "tomorrow",
  "نعم", "لا", "ايوه", "ايوا", "اه", "تمام", "اكد", "الغي", "مرحبا", "اهلا", "شكرا", "عايز",
  "عايزه", "عاوز", "احجز", "حجز", "غير", "عدل", "ليه", "ايه", "ازاي", "مش", "بس", "خلاص",
  "يلا", "انا", "الاسم", "التاريخ", "العدد",
]);

const TRAILING_CONNECTOR_RE = /(?:\s+(?:و|and|on|at|in|for|ل|في|يوم))+$/iu;

// "Sara Ali and the visitors to 4": the name ends where another field starts.
const NAME_FIELD_BREAK_RE = new RegExp(
  `\\s+(?:and|&)\\s+(?:also\\s+)?(?:the\\s+)?(?:date|day|visitors?|people|number|count|tickets?|name)${E}` +
    `|\\s+و\\s*(?:ال)?(?:تاريخ|ميعاد|موعد|يوم|عدد|زوار|اسم)${E}`,
  "iu",
);

function cleanNameCandidate(raw) {
  let s = raw.split(/[,،;\n]/u)[0];
  const brk = NAME_FIELD_BREAK_RE.exec(s);
  if (brk) s = s.slice(0, brk.index);
  s = s.replace(/^[\s:\-–"'“”‘’]+|[\s.!?؟"'“”‘’]+$/gu, "");
  s = s.replace(/^(?:to|الى|إلى|ل)\s+/iu, ""); // "change the name to Sara"
  s = s.replace(TRAILING_CONNECTOR_RE, "");
  return s.trim();
}

/** Validates a name candidate. Returns { status: "ok", value } or { status: "error" }. */
function validateNameCandidate(raw) {
  const candidate = cleanNameCandidate(raw);
  if (!candidate) return { status: "none" };
  const words = fold(candidate).split(/\s+/);
  if (words.length > 6) return { status: "error", reason: "invalid" };
  if (words.some((w) => NAME_DENY.has(w.replace(/[^\p{L}]/gu, "")))) {
    return { status: "error", reason: "invalid" };
  }
  const name = normalizeName(candidate);
  return name ? { status: "ok", value: name } : { status: "error", reason: "invalid" };
}

/** A name written after a lead-in such as "اسمي ..." / "my name is ...". */
function parseExplicitName(blankedText, { afterChange = false } = {}) {
  const lower = fold(blankedText);
  const matches = allMatches(afterChange ? NAME_FIELD_LEAD_RE : NAME_LEAD_RE, lower);
  if (matches.length === 0) return { status: "none" };
  const last = matches[matches.length - 1];
  const tail = blankedText.slice(last.index + last[0].length);
  return validateNameCandidate(tail);
}

/** A message that is only a name (used when Egyxos has just asked for it). */
function parseBareName(text) {
  const raw = clean(text);
  if (!raw || /[?؟]/.test(raw)) return { status: "none" };
  if (isGreeting(raw) || isNegative(raw) || isConfirmation(raw) || isCancel(raw)) {
    return { status: "none" };
  }
  const result = validateNameCandidate(raw);
  return result;
}

// -----------------------------------------------------
// One-stop parse of a whole message
// -----------------------------------------------------

function parseMessage(message, now = new Date()) {
  const text = clean(message);
  const lower = fold(text);
  const modify = detectModify(lower);

  const date = parseDate(lower, now, { skipToday: modify.intent });
  let spans = [...date.spans];

  const afterDate = blank(lower, spans);
  const count = parseCount(afterDate, { loose: modify.intent && modify.fields.has("visitors") });
  spans = spans.concat(count.spans);

  const name = parseExplicitName(blank(text, spans), {
    afterChange: modify.intent && modify.fields.has("name"),
  });

  const consumed = date.status !== "none" || count.status !== "none" || name.status !== "none";

  return {
    text,
    lower,
    consumed,
    greeting: isGreeting(text),
    bookingIntent: hasBookingIntent(text),
    negative: isNegative(text),
    summary: isSummaryRequest(text),
    confirm: isConfirmation(text),
    cancel: isCancel(text),
    modify,
    date,
    count,
    name,
  };
}

// =====================================================
// 3. REPLIES
// =====================================================

const AR_MONTH_NAMES = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];
const AR_WEEKDAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const EN_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const EN_WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "2026-11-27" -> "الجمعة 27 نوفمبر 2026" / "Friday, 27 November 2026" */
function formatDate(iso, lang) {
  const [y, m, d] = iso.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return lang === "en"
    ? `${EN_WEEKDAY_NAMES[weekday]}, ${d} ${EN_MONTH_NAMES[m - 1]} ${y}`
    : `${AR_WEEKDAY_NAMES[weekday]} ${d} ${AR_MONTH_NAMES[m - 1]} ${y}`;
}

const firstName = (name) => String(name).split(" ")[0];

const DATE_HINT = {
  ar: "اكتب مثلًا: بكرة، الجمعة الجاية، أو 27 نوفمبر.",
  en: "For example: tomorrow, next Friday, or 27 November.",
};

// Each question has an optional friendly lead-in ("Great!") that is dropped
// when the reply already starts with an explanation.
const ASK = {
  date: {
    ar: { lead: "", q: `تحب تزور المتحف إمتى؟ ${DATE_HINT.ar}` },
    en: { lead: "", q: `When would you like to visit the museum? ${DATE_HINT.en}` },
  },
  visitors: {
    ar: { lead: "تمام! ", q: "كام شخص هيزور المتحف؟ (من 1 لـ 10)" },
    en: { lead: "Great! ", q: "How many people will visit the museum? (1 to 10)" },
  },
  name: {
    ar: { lead: "حلو! ", q: "الحجز هيكون باسم مين؟" },
    en: { lead: "Nice! ", q: "What name should the booking be under?" },
  },
};

const TEXT = {
  // The booking page already shows its own greeting from Egyxos, so this
  // only has to move the conversation on.
  welcome: {
    ar: `أهلًا بيك! ${ASK.date.ar.q}`,
    en: `Hello! ${ASK.date.en.q}`,
  },
  unknown: {
    ar: "معلش، مفهمتش قصدك. ",
    en: "Sorry, I didn't get that. ",
  },
  pastDate: {
    ar: "التاريخ ده عدّى. اختار تاريخ من النهارده وطالع. ",
    en: "That date has already passed. Please choose today or a later date. ",
  },
  farDate: {
    ar: "ممكن تحجز لحد سنة قدام بس. اختار تاريخ أقرب. ",
    en: "You can book up to one year ahead. Please choose an earlier date. ",
  },
  invalidDate: {
    ar: "التاريخ ده مش صحيح. ",
    en: "That isn't a valid date. ",
  },
  severalDates: {
    ar: "لقيت أكتر من تاريخ في رسالتك. ",
    en: "I found more than one date in your message. ",
  },
  dateNeedsMore: {
    ar: "الرقم ده لوحده مش كفاية أفهم منه التاريخ. ",
    en: "A number on its own isn't enough for me to tell the date. ",
  },
  badVisitors: {
    ar: "عدد الزوار لازم يكون من 1 لـ 10. ",
    en: "The number of visitors must be between 1 and 10. ",
  },
  groupVisitors: {
    ar: "قولي العدد الإجمالي للزوار (بالأطفال) كرقم واحد من 1 لـ 10. ",
    en: "Please tell me the total number of visitors, children included, as one number from 1 to 10. ",
  },
  severalCounts: {
    ar: "لقيت أكتر من رقم لعدد الزوار. ",
    en: "I found more than one visitor count. ",
  },
  badName: {
    ar: "الاسم لازم يكون حروف بس (من 2 لـ 100 حرف) من غير أرقام أو رموز. ",
    en: "The name should use letters only (2 to 100 characters), with no numbers or symbols. ",
  },
  whatToChange: {
    ar: "تحب تغيّر إيه؟ التاريخ، عدد الزوار، ولا الاسم؟",
    en: "What would you like to change: the date, the number of visitors, or the name?",
  },
  notReady: {
    ar: "لسه محتاج شوية بيانات قبل ما أأكد الحجز. ",
    en: "I still need a few details before I can confirm the booking. ",
  },
  nothingToCancel: {
    ar: "مفيش حجز شغال أقدر ألغيه دلوقتي. لو عايز تبدأ حجز جديد، قولي تحب تزور المتحف إمتى.",
    en: "There's no booking in progress to cancel. To start a new one, tell me when you'd like to visit.",
  },
  cancelled: {
    ar: "تمام، ألغيت طلب الحجز الحالي. لو عايز تبدأ حجز جديد، هنبدأ من الأول.",
    en: "Your current booking request has been cancelled. You can start a new booking any time.",
  },
  alreadyDone: {
    ar: "الحجز ده اتأكد قبل كده. لو عايز تعمل حجز جديد، ابدأ محادثة جديدة.",
    en: "This booking has already been confirmed. To make a new one, please start a new conversation.",
  },
  cancelKept: {
    ar: "تمام، الحجز زي ما هو ومفيش حاجة اتغيرت.",
    en: "OK, your booking stays as it is. Nothing was changed.",
  },
  cancelInvalidRef: {
    ar: "رقم الحجز مش مكتوب صح. شكله GEM- وبعده 10 حروف أو أرقام، زي GEM-XXXXXXXXXX.",
    en: "That booking reference doesn't look right. It starts with GEM- followed by 10 letters or digits, like GEM-XXXXXXXXXX.",
  },
  cancelAskRef: {
    ar: "تمام. ابعتلي رقم الحجز اللي عايز تلغيه (شكله GEM-XXXXXXXXXX).",
    en: "Sure. Please send me the reference of the booking you want to cancel (it looks like GEM-XXXXXXXXXX).",
  },
  alreadyCancelled: {
    ar: "طلب الحجز ده اتلغى. ابدأ محادثة جديدة لو عايز تعمل حجز جديد.",
    en: "This booking request was cancelled. Please start a new conversation to make a new booking.",
  },
};

function changeAck(fields, lang) {
  const names = {
    date: { ar: "التاريخ", en: "the date" },
    visitors: { ar: "عدد الزوار", en: "the number of visitors" },
    name: { ar: "الاسم", en: "the name" },
  };
  const list = fields.map((f) => names[f][lang]);
  return lang === "en"
    ? `Sure, let's change ${list.join(" and ")}. `
    : `تمام، نغيّر ${list.join(" و")}. `;
}

function reviewText({ name, date, visitors }, lang) {
  const when = formatDate(date, lang);
  return lang === "en"
    ? `Thanks, ${firstName(name)}! Here are your booking details:\n- Date: ${when}\n- Visitors: ${visitors}\n- Name: ${name}\n\nThis is a demo booking, not an official museum ticket.\n\nWould you like to confirm the booking, or change anything?`
    : `تمام يا ${firstName(name)}! دي تفاصيل حجزك:\n- التاريخ: ${when}\n- عدد الزوار: ${visitors}\n- الاسم: ${name}\n\nده حجز تجريبي مش تذكرة رسمية للمتحف.\n\nتحب تأكد الحجز ولا تعدل حاجة؟`;
}

function confirmedText(booking, lang) {
  const when = formatDate(booking.visit_date, lang);
  return lang === "en"
    ? `Your booking has been recorded!\nBooking reference: ${booking.booking_reference}\n- Name: ${booking.visitor_name}\n- Date: ${when}\n- Visitors: ${booking.ticket_count}\n\nThis is a demo booking, not an official museum ticket.`
    : `تم تسجيل حجزك بنجاح!\nرقم الحجز: ${booking.booking_reference}\n- الاسم: ${booking.visitor_name}\n- التاريخ: ${when}\n- عدد الزوار: ${booking.ticket_count}\n\nده حجز تجريبي مش تذكرة رسمية للمتحف.`;
}

/** Replies for cancelling a confirmed booking. `booking` is the visitor's OWN booking. */
function cancelText(key, lang, booking = null) {
  const en = lang === "en";
  const when = booking ? formatDate(booking.visit_date, lang) : "";
  const details = booking
    ? en
      ? `- Booking reference: ${booking.booking_reference}\n${booking.visitor_name ? `- Name: ${booking.visitor_name}\n` : ""}- Date: ${when}\n- Visitors: ${booking.ticket_count}`
      : `- رقم الحجز: ${booking.booking_reference}\n${booking.visitor_name ? `- الاسم: ${booking.visitor_name}\n` : ""}- التاريخ: ${when}\n- عدد الزوار: ${booking.ticket_count}`
    : "";
  switch (key) {
    case "found":
      return en
        ? `I found your booking.\n${details}\n\nDo you want me to cancel it? Reply "Yes, cancel it" to confirm.`
        : `لقيت الحجز بتاعك.\n${details}\n\nتحب ألغيه؟ رد بـ "أيوه، ألغي الحجز" للتأكيد.`;
    case "done":
      return en
        ? `Your booking has been cancelled successfully.\n${details}`
        : `تم إلغاء الحجز بنجاح.\n${details}`;
    case "kept":
      return sayText("cancelKept", lang);
    case "notFound":
      return en
        ? "I couldn't find a booking with that reference in your bookings. Please check the number and try again."
        : "ملقيتش حجز بالرقم ده ضمن حجوزاتك. اتأكد من الرقم وجرب تاني.";
    case "invalidRef":
      return sayText("cancelInvalidRef", lang);
    case "askRef":
      return sayText("cancelAskRef", lang);
    case "already":
      return en
        ? `That booking has already been cancelled.\n${details}`
        : `الحجز ده اتلغى قبل كده.\n${details}`;
    case "past":
      return en
        ? "The visit date for that booking has already passed, so it can't be cancelled."
        : "ميعاد زيارة الحجز ده عدّى، فمقدرش ألغيه.";
    case "expired":
      return en
        ? "That cancellation request has expired. Please send the booking reference again if you still want to cancel."
        : "طلب الإلغاء انتهت مدته. ابعتلي رقم الحجز تاني لو لسه عايز تلغي.";
    default:
      return "";
  }
}

/**
 * Replies for modifying a confirmed booking.
 * `current` / `proposed` are bookings in the API shape
 * { booking_reference, visitor_name, visit_date, ticket_count }.
 */
function modifyText(key, lang, current = null, proposed = null) {
  const en = lang === "en";
  const ref = (current || proposed)?.booking_reference || "";
  const plural = (n) => (en ? (n === 1 ? "visitor" : "visitors") : "");

  const detailLines = (b) =>
    en
      ? `${b.visitor_name ? `- Name: ${b.visitor_name}\n` : ""}- Date: ${formatDate(b.visit_date, "en")}\n- Visitors: ${b.ticket_count}`
      : `${b.visitor_name ? `- الاسم: ${b.visitor_name}\n` : ""}- التاريخ: ${formatDate(b.visit_date, "ar")}\n- عدد الزوار: ${b.ticket_count}`;

  switch (key) {
    case "found": {
      const changed = [];
      if (proposed.visit_date !== current.visit_date) changed.push("date");
      if (proposed.ticket_count !== current.ticket_count) changed.push("visitors");
      if ((proposed.visitor_name ?? null) !== (current.visitor_name ?? null)) changed.push("name");

      const tail = en
        ? `Reply "Yes, confirm" to apply the change, or "No" to keep your booking as it is.`
        : `رد بـ "أيوه، أكد" لتطبيق التعديل، أو "لا" عشان الحجز يفضل زي ما هو.`;

      if (changed.length === 1 && changed[0] === "visitors") {
        return en
          ? `I found your booking ${ref}. You currently have ${current.ticket_count} ${plural(current.ticket_count)}. Would you like to update it to ${proposed.ticket_count} ${plural(proposed.ticket_count)}?\n\n${tail}`
          : `لقيت حجزك ${ref}. عدد الزوار الحالي ${current.ticket_count}. تحب أعدله لـ ${proposed.ticket_count}؟\n\n${tail}`;
      }

      const none = en ? "(none)" : "(مفيش)";
      const lines = changed.map((field) => {
        if (field === "date") {
          return en
            ? `- Date: from ${formatDate(current.visit_date, "en")} to ${formatDate(proposed.visit_date, "en")}`
            : `- التاريخ: من ${formatDate(current.visit_date, "ar")} إلى ${formatDate(proposed.visit_date, "ar")}`;
        }
        if (field === "visitors") {
          return en
            ? `- Visitors: from ${current.ticket_count} to ${proposed.ticket_count}`
            : `- عدد الزوار: من ${current.ticket_count} إلى ${proposed.ticket_count}`;
        }
        return en
          ? `- Name: from ${current.visitor_name || none} to ${proposed.visitor_name}`
          : `- الاسم: من ${current.visitor_name || none} إلى ${proposed.visitor_name}`;
      });
      return en
        ? `I found your booking ${ref}. Here is what would change:\n${lines.join("\n")}\n\nWould you like to update it?\n\n${tail}`
        : `لقيت حجزك ${ref}. دي التعديلات:\n${lines.join("\n")}\n\nتحب أعدله؟\n\n${tail}`;
    }
    case "done":
      return en
        ? `Your booking has been updated successfully. Your booking reference remains ${ref}.\n${detailLines(proposed)}`
        : `تم تعديل حجزك بنجاح. رقم الحجز لسه ${ref}.\n${detailLines(proposed)}`;
    case "kept":
      return sayText("cancelKept", lang);
    case "same":
      return en
        ? `Your booking ${ref} already has those details, so there is nothing to change.\n${detailLines(current)}`
        : `حجزك ${ref} متسجل بنفس البيانات دي، فمفيش حاجة تتغير.\n${detailLines(current)}`;
    case "notFound":
      return en
        ? "I couldn't find a booking with that reference in your bookings. Please check the number and try again."
        : "ملقيتش حجز بالرقم ده ضمن حجوزاتك. اتأكد من الرقم وجرب تاني.";
    case "cancelled":
      return en
        ? `Booking ${ref} has been cancelled, so it can't be changed. You can make a new booking instead.`
        : `الحجز ${ref} اتلغى، فمينفعش يتعدل. تقدر تعمل حجز جديد.`;
    case "past":
      return en
        ? "The visit date for that booking has already passed, so it can't be changed."
        : "ميعاد زيارة الحجز ده عدّى، فمقدرش أعدله.";
    case "expired":
      return en
        ? "That change request has expired. Please send the booking reference and the change again."
        : "طلب التعديل انتهت مدته. ابعتلي رقم الحجز والتعديل تاني.";
    case "stale":
      return en
        ? "That booking was changed after I showed you the proposal, so I didn't apply it. Please send your change again."
        : "الحجز اتغير بعد ما عرضتلك التعديل، فمطبقتوش. ابعتلي التعديل تاني.";
    case "askRef":
      return en
        ? "Sure. Please send me the reference of the booking and what to change, for example: \"Change GEM-XXXXXXXXXX to 3 visitors\"."
        : "تمام. ابعتلي رقم الحجز والتعديل المطلوب، مثلًا: \"غيّر الحجز GEM-XXXXXXXXXX لـ 3 أشخاص\".";
    case "askChange":
      return en
        ? `What would you like to change on booking ${ref}: the date, the number of visitors (1 to 10) or the name? For example: "Change ${ref} to 3 visitors".`
        : `تحب تغيّر إيه في الحجز ${ref}: التاريخ، عدد الزوار (من 1 لـ 10) ولا الاسم؟ مثلًا: "غيّر ${ref} لـ 3 أشخاص".`;
    case "resend":
      return en
        ? `Please send the change again together with the booking reference, for example: "Change ${ref || "GEM-XXXXXXXXXX"} to 3 visitors".`
        : `ابعت التعديل تاني مع رقم الحجز، مثلًا: "غيّر ${ref || "GEM-XXXXXXXXXX"} لـ 3 أشخاص".`;
    case "cancelOrModify":
      return en
        ? "I'm not sure whether you want to cancel or change that booking. Please send one request at a time."
        : "مش متأكد إذا كنت عايز تلغي ولا تعدل الحجز. ابعتلي طلب واحد في المرة.";
    case "ambiguousPending":
      return en
        ? "I have two open requests and I'm not sure which one you're answering, so I cancelled both. Nothing was changed. Please send your request again."
        : "عندي طلبين مفتوحين ومش متأكد إنت بترد على أنهي واحد، فلغيت الاتنين ومفيش حاجة اتغيرت. ابعت طلبك تاني.";
    case "failed":
      return en
        ? "I couldn't apply that change. Nothing was changed. Please send your request again."
        : "معرفتش أطبق التعديل ومفيش حاجة اتغيرت. ابعت طلبك تاني.";
    default:
      return "";
  }
}

const sayText = (key, lang) => TEXT[key][lang === "en" ? "en" : "ar"];
/** The question for a missing field. `withLead` adds the friendly lead-in. */
const askFor = (field, lang, withLead = true) => {
  const entry = ASK[field][lang === "en" ? "en" : "ar"];
  return (withLead ? entry.lead : "") + entry.q;
};

// =====================================================
// 4. ENGINE
// =====================================================

const STATES = Object.freeze({
  START: "START",
  ASK_DATE: "ASK_DATE",
  ASK_VISITORS: "ASK_VISITORS",
  ASK_NAME: "ASK_NAME",
  REVIEW_BOOKING: "REVIEW_BOOKING",
  CONFIRMED: "CONFIRMED",
  CANCELLED: "CANCELLED",
});

/** The first missing field, in the fixed order date -> visitors -> name. */
function missingField(fields) {
  if (!fields.date) return "date";
  if (!fields.visitors) return "visitors";
  if (!fields.name) return "name";
  return null;
}

function stateOf(fields, hasDraft) {
  const missing = missingField(fields);
  if (missing === "date") return hasDraft ? STATES.ASK_DATE : STATES.START;
  if (missing === "visitors") return STATES.ASK_VISITORS;
  if (missing === "name") return STATES.ASK_NAME;
  return STATES.REVIEW_BOOKING;
}

const toExtracted = (f) => ({
  visit_date: f.date,
  ticket_count: f.visitors,
  visitor_name: f.name,
});

/**
 * @param {object} input
 * @param {string} input.message      the visitor's message
 * @param {string} input.uiLanguage   "ar" | "en" (the page language, used as a fallback)
 * @param {object|null} input.draft   { status, visit_date, visitors, visitor_name } or null
 * @param {Date}   [input.now]        injectable clock (tests)
 * @param {{reference:string}|null} [input.pendingCancellation]
 *        set by the SERVER only, when it holds an unexpired "are you sure you
 *        want to cancel booking X?" for this user and conversation
 * @param {{reference:string}|null} [input.pendingModification]
 *        same, for "do you want me to update booking X?"
 * @returns {{
 *   reply: string, language: "ar"|"en",
 *   extracted: { visit_date: string|null, ticket_count: number|null, visitor_name: string|null },
 *   action: null|"confirm"|"reset"|"cancel_booking_lookup"|"cancel_booking_confirm"|"cancel_booking_decline"
 *          |"modify_booking_lookup"|"modify_booking_confirm"|"modify_booking_decline",
 *   cancelReference?: string, cancelFlow?: boolean,
 *   modifyReference?: string, modifyChanges?: object, modifyFlow?: boolean,
 *   save: boolean, newConversationRequired: boolean, state: string
 * }}
 * The cancel_booking_* and modify_booking_* actions are INTERNAL: server.js
 * turns them into database work and never forwards them as the response action.
 */
function processMessage({
  message,
  uiLanguage = "ar",
  draft = null,
  now = new Date(),
  pendingCancellation = null,
  pendingModification = null,
}) {
  // The page sends the conversation language. A message in the other
  // language switches it, except a plain name reply: a Latin-script name
  // in an Arabic conversation (or the reverse) must not flip the language.
  const sticky = uiLanguage === "en" ? "en" : "ar";
  let lang = detectLanguage(message, sticky);
  const t = (key) => sayText(key, lang);

  const cur = {
    date: draft?.visit_date ?? null,
    visitors: draft?.visitors ?? null,
    name: draft?.visitor_name ?? null,
  };

  const base = { language: lang, extracted: toExtracted(cur), action: null, save: false, newConversationRequired: false };

  // ---- cancelling an already CONFIRMED booking ------------------------
  // Handled before everything else, because the conversation's own draft
  // (in progress, completed or cancelled) has nothing to do with it.
  const cancelBase = { ...base, cancelFlow: true, state: STATES.START };

  if (pendingCancellation) {
    // The visitor is answering "do you want me to cancel it?".
    if (isCancelDecline(message)) {
      return { ...cancelBase, reply: t("cancelKept"), action: "cancel_booking_decline" };
    }
    if (isCancelConfirmation(message)) {
      return { ...cancelBase, reply: "", action: "cancel_booking_confirm" };
    }
    // Anything else drops the pending question (the server does that)
    // and is understood as a normal message.
  }

  // ---- modifying an already CONFIRMED booking: the answer to "update it?" ----
  const modifyBase = { ...base, modifyFlow: true, state: STATES.START };

  if (pendingModification && !extractBookingReference(message)) {
    if (isCancelDecline(message)) {
      return { ...modifyBase, reply: modifyText("kept", lang), action: "modify_booking_decline" };
    }
    if (isConfirmation(message)) {
      return { ...modifyBase, reply: "", action: "modify_booking_confirm" };
    }
    // Anything else drops the pending question (the server does that)
    // and is understood as a normal message.
  }

  const cancelRequest = detectCancelBooking(message);
  const modifyRequest = detectModifyBooking(message);

  if (cancelRequest.reference) {
    if (modifyRequest.hasVerb && !modifyRequest.negated) {
      // "Cancel GEM-... and change it": never guess which one is meant.
      return { ...cancelBase, reply: modifyText("cancelOrModify", lang) };
    }
    return { ...cancelBase, reply: "", action: "cancel_booking_lookup", cancelReference: cancelRequest.reference };
  }

  // "Change GEM-... to 3 visitors" is read BEFORE the booking-draft logic,
  // and never touches a draft.
  if (modifyRequest.reference && modifyRequest.hasVerb && !modifyRequest.negated) {
    const { changes, problems } = parseBookingChanges(message, now);
    if (problems.length) {
      return {
        ...modifyBase,
        reply: problems.map((key) => t(key)).join("") + modifyText("resend", lang, { booking_reference: modifyRequest.reference }),
      };
    }
    if (Object.keys(changes).length === 0) {
      return { ...modifyBase, reply: modifyText("askChange", lang, { booking_reference: modifyRequest.reference }) };
    }
    return {
      ...modifyBase,
      reply: "",
      action: "modify_booking_lookup",
      modifyReference: modifyRequest.reference,
      modifyChanges: changes,
    };
  }
  if (modifyRequest.intent && modifyRequest.negated) {
    return { ...modifyBase, reply: modifyText("kept", lang) };
  }
  if (cancelRequest.negated) {
    return { ...cancelBase, reply: t("cancelKept") };
  }
  if (cancelRequest.referenceInvalid || (modifyRequest.referenceInvalid && modifyRequest.hasVerb)) {
    return { ...(cancelRequest.referenceInvalid ? cancelBase : modifyBase), reply: t("cancelInvalidRef") };
  }
  if (modifyRequest.intent && (!draft || draft.status !== "awaiting_confirmation")) {
    // "I want to change my booking" with no reference and no unfinished draft.
    return { ...modifyBase, reply: modifyText("askRef", lang) };
  }
  if (cancelRequest.intent && draft?.status !== "awaiting_confirmation") {
    // "Cancel my booking" with no reference and no unfinished draft.
    return { ...cancelBase, reply: t("cancelAskRef") };
  }

  // ---- finished conversations ----------------------------------------
  if (draft?.status === "completed") {
    if (isConfirmation(message)) {
      // A repeated "yes": the server asks the database, which replays the
      // same booking instead of creating a second one.
      return { ...base, reply: "", action: "confirm", state: STATES.CONFIRMED };
    }
    return { ...base, reply: t("alreadyDone"), newConversationRequired: true, state: STATES.CONFIRMED };
  }
  if (draft?.status === "cancelled") {
    return { ...base, reply: t("alreadyCancelled"), newConversationRequired: true, state: STATES.CANCELLED };
  }

  // ---- cancel / start over -------------------------------------------
  if (isCancel(message)) {
    if (draft) {
      return {
        ...base,
        reply: t("cancelled"),
        extracted: toExtracted({ date: null, visitors: null, name: null }),
        action: "reset",
        newConversationRequired: true,
        state: STATES.CANCELLED,
      };
    }
    return { ...base, reply: t("nothingToCancel"), state: STATES.START };
  }

  // ---- explicit confirmation -----------------------------------------
  if (isConfirmation(message)) {
    if (!missingField(cur)) {
      return { ...base, reply: "", action: "confirm", state: STATES.REVIEW_BOOKING };
    }
    const missing = missingField(cur);
    return {
      ...base,
      reply: t("notReady") + askFor(missing, lang, false),
      save: !!draft,
      state: stateOf(cur, !!draft),
    };
  }

  // ---- read the message ----------------------------------------------
  const p = parseMessage(message, now);
  const next = { ...cur };
  const problems = []; // sentences that explain what was not understood
  const cleared = [];

  // Values given in the message.
  if (p.date.status === "ok") next.date = p.date.value;
  else if (p.date.status === "error") {
    problems.push(t(p.date.reason === "past" ? "pastDate" : p.date.reason === "far" ? "farDate" : "invalidDate"));
  } else if (p.date.status === "ambiguous") problems.push(t("severalDates"));

  if (p.count.status === "ok") next.visitors = p.count.value;
  else if (p.count.status === "error") problems.push(t("badVisitors"));
  else if (p.count.status === "ambiguous") {
    problems.push(t(p.count.reason === "group" ? "groupVisitors" : "severalCounts"));
  }

  if (p.name.status === "ok") next.name = p.name.value;
  else if (p.name.status === "error") problems.push(t("badName"));

  // "Change the date" with no new value: clear it and ask again.
  if (p.modify.intent) {
    const attempted = {
      date: p.date.status !== "none",
      visitors: p.count.status !== "none",
      name: p.name.status !== "none",
    };
    for (const field of p.modify.fields) {
      if (!attempted[field] && next[field]) {
        next[field] = null;
        cleared.push(field);
      }
    }
  }

  // A reply to the question Egyxos just asked ("3", "أحمد محمد").
  let understood = p.consumed || cleared.length > 0 || p.summary;
  const skipBare = p.consumed || p.modify.intent || p.greeting || p.bookingIntent || p.negative;
  if (!skipBare) {
    const step = missingField(cur);
    if (step === "visitors" || step === null) {
      const bare = parseBareCount(message);
      if (bare.status === "ok") { next.visitors = bare.value; understood = true; }
      else if (bare.status === "error") { problems.push(t("badVisitors")); understood = true; }
    } else if (step === "name") {
      const bare = parseBareName(message);
      if (bare.status !== "none") lang = sticky;
      if (bare.status === "ok") { next.name = bare.value; understood = true; }
      else if (bare.status === "error") { problems.push(t("badName")); understood = true; }
    } else if (step === "date") {
      const bare = parseBareCount(message);
      if (bare.status !== "none") { problems.push(t("dateNeedsMore")); understood = true; }
    }
  }

  // "I want to change something" without saying what.
  if (p.modify.intent && !understood && p.modify.fields.size === 0 && problems.length === 0) {
    return {
      ...base,
      reply: t("whatToChange"),
      save: !!draft,
      state: stateOf(cur, !!draft),
    };
  }
  if (p.negative && !missingField(cur)) {
    return { ...base, reply: t("whatToChange"), save: !!draft, state: STATES.REVIEW_BOOKING };
  }

  // ---- build the reply -----------------------------------------------
  const missing = missingField(next);
  const state = stateOf(next, !!draft);
  const hasAny = !!(next.date || next.visitors || next.name);
  const save = hasAny || !!draft;

  let reply;
  if (!hasAny && !draft && problems.length === 0) {
    // First contact (greeting, booking request, or anything else).
    reply = t("welcome");
  } else {
    const lead =
      problems.join("") ||
      (cleared.length ? changeAck(cleared, lang) : "") ||
      (!understood && !p.greeting && !p.bookingIntent && !p.negative ? t("unknown") : "");
    reply = missing
      ? lead + askFor(missing, lang, lead === "")
      : lead + reviewText(next, lang);
  }

  return {
    language: lang,
    extracted: toExtracted(next),
    action: null,
    save,
    newConversationRequired: false,
    reply,
    state,
  };
}

module.exports = {
  processMessage,
  STATES,
  missingField,
  // phrase detectors used by the server
  isConfirmation,
  isCancel,
  // parser pieces (exported so the tests can check them one by one)
  detectLanguage,
  parseMessage,
  parseBareCount,
  parseBareName,
  // validators shared with the server
  cairoToday,
  addDays,
  checkVisitDate,
  isValidVisitorCount,
  normalizeName,
  MAX_DAYS_AHEAD,
  MIN_VISITORS,
  MAX_VISITORS,
  // cancelling a confirmed booking
  extractBookingReference,
  detectCancelBooking,
  isCancelConfirmation,
  isCancelDecline,
  cancelText,
  // modifying a confirmed booking
  detectModifyBooking,
  parseBookingChanges,
  modifyText,
  // reply builder for a saved booking
  confirmedText,
  formatDate,
};
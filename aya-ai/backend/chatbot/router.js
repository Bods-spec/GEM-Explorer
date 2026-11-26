"use strict";

// =====================================================
// Egyxos message router (Phase B)
//
// PURE functions. They decide whether a visitor message is about
// PLANNING the visit (handled by the Python planner tool), about
// BOOKING (handled by the existing rule-based engine), or BOTH.
//
// This runs BEFORE the booking parser, because the booking parser
// reads a duration such as "90 minutes" or "two hours" as a visitor
// count. stripDurations() removes duration phrases so that the booking
// engine never sees them.
// =====================================================

const parser = require("./parser");

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const re = (source, flags = "giu") => new RegExp(`${B}(?:${source})${E}`, flags);

// ---- duration phrases -----------------------------------------------------
// Matched on the FOLDED text (lower-case; Arabic ة->ه, أ->ا, ى->ي).
// "الساعة 3" (3 o'clock) is NOT a duration: the Arabic pattern needs
// "ساعه" to start a word, and "الساعه" starts with "ال".

const EN_NUM = "\\d+(?:[.,]\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|sixty|ninety";
const EN_UNIT = "hours?|hrs?|minutes?|mins?";

const DURATION_PATTERNS = [
  // "1 hour and a half", "two and a half hours", "2.5 hours", "90 minutes", "3-hour"
  re(`(?:${EN_NUM})\\s*(?:and a half|and half)\\s*(?:${EN_UNIT})`),
  re(`(?:${EN_NUM})\\s*-?\\s*(?:${EN_UNIT})(?:\\s*(?:and\\s*)?(?:a half|half|\\d+\\s*(?:minutes?|mins?)))?`),
  re("\\d+\\s*h"),
  re("(?:a|an|one)\\s+hour\\s+and\\s+(?:a\\s+)?half"),
  re("half\\s+(?:an?\\s+)?hour"),
  re("(?:a\\s+)?quarter\\s+(?:of\\s+)?(?:an?\\s+)?hour"),
  re("(?:a\\s+few|a\\s+couple\\s+of|couple\\s+of|several)\\s+(?:hours?|minutes?)"),
  // Arabic (folded)
  re("(?:\\d+(?:[.,]\\d+)?|واحد|اتنين|تلاته|ثلاثه|اربعه|اربع|خمسه|خمس|سته|ست|سبعه|سبع|تمانيه|ثمانيه|تسعه|تسع|عشره|عشر|نص|نصف|ربع)\\s+(?:ساعات|ساعه|دقايق|دقائق|دقيقه)"),
  re("ساعتين|ساعتان|دقيقتين|دقيقتان"),
  re("(?:نص|نصف|ربع)\\s+ساعه"),
  re("ساعه\\s*(?:و\\s*)?(?:نص|نصف|ربع)"),
  re("ساعه|ساعات|دقايق|دقائق"),
];

/** [start, end) spans of every duration phrase in `folded`, merged. */
function durationSpans(folded) {
  const spans = [];
  for (const regex of DURATION_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(folded)) !== null) {
      if (m[0].length === 0) { regex.lastIndex += 1; continue; }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  return merged;
}

/** Same-length pair: display text (case kept) and folded text. */
function views(message) {
  const text = parser.clean(message);
  return { text, folded: parser.fold(text) };
}

/** True if the message states how long the visit should take. */
function hasDuration(message) {
  return durationSpans(views(message).folded).length > 0;
}

/**
 * The message with every duration phrase removed, ready for the booking
 * engine. Names and other text keep their original spelling and case.
 */
function stripDurations(message) {
  const { text, folded } = views(message);
  const spans = durationSpans(folded);
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  for (const [s, e] of spans) {
    out += text.slice(at, s) + " ";
    at = e;
  }
  out += text.slice(at);
  return out.replace(/\s+/g, " ").trim();
}

// ---- planning words ---------------------------------------------------------

const PLAN_WORDS = new Set([
  "plan", "plans", "planning", "planner", "itinerary", "itineraries", "route", "agenda",
  "schedule", "highlights", "must-see",
  "خطه", "خطتي", "خطط", "جدول", "جدولي", "برنامج", "مسار", "رتب", "رتبلي", "ترتيب",
]);
const PLAN_PHRASES = [
  /\b(?:what|which) (?:should|can|do) (?:i|we) (?:see|visit)\b/,
  /\b(?:want|like|love) to see\b/,
  /\bmust[ -]see\b/,
  /\bshow me around\b/,
  /\bmake (?:me )?(?:a|the) (?:visit|tour)\b/,
  /اشوف ايه|نشوف ايه|اروح فين|اعمل ايه في المتحف/,
];

/** Word tokens; an Arabic "و" (and) prefix is also tried off ("واحجزلي"). */
function wordsOf(message, keepHyphen = false) {
  const pattern = keepHyphen ? /[^\p{L}\p{N}\s-]/gu : /[^\p{L}\p{N}\s]/gu;
  return parser.fold(parser.clean(message)).replace(pattern, " ").split(/\s+/).filter(Boolean);
}
const inSet = (set, w) => set.has(w) || (w.length > 2 && w.startsWith("و") && set.has(w.slice(1)));

function hasPlanWords(message) {
  const { folded } = views(message);
  if (wordsOf(message, true).some((w) => inSet(PLAN_WORDS, w))) return true;
  // "I want to see my booking summary" is not a planning request.
  if (/summary|details|ملخص|تفاصيل/.test(folded)) return false;
  return PLAN_PHRASES.some((r) => r.test(folded));
}

// Words that change an existing plan. Only meaningful AFTER a plan was shown.
const EDIT_WORDS = new Set([
  "remove", "drop", "skip", "without", "instead", "add", "include", "shorter", "longer",
  "shorten", "extend", "swap", "replace", "less", "more", "focus", "only",
  "شيل", "شيلي", "احذف", "احذفي", "ضيف", "ضيفي", "زود", "قلل", "بدل", "بدلي", "اقصر", "اطول",
  "بدون", "ركز", "ركزي", "بس",
]);

function hasEditWords(message) {
  return wordsOf(message).some((w) => inSet(EDIT_WORDS, w));
}

// ---- booking words ------------------------------------------------------------
// STRICTER than parser.hasBookingIntent: "visit" / "زيارة" are left out,
// because "plan my 2 hour visit" is a planning request, not a booking.

const BOOKING_ONLY_WORDS = new Set([
  "book", "booking", "bookings", "reserve", "reservation", "ticket", "tickets",
  "احجز", "احجزلي", "احجزي", "حجز", "حجزلي", "تذكره", "تذاكر", "تذكرتين",
]);

function hasBookingWords(message) {
  return wordsOf(message).some((w) => inSet(BOOKING_ONLY_WORDS, w));
}

// ---- classification -------------------------------------------------------------

/**
 * @param {string} message
 * @param {{ planPresented?: boolean, awaitingPlanner?: boolean }} [ctx]
 * @returns {{
 *   route: "booking"|"planner"|"both",
 *   duration: boolean, planWords: boolean, edit: boolean, bookingWords: boolean,
 *   stripped: string
 * }}
 */
function classify(message, ctx = {}) {
  const duration = hasDuration(message);
  const stripped = duration ? stripDurations(message) : parser.clean(message);
  const out = {
    route: "booking",
    duration,
    planWords: hasPlanWords(message),
    edit: false,
    bookingWords: hasBookingWords(message),
    stripped,
  };

  // Explicit confirm / cancel always belong to the booking engine.
  if (parser.isCancel(message) || parser.isConfirmation(message)) return out;

  // Does the message carry booking details (date, visitor count, name)?
  const bookingFields = (() => {
    const p = parser.parseMessage(stripped, new Date());
    if (p.date.status !== "none" || p.count.status !== "none" || p.name.status !== "none") return true;
    // "add 2 more visitors": a number next to a head-count word is booking talk, not a plan edit.
    return /\d/.test(stripped) &&
      /(?:visitors?|people|persons?|guests?|adults?|children|kids|tickets?|زوار|اشخاص|شخص|اطفال|تذاكر|تذكره)/.test(parser.fold(stripped));
  })();

  out.edit = !!ctx.planPresented && hasEditWords(message) && !bookingFields;

  const planning = out.duration || out.planWords || out.edit;
  if (planning) {
    out.route = out.bookingWords ? "both" : "planner";
  } else if (ctx.awaitingPlanner && !bookingFields) {
    // The planner asked something ("how much time do you have?");
    // an answer without booking details belongs to it.
    out.route = "planner";
  }
  return out;
}

module.exports = {
  classify,
  hasDuration,
  stripDurations,
  hasPlanWords,
  hasEditWords,
  hasBookingWords,
};
"use strict";

// =====================================================
// Planning flow (Phase B)
//
// Sits in front of the rule-based booking engine and decides, for each
// chat message, whether the Python Smart Visit Planner is involved.
// It is ONE conversation: the visitor never sees a second agent.
//
//   booking-only message -> { mode: "engine" } (identical to today)
//   planning message     -> planner call, then the booking engine (if a
//                           booking is in progress or was requested)
//
// What is kept, in MEMORY ONLY (lost when Node restarts):
//   per (user, conversation): planRequested, planPresented, awaiting,
//   and the last fixed planner reply (a template sentence, never the
//   visitor's own message, never a token).
// Bounded by a sliding TTL (default 24 h, same as a booking draft),
// a global cap and a per-user cap. The key always contains the
// authenticated user id, so one visitor can never read or change
// another visitor's flow. Nothing is written to SQL or Supabase.
//
// The booking safeguards are untouched: this module never writes to
// the database and never confirms anything. While a requested plan has
// not been shown ("hold"), server.js simply does not present the
// booking summary for confirmation.
// =====================================================

const chatbot = require("./chatbot");
const router = require("./planning-router");

const parser = {
  clean: router.clean,
  fold: router.fold,
  isCancel: chatbot.isCancel,
  detectLanguage: chatbot.detectLanguage,
};

const DEFAULTS = {
  ttlMs: 24 * 60 * 60 * 1000,
  maxFlows: 2000,
  maxPerUser: 20,
  sweepEveryMs: 60 * 1000,
};

const MAX_REPLY_CHARS = 4000;

// ---- fixed texts (Egyptian Arabic and English) --------------------------------

const TEXT = {
  unavailable: {
    ar: "معلش، مش قادر أجهز خطة الزيارة دلوقتي. تحب نكمل الحجز من غير خطة، ولا تجرب الخطة تاني كمان شوية؟",
    en: "Sorry, I can't prepare your visit plan right now. Would you like to continue with the booking only, or try the plan again in a moment?",
  },
  planFirst: {
    ar: "حفظت بيانات الحجز. قبل ما أعرض ملخص الحجز، نخلّص خطة الزيارة الأول:",
    en: "I've kept your booking details. Before the booking summary, let's finish your visit plan:",
  },
  bookingOnly: {
    ar: "تمام، هنكمل الحجز من غير خطة.",
    en: "Okay, we'll continue with the booking only.",
  },
};
const tx = (key, lang) => TEXT[key][lang === "en" ? "en" : "ar"];

const SUMMARY_MESSAGE = { ar: "ملخص الحجز", en: "booking summary" };

// ---- visitor phrases ---------------------------------------------------------------

const DROP_PLAN = [
  /\bbooking only\b/, /\bjust (?:the )?booking\b/, /\bjust book\b/, /\bwithout (?:a |the |any )?plan\b/,
  /\bno plan\b/, /\bskip (?:the |my |this )?plan\b/, /\bforget (?:about )?(?:the |my )?plan\b/,
  /\bdon t need (?:a |the )?plan\b/, /\bcontinue (?:with )?(?:the )?booking\b/,
  /بدون خطه/, /من غير خطه/, /مش عايز خطه/, /مش عايزه خطه/, /بلاش خطه/, /انسي الخطه/,
  /حجز بس/, /الحجز بس/, /كمل (?:ال)?حجز/, /كملي (?:ال)?حجز/,
];

const AFFIRM_KEY = new Set([
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "continue", "proceed",
  "ايوه", "ايوا", "اه", "نعم", "تمام", "ماشي", "اوكي", "اوك", "كمل", "كملي", "يلا",
]);
const AFFIRM_FILL = new Set([
  "please", "the", "booking", "only", "just", "with", "it", "go", "ahead", "now", "thanks",
  "كده", "بس", "الحجز", "حجز", "فضلك", "لو", "سمحت", "من",
]);

const words = (message) =>
  parser.fold(parser.clean(message)).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/** "Skip the plan / booking only" at any time. */
function isDropPlan(message) {
  const joined = words(message).join(" ");
  return DROP_PLAN.some((r) => r.test(joined));
}

/** A short "yes / continue" answer. Only used right after "planning is unavailable". */
function isAffirmative(message) {
  const t = words(message);
  return t.length > 0 && t.length <= 4 &&
    t.every((w) => AFFIRM_KEY.has(w) || AFFIRM_FILL.has(w)) &&
    t.some((w) => AFFIRM_KEY.has(w));
}

// ---- bounded in-memory store ------------------------------------------------------

function createFlowStore({ now = () => Date.now(), ...options } = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const map = new Map(); // key -> { userId, state, touched }  (insertion order = least recent first)
  let lastSweep = now();

  const keyOf = (userId, conversationId) => `${userId}:${conversationId}`;

  function sweep() {
    const t = now();
    if (t - lastSweep < cfg.sweepEveryMs) return;
    lastSweep = t;
    for (const [key, entry] of map) {
      if (t - entry.touched > cfg.ttlMs) map.delete(key);
    }
  }

  function get(userId, conversationId) {
    sweep();
    const key = keyOf(userId, conversationId);
    const entry = map.get(key);
    if (!entry) return null;
    if (now() - entry.touched > cfg.ttlMs) { map.delete(key); return null; }
    return { ...entry.state };
  }

  function set(userId, conversationId, state) {
    sweep();
    const key = keyOf(userId, conversationId);
    map.delete(key); // re-insert = most recently used
    map.set(key, { userId, state: { ...state }, touched: now() });

    // Per-user cap: drop this user's least recently used flows.
    let mine = 0;
    for (const entry of map.values()) if (entry.userId === userId) mine += 1;
    if (mine > cfg.maxPerUser) {
      for (const [k, entry] of map) {
        if (mine <= cfg.maxPerUser) break;
        if (entry.userId === userId && k !== key) { map.delete(k); mine -= 1; }
      }
    }
    // Global cap.
    while (map.size > cfg.maxFlows) {
      const oldest = map.keys().next().value;
      if (oldest === key) break;
      map.delete(oldest);
    }
  }

  function remove(userId, conversationId) {
    map.delete(keyOf(userId, conversationId));
  }

  return { get, set, remove, size: () => map.size };
}

// ---- the flow -------------------------------------------------------------------------

const blank = () => ({ planRequested: false, planPresented: false, awaiting: null, lastPlannerReply: null });
const clip = (s) => (typeof s === "string" ? s.slice(0, MAX_REPLY_CHARS) : null);
const holdOf = (st) => !!(st && st.planRequested && !st.planPresented);

/**
 * @param {{ client: {enabled: boolean, turn: Function}, store?: object }} deps
 */
function createPlanningFlow({ client, store = createFlowStore() }) {
  const enabled = !!client?.enabled;

  const pass = (message, state) => ({
    mode: "engine", message, prefix: "", hold: holdOf(state), holdReply: "", plan: null, plannerStatus: null,
  });

  /**
   * Decide how this message is handled. Never throws: any planner problem
   * becomes the "planning unavailable" answer.
   *
   * @returns {Promise<{
   *   mode: "engine"|"direct",
   *   message: string,        // what the booking engine receives (mode "engine")
   *   prefix: string,         // planner text shown BEFORE the booking reply
   *   hold: boolean,          // a requested plan was not shown yet: do not present the booking summary
   *   holdReply: string,      // what to say instead of the booking reply while on hold
   *   plan: object|null,      // structured plan, only on plan_created / plan_updated
   *   plannerStatus: string|null
   * }>}
   */
  async function decide({ userId, conversationId, token, message, uiLanguage, draft, skip = false }) {
    // `skip`: the message is about an already CONFIRMED booking (cancel / modify flow).
    if (!enabled || skip) return pass(message, null);

    // A finished or cancelled conversation is the engine's business, as today.
    if (draft && (draft.status === "completed" || draft.status === "cancelled")) {
      return pass(message, null);
    }

    const lang = parser.detectLanguage(message, uiLanguage);
    const summary = SUMMARY_MESSAGE[lang === "en" ? "en" : "ar"];
    const state = store.get(userId, conversationId) || blank();
    const onHold = holdOf(state);

    // Cancel: the engine resets the booking; the plan flow is forgotten too.
    if (parser.isCancel(message)) {
      store.remove(userId, conversationId);
      return pass(message, null);
    }

    // "Booking only" / "yes, continue" after the planner was unavailable:
    // drop the plan request. The word "yes" is NEVER passed to the engine here,
    // so it cannot be read as a booking confirmation.
    if (onHold && (isDropPlan(message) || (state.awaiting === "fallback" && isAffirmative(message)))) {
      store.set(userId, conversationId, blank());
      return {
        mode: "engine", message: summary, prefix: tx("bookingOnly", lang),
        hold: false, holdReply: "", plan: null, plannerStatus: null,
      };
    }

    const cls = router.classify(message, {
      planPresented: state.planPresented,
      awaitingPlanner: state.awaiting === "planner",
    });

    // Booking-only message: no planner call.
    if (cls.route === "booking") {
      const out = pass(message, state);
      if (out.hold) out.holdReply = heldReply(state, lang, false);
      return out;
    }

    // ---- planner call ------------------------------------------------------------
    const bookingHandled = cls.route === "both";
    const result = await client.turn({
      token, message, conversationId, language: uiLanguage, bookingHandled,
    });

    const next = { ...state };
    const engineMessage = cls.route === "both" && /[\p{L}\p{N}]/u.test(cls.stripped)
      ? cls.stripped
      : (draft ? summary : null);

    if (!result.ok) {
      // Planner down / refused / too slow: say so, keep the planning request alive.
      next.planRequested = true;
      next.awaiting = "fallback";
      next.lastPlannerReply = tx("unavailable", lang);
      store.set(userId, conversationId, next);
      return directOrEngine({
        engineMessage, prefix: tx("unavailable", lang), hold: !next.planPresented,
        holdReply: tx("unavailable", lang), plan: null, plannerStatus: "unavailable",
      });
    }

    const data = result.data;
    const status = data.status;
    const reply = clip(data.reply) || "";

    // Not a planning message after all: the booking engine handles it as today.
    if (status === "not_planning" || status === "smalltalk" || status === "handoff") {
      const fallbackMessage = /[\p{L}\p{N}]/u.test(cls.stripped) ? cls.stripped : (draft ? summary : message);
      const out = pass(fallbackMessage, state);
      if (out.hold) out.holdReply = heldReply(state, lang, false);
      out.plannerStatus = status;
      return out;
    }

    if (status === "plan_created" || status === "plan_updated") {
      next.planRequested = true;
      next.planPresented = true;
      next.awaiting = null;
      next.lastPlannerReply = null;
      store.set(userId, conversationId, next);
      return directOrEngine({
        engineMessage, prefix: reply, hold: false, holdReply: "",
        plan: data.plan || null, plannerStatus: status,
      });
    }

    if (status === "unavailable") {
      next.planRequested = true;
      next.awaiting = "fallback";
      next.lastPlannerReply = tx("unavailable", lang);
      store.set(userId, conversationId, next);
      return directOrEngine({
        engineMessage, prefix: tx("unavailable", lang), hold: !next.planPresented,
        holdReply: tx("unavailable", lang), plan: null, plannerStatus: status,
      });
    }

    if (status === "out_of_scope") {
      // Nothing was asked of the planner that it can do. Show its note; carry on.
      store.set(userId, conversationId, next);
      return directOrEngine({
        engineMessage, prefix: reply, hold: holdOf(next),
        holdReply: holdOf(next) ? heldReply(next, lang, false) : "",
        plan: null, plannerStatus: status,
      });
    }

    // needs_clarification / not_possible: the planner has a question or an option for the visitor.
    next.planRequested = true;
    if (!next.planPresented) next.awaiting = "planner";
    next.lastPlannerReply = next.planPresented ? null : reply;
    store.set(userId, conversationId, next);
    if (next.planPresented) {
      // A change to an existing plan was not possible: tell them, then continue the booking.
      return directOrEngine({
        engineMessage, prefix: reply, hold: false, holdReply: "", plan: null, plannerStatus: status,
      });
    }
    return directOrEngine({
      engineMessage, prefix: reply, hold: true, holdReply: reply, plan: null, plannerStatus: status,
    });
  }

  /** With nothing to give the engine (no booking in progress), answer directly. */
  function directOrEngine({ engineMessage, prefix, hold, holdReply, plan, plannerStatus }) {
    if (engineMessage === null) {
      return { mode: "direct", message: "", prefix, hold, holdReply: holdReply || prefix, plan, plannerStatus };
    }
    return { mode: "engine", message: engineMessage, prefix, hold, holdReply, plan, plannerStatus };
  }

  /** Reminder shown while a requested plan is still unfinished. */
  function heldReply(state, lang) {
    const last = state.lastPlannerReply || "";
    if (state.awaiting === "fallback" || !last) return last || tx("unavailable", lang);
    return `${tx("planFirst", lang)}\n\n${last}`;
  }

  /** Forget the flow (called after a booking is confirmed or reset). */
  function forget(userId, conversationId) {
    if (enabled) store.remove(userId, conversationId);
  }

  return { enabled, decide, forget, store };
}

module.exports = {
  createPlanningFlow,
  createFlowStore,
  isDropPlan,
  isAffirmative,
  DEFAULTS,
};
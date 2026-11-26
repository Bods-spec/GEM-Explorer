"use strict";

// =====================================================
// Smart Visit Planner client (Phase B)
//
// Calls the Python service: POST {PLANNER_URL}/planner/turn
//
//   * Disabled unless PLANNER_ENABLED=true AND PLANNER_URL is a valid
//     http(s) URL. Disabled means NO call is ever made.
//   * Forwards the visitor's OWN Supabase access token. Python verifies
//     it again; the user id is never sent in the body.
//   * One attempt with a timeout. No retries, no queueing: if Python is
//     down the Booking Agent tells the visitor and carries on.
//   * Never logs the token, the visitor's message or the plan. Only a
//     short failure reason and an HTTP status code are ever logged.
// =====================================================

const KNOWN_STATUSES = new Set([
  "plan_created", "plan_updated", "needs_clarification", "not_possible",
  "handoff", "out_of_scope", "not_planning", "smalltalk", "unavailable",
]);

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;
const MAX_RESPONSE_CHARS = 200000;

/** Reads the planner settings from an environment object. */
function readPlannerConfig(env = process.env) {
  const flag = String(env.PLANNER_ENABLED ?? "").trim().toLowerCase() === "true";
  let url = null;
  try {
    const parsed = new URL(String(env.PLANNER_URL ?? "").trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      url = parsed.origin + parsed.pathname.replace(/\/+$/, "");
    }
  } catch { /* not a URL */ }

  const requested = Number(env.PLANNER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requested) && requested >= 500
    ? Math.min(Math.floor(requested), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  return { enabled: flag && !!url, requestedButNoUrl: flag && !url, url, timeoutMs };
}

function createPlannerClient(config, { fetchImpl, logger = console } = {}) {
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  /**
   * @returns {Promise<{ok: true, data: object} | {ok: false, reason: string, status?: number}>}
   *   reason: "timeout" | "unreachable" | "rejected" | "bad_response" | "disabled"
   */
  async function turn({ token, message, conversationId, language, bookingHandled }) {
    if (!config.enabled) return { ok: false, reason: "disabled" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      let res;
      try {
        res = await doFetch(`${config.url}/planner/turn`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            message,
            conversation_id: conversationId,
            language: language === "en" ? "en" : "ar",
            booking_handled: !!bookingHandled,
          }),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        const reason = error?.name === "AbortError" ? "timeout" : "unreachable";
        logger.error(`Planner call failed: ${reason}`);
        return { ok: false, reason };
      }

      if (!res.ok) {
        // 401/403 (token not accepted), 422, 429, 5xx: all mean "no plan now".
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        logger.error(`Planner call rejected: HTTP ${res.status}`);
        return { ok: false, reason: "rejected", status: res.status };
      }

      let data;
      try {
        const text = await res.text();
        if (text.length > MAX_RESPONSE_CHARS) throw new Error("too large");
        data = JSON.parse(text);
      } catch (error) {
        const reason = error?.name === "AbortError" ? "timeout" : "bad_response";
        logger.error(`Planner call failed: ${reason}`);
        return { ok: false, reason };
      }

      const valid =
        data && typeof data === "object" && !Array.isArray(data) &&
        KNOWN_STATUSES.has(data.status) &&
        typeof data.reply === "string" &&
        (data.plan === undefined || data.plan === null || (typeof data.plan === "object" && !Array.isArray(data.plan)));
      if (!valid) {
        logger.error("Planner call failed: bad_response");
        return { ok: false, reason: "bad_response" };
      }
      return { ok: true, data };
    } finally {
      clearTimeout(timer);
    }
  }

  return { enabled: config.enabled, turn };
}

module.exports = { readPlannerConfig, createPlannerClient, KNOWN_STATUSES };
"use strict";

// =====================================================
// AI Museum Guide client
//
// Calls the Python service: POST {GUIDE_URL}/guide/chat
//
//   * Disabled unless GUIDE_ENABLED=true AND GUIDE_URL is a valid
//     http(s) URL. Disabled means NO call is ever made.
//   * Forwards the visitor's OWN Supabase access token. Python verifies
//     it again and keeps each conversation private to that user. The
//     user id is never sent in the body.
//   * One attempt with a timeout. No retries.
//   * Never logs the token or the visitor's message or the reply. Only a
//     short failure reason and an HTTP status code are ever logged.
//   * The answer is rebuilt field by field (see cleanGuideReply), so
//     nothing unexpected from Python can reach the browser.
// =====================================================

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const KNOWN_STATUSES = new Set([
  "answered", "insufficient_evidence", "out_of_scope", "smalltalk",
  "handoff", "unverified", "unavailable",
]);
const KNOWN_REGISTERS = new Set(["en", "ar", "eg"]);

// Error codes Python may send in { error: CODE }. Anything else is "unknown".
const KNOWN_ERROR_CODES = new Set([
  "UNAUTHORIZED", "GUESTS_NOT_ALLOWED", "CONVERSATION_NOT_FOUND", "RATE_LIMITED",
  "DAILY_LIMIT_REACHED", "GUIDE_NOT_CONFIGURED", "KNOWLEDGE_UNAVAILABLE",
  "AUTH_UNAVAILABLE", "INVALID_REQUEST",
]);

const DEFAULT_TIMEOUT_MS = 45000;
const MAX_TIMEOUT_MS = 90000;
const MAX_RESPONSE_CHARS = 100000;
const MAX_REPLY_CHARS = 4000;
const MAX_SOURCES = 10;

/** Reads the guide settings from an environment object. */
function readGuideConfig(env = process.env) {
  const flag = String(env.GUIDE_ENABLED ?? "").trim().toLowerCase() === "true";
  let url = null;
  try {
    const parsed = new URL(String(env.GUIDE_URL ?? "").trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      url = parsed.origin + parsed.pathname.replace(/\/+$/, "");
    }
  } catch { /* not a URL */ }

  const requested = Number(env.GUIDE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requested) && requested >= 500
    ? Math.min(Math.floor(requested), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  return { enabled: flag && !!url, requestedButNoUrl: flag && !url, url, timeoutMs };
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);

function cleanSource(source, fallbackNumber) {
  if (!isPlainObject(source)) return null;
  const url = typeof source.url === "string" ? source.url : "";
  if (!url.startsWith("https://")) return null;          // only secure web links reach the page
  const title = text(source.title, 300);
  if (!title) return null;
  return {
    n: Number.isInteger(source.n) && source.n > 0 ? source.n : fallbackNumber,
    title,
    url: url.slice(0, 500),
    note: text(source.note, 600),
    language: source.language === "ar" ? "ar" : "en",
    verification_status: text(source.verification_status, 40),
    time_sensitive: source.time_sensitive === true,
  };
}

/**
 * Rebuilds the Guide's answer from known fields only.
 * @returns {object|null} the clean answer, or null when it is not a valid Guide answer.
 */
function cleanGuideReply(data) {
  if (!isPlainObject(data)) return null;
  if (!KNOWN_STATUSES.has(data.status)) return null;
  if (typeof data.reply !== "string" || data.reply.length === 0 || data.reply.length > MAX_REPLY_CHARS) return null;
  if (typeof data.conversation_id !== "string" || !CONVERSATION_ID_RE.test(data.conversation_id)) return null;
  if (data.sources !== undefined && !Array.isArray(data.sources)) return null;

  const sources = [];
  (data.sources || []).slice(0, MAX_SOURCES).forEach((source, index) => {
    const clean = cleanSource(source, index + 1);
    if (clean) sources.push(clean);
  });

  let handoff = null;
  if (isPlainObject(data.handoff)) {
    handoff = {
      type: text(data.handoff.type, 40),
      action: text(data.handoff.action, 40),
      target: text(data.handoff.target, 40),
    };
  }

  return {
    status: data.status,
    reply: data.reply,
    sources,
    contains_time_sensitive: data.contains_time_sensitive === true,
    handoff,
    conversation_id: data.conversation_id,
    language: data.language === "en" ? "en" : "ar",
    register: KNOWN_REGISTERS.has(data.register) ? data.register : (data.language === "en" ? "en" : "ar"),
    enough_evidence: data.enough_evidence === true,
  };
}

/** Python's { error: CODE } body, reduced to a known code (or null). */
function errorCodeFrom(raw) {
  try {
    const code = JSON.parse(raw)?.error;
    return typeof code === "string" && KNOWN_ERROR_CODES.has(code) ? code : null;
  } catch {
    return null;
  }
}

function createGuideClient(config, { fetchImpl, logger = console } = {}) {
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  /**
   * @returns {Promise<
   *   {ok: true, data: object} |
   *   {ok: false, reason: string, status?: number, code?: string|null, retryAfter?: number}>}
   *   reason: "disabled" | "timeout" | "unreachable" | "rejected" | "bad_response"
   */
  async function chat({ token, message, conversationId }) {
    if (!config.enabled) return { ok: false, reason: "disabled" };

    const body = { message };
    if (conversationId) body.conversation_id = conversationId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      let res;
      try {
        res = await doFetch(`${config.url}/guide/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        const reason = error?.name === "AbortError" ? "timeout" : "unreachable";
        logger.error(`Guide call failed: ${reason}`);
        return { ok: false, reason };
      }

      if (!res.ok) {
        let raw = "";
        try { raw = (await res.text()).slice(0, 2000); } catch { /* ignore */ }
        const retryAfter = Number.parseInt(res.headers?.get?.("retry-after"), 10);
        logger.error(`Guide call rejected: HTTP ${res.status}`);
        return {
          ok: false,
          reason: "rejected",
          status: res.status,
          code: errorCodeFrom(raw),
          ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter: Math.min(retryAfter, 86400) } : {}),
        };
      }

      let parsed;
      try {
        const raw = await res.text();
        if (raw.length > MAX_RESPONSE_CHARS) throw new Error("too large");
        parsed = JSON.parse(raw);
      } catch (error) {
        const reason = error?.name === "AbortError" ? "timeout" : "bad_response";
        logger.error(`Guide call failed: ${reason}`);
        return { ok: false, reason };
      }

      const data = cleanGuideReply(parsed);
      if (!data) {
        logger.error("Guide call failed: bad_response");
        return { ok: false, reason: "bad_response" };
      }
      return { ok: true, data };
    } finally {
      clearTimeout(timer);
    }
  }

  return { enabled: config.enabled, chat };
}

module.exports = {
  readGuideConfig,
  createGuideClient,
  cleanGuideReply,
  KNOWN_STATUSES,
  CONVERSATION_ID_RE,
};
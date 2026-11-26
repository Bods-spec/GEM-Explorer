"use strict";

// Unit tests for backend/guide-client.js (no server, no network, no AI model).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readGuideConfig, createGuideClient, cleanGuideReply } = require("../backend/guide-client");
const { startFakeGuide, guideBody, CONV } = require("./helpers/fake-guide");

const TOKEN = "visitor-secret-token-123";
const MESSAGE = "Tell me about the Golden Throne";
const ON = { enabled: true, url: "http://127.0.0.1:9", timeoutMs: 1000 };

function silentLogger() {
  const lines = [];
  const push = (...a) => lines.push(a.join(" "));
  return { lines, error: push, warn: push, log: push, info: push };
}

const fakeFetch = (response, calls = []) => async (url, options) => {
  calls.push({ url, options });
  return typeof response === "function" ? response(url, options) : response;
};
const jsonResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

// ---------- configuration ----------

test("1. the Guide is OFF by default", () => {
  const config = readGuideConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.url, null);
});

test("2. GUIDE_ENABLED alone is not enough: it needs a valid http(s) GUIDE_URL", () => {
  assert.equal(readGuideConfig({ GUIDE_ENABLED: "true" }).enabled, false);
  assert.equal(readGuideConfig({ GUIDE_ENABLED: "true" }).requestedButNoUrl, true);
  assert.equal(readGuideConfig({ GUIDE_ENABLED: "true", GUIDE_URL: "not a url" }).enabled, false);
  assert.equal(readGuideConfig({ GUIDE_ENABLED: "true", GUIDE_URL: "ftp://example.com" }).enabled, false);
  assert.equal(readGuideConfig({ GUIDE_URL: "http://127.0.0.1:8000" }).enabled, false, "a URL alone does not turn it on");
  assert.equal(readGuideConfig({ GUIDE_ENABLED: "false", GUIDE_URL: "http://127.0.0.1:8000" }).enabled, false);
});

test("3. a valid setting turns it on and the URL is tidied", () => {
  const config = readGuideConfig({ GUIDE_ENABLED: " TRUE ", GUIDE_URL: "http://127.0.0.1:8000/" });
  assert.equal(config.enabled, true);
  assert.equal(config.url, "http://127.0.0.1:8000");
});

test("4. the timeout has a default and sane limits", () => {
  const base = { GUIDE_ENABLED: "true", GUIDE_URL: "http://127.0.0.1:8000" };
  assert.equal(readGuideConfig(base).timeoutMs, 45000);
  assert.equal(readGuideConfig({ ...base, GUIDE_TIMEOUT_MS: "20000" }).timeoutMs, 20000);
  assert.equal(readGuideConfig({ ...base, GUIDE_TIMEOUT_MS: "10" }).timeoutMs, 45000, "too small: default");
  assert.equal(readGuideConfig({ ...base, GUIDE_TIMEOUT_MS: "9999999" }).timeoutMs, 90000, "too large: capped");
  assert.equal(readGuideConfig({ ...base, GUIDE_TIMEOUT_MS: "abc" }).timeoutMs, 45000);
});

// ---------- the request ----------

test("5. disabled: no call is ever made", async () => {
  const calls = [];
  const client = createGuideClient({ enabled: false }, { fetchImpl: fakeFetch(jsonResponse(200, guideBody()), calls) });
  const result = await client.chat({ token: TOKEN, message: MESSAGE });
  assert.deepEqual(result, { ok: false, reason: "disabled" });
  assert.equal(calls.length, 0);
});

test("6. the request goes to /guide/chat with the visitor's token and only the message", async () => {
  const calls = [];
  const client = createGuideClient(ON, { fetchImpl: fakeFetch(jsonResponse(200, guideBody()), calls) });
  const result = await client.chat({ token: TOKEN, message: MESSAGE });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:9/guide/chat");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.redirect, "error", "never follows a redirect with the token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: MESSAGE }, "no user id, no extra fields");
});

test("7. a conversation id is forwarded only when there is one", async () => {
  const calls = [];
  const client = createGuideClient(ON, { fetchImpl: fakeFetch(jsonResponse(200, guideBody()), calls) });
  await client.chat({ token: TOKEN, message: MESSAGE, conversationId: CONV });
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: MESSAGE, conversation_id: CONV });
});

// ---------- the answer ----------

test("8. the Guide's fields are preserved", async () => {
  const client = createGuideClient(ON, { fetchImpl: fakeFetch(jsonResponse(200, guideBody())) });
  const { ok, data } = await client.chat({ token: TOKEN, message: MESSAGE });
  assert.equal(ok, true);
  assert.deepEqual(Object.keys(data).sort(), [
    "contains_time_sensitive", "conversation_id", "enough_evidence", "handoff",
    "language", "register", "reply", "sources", "status",
  ]);
  assert.equal(data.status, "answered");
  assert.equal(data.conversation_id, CONV);
  assert.equal(data.language, "en");
  assert.equal(data.enough_evidence, true);
  assert.deepEqual(data.sources[0], {
    n: 1,
    title: "Artefact: Golden Throne",
    url: "https://gem.eg/en/collection/artefacts/golden-throne",
    note: "Golden Throne",
    language: "en",
    verification_status: "verified",
    time_sensitive: false,
  });
});

test("9. a booking hand-over keeps its handoff object", () => {
  const data = cleanGuideReply(guideBody("To book, use the booking page.", {
    status: "handoff", sources: [], enough_evidence: false,
    handoff: { type: "booking", action: "book", target: "booking_system", secret: "x" },
  }));
  assert.deepEqual(data.handoff, { type: "booking", action: "book", target: "booking_system" });
  assert.equal(data.status, "handoff");
});

test("10. Egyptian Arabic fields pass through", () => {
  const data = cleanGuideReply(guideBody("المتحف بيفتح الساعة ٨:٣٠ [1]", { language: "ar", register: "eg", contains_time_sensitive: true }));
  assert.equal(data.language, "ar");
  assert.equal(data.register, "eg");
  assert.equal(data.contains_time_sensitive, true);
});

test("11. unknown fields from Python are dropped (nothing unexpected reaches the browser)", () => {
  const data = cleanGuideReply(guideBody("ok [1]", {
    trace: { notes: ["a"] }, api_key: "sk-secret", user_id: "u-1",
  }));
  assert.equal("trace" in data, false);
  assert.equal("api_key" in data, false);
  assert.equal("user_id" in data, false);
  assert.equal(JSON.stringify(data).includes("sk-secret"), false);
});

test("12. a source without a secure link or a title is dropped; the rest stay", () => {
  const good = guideBody().sources[0];
  const data = cleanGuideReply(guideBody("ok", {
    sources: [
      { ...good, n: 1, url: "http://insecure.example/x" },
      { ...good, n: 2, url: "javascript:alert(1)" },
      { ...good, n: 3, title: "" },
      "not an object",
      { ...good, n: 4, extra: "dropped" },
    ],
  }));
  assert.equal(data.sources.length, 1);
  assert.equal(data.sources[0].n, 4);
  assert.equal("extra" in data.sources[0], false);
});

test("13. an invalid Guide answer is refused", () => {
  assert.equal(cleanGuideReply(null), null);
  assert.equal(cleanGuideReply([]), null);
  assert.equal(cleanGuideReply(guideBody("x", { status: "mystery" })), null);
  assert.equal(cleanGuideReply(guideBody("")), null);
  assert.equal(cleanGuideReply(guideBody("x".repeat(4001))), null);
  assert.equal(cleanGuideReply(guideBody("x", { reply: 42 })), null);
  assert.equal(cleanGuideReply(guideBody("x", { conversation_id: "short" })), null);
  assert.equal(cleanGuideReply(guideBody("x", { conversation_id: "has spaces and ../ in it !!" })), null);
  assert.equal(cleanGuideReply(guideBody("x", { sources: "nope" })), null);
});

// ---------- failures ----------

test("14. rejected answers carry the status, a known error code and Retry-After", async () => {
  const client = createGuideClient(ON, {
    fetchImpl: fakeFetch(jsonResponse(429, { error: "RATE_LIMITED" }, { "retry-after": "17" })),
    logger: silentLogger(),
  });
  const result = await client.chat({ token: TOKEN, message: MESSAGE });
  assert.deepEqual(result, { ok: false, reason: "rejected", status: 429, code: "RATE_LIMITED", retryAfter: 17 });
});

test("15. an unknown error code or a body that is not JSON becomes code null", async () => {
  for (const body of [{ error: "SOMETHING_ELSE" }, "<html>oops</html>", { error: { nested: true } }]) {
    const client = createGuideClient(ON, { fetchImpl: fakeFetch(jsonResponse(500, body)), logger: silentLogger() });
    const result = await client.chat({ token: TOKEN, message: MESSAGE });
    assert.equal(result.reason, "rejected");
    assert.equal(result.code, null);
  }
});

test("16. a network failure is 'unreachable'", async () => {
  const client = createGuideClient(ON, {
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
    logger: silentLogger(),
  });
  assert.deepEqual(await client.chat({ token: TOKEN, message: MESSAGE }), { ok: false, reason: "unreachable" });
});

test("17. a slow Guide times out", async () => {
  const client = createGuideClient({ ...ON, timeoutMs: 50 }, {
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
    }),
    logger: silentLogger(),
  });
  assert.deepEqual(await client.chat({ token: TOKEN, message: MESSAGE }), { ok: false, reason: "timeout" });
});

test("18. bad JSON, a wrong shape and a huge body are 'bad_response'", async () => {
  for (const body of ["not json", { status: "answered" }, "x".repeat(100001), []]) {
    const client = createGuideClient(ON, { fetchImpl: fakeFetch(jsonResponse(200, body)), logger: silentLogger() });
    assert.deepEqual(await client.chat({ token: TOKEN, message: MESSAGE }), { ok: false, reason: "bad_response" });
  }
});

test("19. logs hold only a short reason: never the token, the message or the reply", async () => {
  const logger = silentLogger();
  const failures = [
    fakeFetch(jsonResponse(503, { error: "GUIDE_NOT_CONFIGURED" })),
    async () => { throw new TypeError(`fetch failed for Bearer ${TOKEN} ${MESSAGE}`); },
    fakeFetch(jsonResponse(200, "garbage with " + MESSAGE)),
  ];
  for (const fetchImpl of failures) {
    await createGuideClient(ON, { fetchImpl, logger }).chat({ token: TOKEN, message: MESSAGE });
  }
  assert.ok(logger.lines.length >= 3);
  const all = logger.lines.join("\n");
  assert.equal(all.includes(TOKEN), false);
  assert.equal(all.includes("Golden Throne"), false);
});

// ---------- against the fake Python Guide over real HTTP ----------

test("20. against the fake Guide: a good token works, an unknown token is rejected with 401", async () => {
  const fake = await startFakeGuide({ validTokens: [TOKEN] });
  try {
    const client = createGuideClient({ enabled: true, url: fake.url, timeoutMs: 2000 }, { logger: silentLogger() });
    const ok = await client.chat({ token: TOKEN, message: MESSAGE });
    assert.equal(ok.ok, true);
    const bad = await client.chat({ token: "someone-else", message: MESSAGE });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 401);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[0].token, TOKEN);
  } finally {
    await fake.close();
  }
});
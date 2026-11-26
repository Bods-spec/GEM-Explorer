"use strict";

// POST /api/ai/guide through the REAL backend/server.js, with the in-memory
// Supabase fake and a FAKE Python Guide (helpers/fake-guide.js). Nothing here
// touches real Supabase, real OpenAI or the real Python service.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server-harness");
const { startFakeGuide, guideBody, CONV } = require("./helpers/fake-guide");

const ROUTE = "/api/ai/guide";
const GUEST_TOKEN = "guest-guide-token";
const GUEST_ID = "88888888-8888-4888-8888-888888888888";
const MESSAGE = "Tell me about the Golden Throne";

let h;
let guide;

// Capture everything the server prints, to prove no token or visitor text is logged.
const printed = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };

test.before(async () => {
  for (const name of Object.keys(realConsole)) {
    console[name] = (...args) => { printed.push(args.map(String).join(" ")); };
  }
  guide = await startFakeGuide({ validTokens: ["test-token-user-a", "test-token-user-b", GUEST_TOKEN] });
  h = await startServer({ guide, guideTimeoutMs: 600 });
  h.db.guestTokens.set(GUEST_TOKEN, GUEST_ID);
});
test.after(async () => {
  await h.close();
  await guide.close();
  Object.assign(console, realConsole);
});

const ask = (token, body) => h.api("POST", ROUTE, { token, body });
const before = () => guide.requests.length;
const lastCall = () => guide.requests[guide.requests.length - 1];

// ---------- authentication ----------

test("1. no token: 401 and the Guide is never called", async () => {
  const n = before();
  const r = await h.api("POST", ROUTE, { body: { message: MESSAGE } });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: "UNAUTHORIZED" });
  assert.equal(guide.requests.length, n);
});

test("2. a fake or malformed token: 401 and the Guide is never called", async () => {
  const n = before();
  for (const header of ["Bearer not-a-real-token", "Basic abc", "Bearer", "token-without-scheme"]) {
    const r = await h.api("POST", ROUTE, { body: { message: MESSAGE }, headers: { Authorization: header } });
    assert.equal(r.status, 401, header);
  }
  assert.equal(guide.requests.length, n);
});

test("3. a valid login: 200 with the Guide's fields, and the visitor's own token is forwarded", async () => {
  const r = await ask(h.TOKEN_A, { message: MESSAGE });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "answered");
  assert.equal(r.json.reply, guideBody().reply);
  assert.equal(r.json.conversation_id, CONV);
  assert.equal(r.json.language, "en");
  assert.equal(r.json.register, "en");
  assert.equal(r.json.enough_evidence, true);
  assert.equal(r.json.handoff, null);
  assert.equal(r.json.sources.length, 1);
  assert.equal(r.json.sources[0].url, "https://gem.eg/en/collection/artefacts/golden-throne");
  assert.equal(lastCall().auth, `Bearer ${h.TOKEN_A}`);
  assert.equal(lastCall().url, "/guide/chat");
});

test("4. only the message (and a given conversation id) are forwarded: never a user id or extra fields", async () => {
  await ask(h.TOKEN_A, { message: `  ${MESSAGE}  `, user_id: h.USER_B, language: "ar", role: "admin", conversation_id: CONV });
  assert.deepEqual(lastCall().body, { message: MESSAGE, conversation_id: CONV });
  await ask(h.TOKEN_A, { message: MESSAGE });
  assert.deepEqual(lastCall().body, { message: MESSAGE }, "no id key at all on a first message");
  await ask(h.TOKEN_A, { message: MESSAGE, conversation_id: null });
  assert.deepEqual(lastCall().body, { message: MESSAGE });
  assert.equal(lastCall().rawBody.includes(h.USER_A), false);
  assert.equal(lastCall().rawBody.includes(h.USER_B), false);
});

// ---------- validation ----------

test("5. a bad request is refused with 400 and the Guide is never called", async () => {
  const n = before();
  const bad = [
    {},
    { message: "" },
    { message: "   " },
    { message: 42 },
    { message: ["a"] },
    { message: "x".repeat(501) },
    { message: MESSAGE, conversation_id: 123 },
    { message: MESSAGE, conversation_id: "short" },
    { message: MESSAGE, conversation_id: "x".repeat(65) },
    { message: MESSAGE, conversation_id: "has spaces and slashes/../ ok" },
    { message: MESSAGE, conversation_id: {} },
  ];
  for (const body of bad) {
    const r = await ask(h.TOKEN_A, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.deepEqual(r.json, { error: "INVALID_GUIDE_REQUEST" });
  }
  assert.equal(guide.requests.length, n);
});

test("6. exactly 500 characters is allowed", async () => {
  const r = await ask(h.TOKEN_A, { message: "a".repeat(500) });
  assert.equal(r.status, 200);
});

test("7. a body that is not JSON is refused before the Guide", async () => {
  const n = before();
  const wrongType = await h.realFetch(h.base + ROUTE, {
    method: "POST", headers: { Authorization: `Bearer ${h.TOKEN_A}`, "Content-Type": "text/plain" }, body: "hello",
  });
  assert.equal(wrongType.status, 415);
  const broken = await h.api("POST", ROUTE, { token: h.TOKEN_A, raw: "{not json" });
  assert.ok(broken.status >= 400 && broken.status < 500);
  const huge = await h.api("POST", ROUTE, { token: h.TOKEN_A, raw: JSON.stringify({ message: "x".repeat(20000) }) });
  assert.equal(huge.status, 413);
  assert.equal(guide.requests.length, n);
});

// ---------- the Guide's answer ----------

test("8. a booking hand-over passes through", async () => {
  guide.queue({ body: guideBody("To book, please use the booking page.", {
    status: "handoff", sources: [], enough_evidence: false,
    handoff: { type: "booking", action: "book", target: "booking_system" },
  }) });
  const r = await ask(h.TOKEN_A, { message: "I want to book 2 tickets" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "handoff");
  assert.deepEqual(r.json.handoff, { type: "booking", action: "book", target: "booking_system" });
  assert.deepEqual(r.json.sources, []);
});

test("9. a 'not enough evidence' answer and Egyptian Arabic pass through", async () => {
  guide.queue({ body: guideBody("مش لاقي المعلومة دي في مصادري.", {
    status: "insufficient_evidence", sources: [], enough_evidence: false, language: "ar", register: "eg",
  }) });
  const r = await ask(h.TOKEN_A, { message: "المتحف فيه مطعم؟" });
  assert.equal(r.json.status, "insufficient_evidence");
  assert.equal(r.json.language, "ar");
  assert.equal(r.json.register, "eg");
  assert.equal(r.json.enough_evidence, false);
});

test("10. the browser only gets known fields and secure source links", async () => {
  guide.queue({ body: guideBody("ok [1]", {
    trace: { notes: ["internal"] }, api_key: "sk-secret",
    sources: [
      { ...guideBody().sources[0] },
      { ...guideBody().sources[0], n: 2, url: "http://insecure.example/x" },
    ],
  }) });
  const r = await ask(h.TOKEN_A, { message: MESSAGE });
  assert.equal(r.status, 200);
  assert.equal("trace" in r.json, false);
  assert.equal("api_key" in r.json, false);
  assert.equal(JSON.stringify(r.json).includes("sk-secret"), false);
  assert.equal(r.json.sources.length, 1);
});

// ---------- Python errors ----------

test("11. an expired or unknown conversation: 404 CONVERSATION_NOT_FOUND", async () => {
  guide.queue({ status: 404, body: { error: "CONVERSATION_NOT_FOUND" } });
  const r = await ask(h.TOKEN_A, { message: MESSAGE, conversation_id: CONV });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "CONVERSATION_NOT_FOUND" });
});

test("12. a rate limit: 429 with Retry-After; the daily limit has its own code", async () => {
  guide.queue({ status: 429, body: { error: "RATE_LIMITED" }, headers: { "Retry-After": "23" } });
  const raw = await h.realFetch(h.base + ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.TOKEN_A}` },
    body: JSON.stringify({ message: MESSAGE }),
  });
  assert.equal(raw.status, 429);
  assert.equal(raw.headers.get("retry-after"), "23");
  assert.deepEqual(await raw.json(), { error: "RATE_LIMITED" });

  guide.queue({ status: 429, body: { error: "DAILY_LIMIT_REACHED" }, headers: { "Retry-After": "3600" } });
  const daily = await ask(h.TOKEN_A, { message: MESSAGE });
  assert.equal(daily.status, 429);
  assert.deepEqual(daily.json, { error: "DAILY_LIMIT_REACHED" });

  guide.queue({ status: 429, body: "weird" });
  const odd = await ask(h.TOKEN_A, { message: MESSAGE });
  assert.equal(odd.status, 429);
  assert.deepEqual(odd.json, { error: "RATE_LIMITED" });
});

test("13. Python refuses the token (401) or the guest (403): the visitor sees a clean 401 / 403", async () => {
  guide.queue({ status: 401, body: { error: "UNAUTHORIZED" } });
  const a = await ask(h.TOKEN_A, { message: MESSAGE });
  assert.equal(a.status, 401);
  assert.deepEqual(a.json, { error: "UNAUTHORIZED" });

  guide.queue({ status: 403, body: { error: "GUESTS_NOT_ALLOWED" } });
  const b = await ask(h.TOKEN_A, { message: MESSAGE });
  assert.equal(b.status, 403);
  assert.deepEqual(b.json, { error: "GUESTS_NOT_ALLOWED" });
});

test("14. Python failures give a safe 503 that leaks nothing", async () => {
  const failures = [
    { status: 500, body: { error: "boom", detail: "Traceback sk-secret supabase.co" } },
    { status: 502, body: { error: "KNOWLEDGE_UNAVAILABLE" } },
    { status: 503, body: { error: "GUIDE_NOT_CONFIGURED" } },
    { status: 503, body: { error: "AUTH_UNAVAILABLE" } },
    { status: 200, raw: "this is not json" },
    { status: 200, body: { status: "answered" } },
    { status: 200, body: guideBody("x", { conversation_id: "bad id!" }) },
    { destroy: true },
  ];
  for (const failure of failures) {
    guide.queue(failure);
    const r = await ask(h.TOKEN_A, { message: MESSAGE });
    assert.equal(r.status, 503, JSON.stringify(failure).slice(0, 60));
    assert.deepEqual(r.json, { error: "GUIDE_UNAVAILABLE" });
  }
});

test("15. a slow Guide: 504 GUIDE_TIMEOUT", async () => {
  guide.queue({ delayMs: 1500, body: guideBody() });
  const r = await ask(h.TOKEN_A, { message: MESSAGE });
  assert.equal(r.status, 504);
  assert.deepEqual(r.json, { error: "GUIDE_TIMEOUT" });
  await new Promise((resolve) => setTimeout(resolve, 1100));   // let the slow fake finish before the next test
});

// ---------- guests and isolation ----------

test("16. Guest Mode: a real guest session is accepted and forwarded; with Guest Mode off it is refused", async () => {
  process.env.ALLOW_GUEST_USERS = "true";
  try {
    const ok = await ask(GUEST_TOKEN, { message: MESSAGE });
    assert.equal(ok.status, 200);
    assert.equal(lastCall().token, GUEST_TOKEN);
  } finally {
    delete process.env.ALLOW_GUEST_USERS;
  }
  const n = before();
  const off = await ask(GUEST_TOKEN, { message: MESSAGE });
  assert.equal(off.status, 401, "guests are refused again once Guest Mode is off");
  assert.equal(guide.requests.length, n, "and the Guide was not called");
});

test("17. Guest Mode is refused outside local development (production, or a non-localhost frontend)", async () => {
  process.env.ALLOW_GUEST_USERS = "true";
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const n = before();
    const r = await ask(GUEST_TOKEN, { message: MESSAGE });
    assert.equal(r.status, 401);
    assert.equal(guide.requests.length, n);
  } finally {
    delete process.env.ALLOW_GUEST_USERS;
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
  }
});

test("18. one user cannot continue another user's conversation (each token is forwarded as is)", async () => {
  const owners = new Map();
  const privateConversation = (body, token) => {
    const id = body.conversation_id;
    if (!id) { owners.set(CONV, token); return { body: guideBody() }; }
    if (owners.get(id) !== token) return { status: 404, body: { error: "CONVERSATION_NOT_FOUND" } };
    return { body: guideBody("Continued. [1]") };
  };
  guide.queue(privateConversation, privateConversation, privateConversation);

  const start = await ask(h.TOKEN_A, { message: MESSAGE });
  assert.equal(start.status, 200);
  const stolen = await ask(h.TOKEN_B, { message: "and more?", conversation_id: CONV });
  assert.equal(stolen.status, 404);
  assert.deepEqual(stolen.json, { error: "CONVERSATION_NOT_FOUND" });
  const mine = await ask(h.TOKEN_A, { message: "and more?", conversation_id: CONV });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.reply, "Continued. [1]");
  const calls = guide.requests.slice(-3);
  assert.deepEqual(calls.map((c) => c.token), [h.TOKEN_A, h.TOKEN_B, h.TOKEN_A]);
});

// ---------- nothing else changes ----------

test("19. the Guide route reads and writes no database table and calls nothing but the Guide", async () => {
  const tablesBefore = JSON.stringify(h.db.tables);
  await ask(h.TOKEN_A, { message: MESSAGE });
  assert.equal(JSON.stringify(h.db.tables), tablesBefore);
  assert.deepEqual(h.outgoing, [], "no other outgoing request (no OpenAI, no n8n)");
});

test("20. existing routes are unchanged and the Booking Agent never calls the Guide", async () => {
  const health = await h.api("GET", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.status, "running");

  const noAuth = await h.api("GET", "/api/bookings");
  assert.equal(noAuth.status, 401);
  const list = await h.api("GET", "/api/bookings", { token: h.TOKEN_A });
  assert.equal(list.status, 200);

  const n = before();
  const conv = "booking-conversation-0001";
  const chat = await h.chat(h.TOKEN_A, conv, "I want to book 2 tickets for tomorrow");
  assert.equal(chat.status, 200);
  assert.equal(guide.requests.length, n, "booking messages never go to the Guide");

  assert.equal((await h.api("GET", ROUTE, { token: h.TOKEN_A })).status, 404, "GET is not a Guide route");
  assert.equal((await h.api("POST", "/api/ai/guide/extra", { token: h.TOKEN_A, body: { message: "x" } })).status, 404);
});

test("21. CORS: the Guide route answers only the configured frontend origin", async () => {
  const preflight = await h.realFetch(h.base + ROUTE, {
    method: "OPTIONS",
    headers: { Origin: h.ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), h.ORIGIN);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/);

  const stranger = await h.realFetch(h.base + ROUTE, {
    method: "POST",
    headers: { Origin: "http://evil.example", "Content-Type": "application/json", Authorization: `Bearer ${h.TOKEN_A}` },
    body: JSON.stringify({ message: MESSAGE }),
  });
  assert.equal(stranger.status, 403);
});

test("22. nothing printed by the server contains a token, the visitor's message or the Guide's reply", () => {
  const all = printed.join("\n");
  for (const secret of [h.TOKEN_A, h.TOKEN_B, GUEST_TOKEN, "sk-secret", MESSAGE, "wooden armchair", "Traceback"]) {
    assert.equal(all.includes(secret), false, `log contains ${secret}`);
  }
  assert.ok(printed.length > 0, "the failure cases did log something short");
});
"use strict";

// Starts the REAL backend/server.js with the in-memory Supabase fake.
// No network, no Supabase, no n8n.

const path = require("node:path");
const net = require("node:net");
const { createFakeDb, installSupabaseMock } = require("./fake-supabase");

const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = "test-token-user-a";
const TOKEN_B = "test-token-user-b";
const ORIGIN = "http://localhost:5600";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

/**
 * @param {{ planner?: { url: string }, plannerTimeoutMs?: number,
 *           guide?: { url: string }, guideTimeoutMs?: number }} [options]
 *   planner: a fake planner (see fake-planner.js). Without it the planner
 *   feature flag is OFF, exactly like a normal install.
 *   guide: a fake Python Guide (see fake-guide.js). Without it the Guide
 *   feature flag is OFF, exactly like a normal install.
 */
async function startServer({ planner, plannerTimeoutMs, guide, guideTimeoutMs } = {}) {
  const db = createFakeDb();
  db.tokens.set(TOKEN_A, USER_A);
  db.tokens.set(TOKEN_B, USER_B);
  const restoreSdk = installSupabaseMock(db, BACKEND);

  // Dummy values: nothing here is ever sent anywhere.
  process.env.SUPABASE_URL = "http://supabase.invalid";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_TEST";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_TEST";

  // ISOLATION: the tests must never read the developer's real backend/.env.
  // server.js calls require("dotenv").config() when it is loaded, which would
  // refill every setting deleted below (GUIDE_ENABLED, PLANNER_ENABLED,
  // ALLOW_GUEST_USERS, PORT...) from a real .env. So dotenv is replaced by a
  // no-op while server.js loads (see below). Start from a clean slate:
  for (const name of ["ALLOW_GUEST_USERS", "ENABLE_DIRECT_BOOKING_API", "NODE_ENV"]) {
    delete process.env[name];
  }

  // Proof that the chatbot needs no n8n/AI: no n8n settings, and any
  // outgoing fetch() fails the test (except calls to the fake planner,
  // and only when one is enabled).
  delete process.env.N8N_WEBHOOK_URL;
  delete process.env.N8N_WEBHOOK_SECRET;
  delete process.env.PLANNER_ENABLED;
  delete process.env.PLANNER_URL;
  delete process.env.PLANNER_TIMEOUT_MS;
  if (planner) {
    process.env.PLANNER_ENABLED = "true";
    process.env.PLANNER_URL = planner.url;
    if (plannerTimeoutMs) process.env.PLANNER_TIMEOUT_MS = String(plannerTimeoutMs);
  }
  delete process.env.GUIDE_ENABLED;
  delete process.env.GUIDE_URL;
  delete process.env.GUIDE_TIMEOUT_MS;
  if (guide) {
    process.env.GUIDE_ENABLED = "true";
    process.env.GUIDE_URL = guide.url;
    if (guideTimeoutMs) process.env.GUIDE_TIMEOUT_MS = String(guideTimeoutMs);
  }
  const outgoing = [];
  const realFetch = global.fetch;
  global.fetch = (...args) => {
    const target = String(args[0]);
    if (planner && target.startsWith(planner.url)) return realFetch(...args);
    if (guide && target.startsWith(guide.url)) return realFetch(...args);
    outgoing.push(target);
    throw new Error("fetch must not be called");
  };

  const port = await freePort();
  process.env.PORT = String(port);
  process.env.FRONTEND_ORIGIN = ORIGIN;

  // Load server.js with dotenv switched off, then put dotenv back.
  const dotenvPath = require.resolve("dotenv", { paths: [BACKEND] });
  const realDotenv = require.cache[dotenvPath];
  require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, exports: { config: () => ({ parsed: {} }) } };
  let loaded;
  try {
    loaded = require(path.join(BACKEND, "server.js"));
  } finally {
    if (realDotenv) require.cache[dotenvPath] = realDotenv; else delete require.cache[dotenvPath];
  }
  const { server, start } = loaded;
  start();

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i += 1) {
    try { if ((await realFetch(`${base}/api/health`)).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 40));
  }

  async function api(method, route, { token, body, headers = {}, raw } = {}) {
    const res = await realFetch(base + route, {
      method,
      headers: {
        ...(body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json, data: json?.data };
  }

  /** Send one chat message. */
  const chat = (token, conversationId, message, extra = {}) =>
    api("POST", "/api/ai/chat", { token, body: { message, conversation_id: conversationId, language: "ar", ...extra } });

  const close = () => new Promise((resolve) => {
    global.fetch = realFetch;
    restoreSdk();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

  return { db, api, chat, close, outgoing, realFetch, base, USER_A, USER_B, TOKEN_A, TOKEN_B, ORIGIN };
}

module.exports = { startServer, USER_A, USER_B, TOKEN_A, TOKEN_B };
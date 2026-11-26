"use strict";

// =====================================================
// IN-MEMORY TEST BACKEND (local development only)
//
//   node tests/dev-memory-server.js
//
// Runs the REAL backend/server.js and the REAL backend/chatbot.js, but
// with a fake in-memory database instead of Supabase. Nothing is saved
// anywhere: stop the process and every booking disappears.
//
// It also serves the frontend on http://localhost:5600 so one command
// is enough (set NO_STATIC=1 if you serve the frontend yourself).
//
// Use it with   mode: 'memory'   in frontend/js/guest-config.js.
// It accepts ONLY the throw-away "dev-guest-<uuid>" tokens made by
// guest-auth.js in memory mode. It does not need (or read) your .env.
// NEVER deploy this file.
// =====================================================

const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const { createFakeDb, createFakeSupabase } = require("./helpers/fake-supabase");

const BACKEND = path.resolve(__dirname, "..", "backend");
const FRONTEND = path.resolve(process.env.FRONTEND_DIR || path.join(__dirname, "..", "..", "frontend"));

const db = createFakeDb();
const fakeDatabase = createFakeSupabase(db);
const memoryAuth = {
  auth: {
    async getUser(token) {
      const m = /^dev-guest-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(String(token));
      return m
        ? { data: { user: { id: m[1], is_anonymous: true } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } };
    },
  },
};

// server.js creates its two Supabase clients when it loads, so the SDK is
// replaced first. The real SDK is installed in backend/node_modules.
const sdk = require(require.resolve("@supabase/supabase-js", { paths: [BACKEND] }));
sdk.createClient = (url, key) => (String(key).includes("publishable") ? memoryAuth : fakeDatabase);

// Dummy values: nothing here is ever sent anywhere.
process.env.SUPABASE_URL = "http://supabase.invalid";
process.env.SUPABASE_SECRET_KEY = "sb_secret_MEMORY_MODE";
process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_MEMORY_MODE";
process.env.ALLOW_GUEST_USERS = "true";
process.env.PORT = process.env.PORT || "3001";
process.env.FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5600";
delete process.env.N8N_WEBHOOK_URL;
delete process.env.N8N_WEBHOOK_SECRET;

require(path.join(BACKEND, "server.js")).start();

if (process.env.NO_STATIC !== "1") {
  const MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  };
  http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/visit.html";
    const file = path.join(FRONTEND, p);
    if (!file.startsWith(FRONTEND) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }).listen(5600, () => {
    console.log("Frontend:  http://localhost:5600/visit.html");
    console.log("In-memory test backend: NOTHING is saved to Supabase. Bookings vanish when you stop this process.");
    console.log("Set mode: 'memory' in frontend/js/guest-config.js to use it.");
  });
}
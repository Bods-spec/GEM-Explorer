"use strict";

// =====================================================
// Local test helper: sign in with YOUR existing Supabase Auth user, then
// run the cross-service checks in smoke-test-planning.js with that
// user's fresh access token.
//
//   node run-planning-smoke.js
//
// What it does
//   1. Reads SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (only these two)
//      from backend/.env. It never reads or uses the service-role/secret key.
//   2. Asks for your Supabase Auth email (visible) and password (hidden).
//   3. Signs in with supabase.auth.signInWithPassword (normal login).
//   4. Keeps the access token in memory only and hands it to
//      smoke-test-planning.js through a private environment variable of
//      that one child process.
//   5. Prints PASS/FAIL lines only.
//
// Never printed, logged or saved: the password, the access token, the
// refresh token. The report file contains no token either.
// Nothing is changed in your frontend, database, Booking Agent or Planner.
// Planning-only messages are sent, so no draft or booking is created.
//
// Start the Python service and Node first (see PHASE_B.md).
// =====================================================

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

const SMOKE = path.join(__dirname, "smoke-test-planning.js");

/** Only the two public settings are taken from .env (never the secret key). */
function readPublicSettings(envPath = path.join(__dirname, ".env")) {
  let file = {};
  try { file = dotenv.parse(fs.readFileSync(envPath)); } catch { /* no .env: fall back to the shell */ }
  return {
    url: (file.SUPABASE_URL || process.env.SUPABASE_URL || "").trim(),
    publishableKey: (file.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "").trim(),
  };
}

function askVisible(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return resolve("");
    process.stdout.write(prompt);
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

const report = (ok, text) => console.log(`${ok ? "PASS" : "FAIL"}  ${text}`);

/** Sign in; returns { token, userId } (kept in memory), or null. */
async function signInSession({ url, publishableKey, email, password }) {
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data?.session?.access_token) return null;
  return { token: data.session.access_token, userId: data.user?.id ?? data.session.user?.id ?? null };
}

/** Sign in and return the access token (kept in memory), or null. */
async function signIn(args) {
  const session = await signInSession(args);
  return session ? session.token : null;
}

/** Runs smoke-test-planning.js; shows only its PASS/FAIL lines. Resolves with the exit code. */
function runSmoke(token, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SMOKE], {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv, SMOKE_TEST_ACCESS_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    const show = (chunk) => {
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (/^(PASS|FAIL)\s/.test(line) || /^(All checks passed|\d+ check\(s\) FAILED)/.test(line)) {
          console.log(line.split(token).join("[hidden]"));
        }
      }
    };
    child.stdout.on("data", show);
    child.stderr.on("data", () => { /* never echo child errors: they could carry request details */ });
    child.on("error", () => { report(false, "Could not start smoke-test-planning.js"); resolve(1); });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const { url, publishableKey } = readPublicSettings();
  if (!url || !publishableKey) {
    report(false, "SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not found in backend\\.env");
    process.exitCode = 1;
    return;
  }

  const email = await askVisible("Supabase Auth user email: ");
  let password = await askHidden("Password (hidden): ");
  if (!email || !password) {
    report(false, "Email and password are both required");
    process.exitCode = 1;
    return;
  }

  let token = null;
  try {
    token = await signIn({ url, publishableKey, email, password });
  } catch {
    token = null;
  }
  password = null; // the password is no longer needed

  if (!token) {
    report(false, "Sign in with Supabase Auth (email or password not accepted, or Supabase unreachable)");
    process.exitCode = 1;
    return;
  }
  report(true, "Sign in with Supabase Auth (fresh access token held in memory only)");

  const code = await runSmoke(token);
  token = null;
  process.exitCode = code;
}

if (require.main === module) {
  main();
}

module.exports = { readPublicSettings, signIn, signInSession, runSmoke, askVisible, askHidden };
"use strict";

// Starts the REAL `node server.js` as a separate process with a clean
// environment (no n8n, no AI keys, fake Supabase values) and checks it.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

const BACKEND = path.resolve(__dirname, "../backend");
const SERVER_FILE = path.join(BACKEND, "server.js");

// ISOLATION: server.js loads ".env" from the folder the process is started in.
// These tests start it from a new EMPTY folder, so a developer's real
// backend/.env (and its PORT, which may already be in use by the running
// development server) can never leak in.
const emptyFolder = () => fs.mkdtempSync(path.join(os.tmpdir(), "gem-startup-test-"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CLEAN-UP (Windows): a folder cannot be deleted while a process still uses it
// as its working directory, and Windows can keep it locked for a moment after
// the process ends (EBUSY / EPERM / ENOTEMPTY). So:
//   1. stopChild() waits until the child process has really exited;
//   2. removeFolder() retries the delete for up to 10 seconds on those errors;
//   3. a folder that STILL cannot be deleted fails the test (never ignored).
const LOCK_ERRORS = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;       // already ended
  const ended = new Promise((resolve) => child.once("close", resolve));   // exited and its pipes are closed
  child.kill();
  await Promise.race([ended, sleep(10000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([ended, sleep(5000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("the server process did not stop, so its temporary folder cannot be removed");
  }
}

async function removeFolder(folder, { attempts = 40, delayMs = 250 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!LOCK_ERRORS.has(error.code) || attempt >= attempts) {
        throw new Error(`could not remove the temporary folder ${folder} after ${attempt} attempt(s): ${error.code || error.message}`);
      }
      await sleep(delayMs);
    }
  }
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test("the server starts with only the three Supabase settings (no n8n) and answers", async () => {
  const port = await freePort();
  const cwd = emptyFolder();
  const child = spawn(process.execPath, [SERVER_FILE], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_SECRET_KEY: "sb_secret_FAKE",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_FAKE",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  try {
    let health;
    for (let i = 0; i < 60 && !health; i += 1) {
      try { health = await fetch(`http://127.0.0.1:${port}/api/health`); } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.ok(health, "server did not start: " + output);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "running");
    const chat = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(chat.status, 401, "no token, no access");
    assert.doesNotMatch(output, /n8n/i);
  } finally {
    await stopChild(child);
    await removeFolder(cwd);
  }
});

test("missing Supabase settings stop the server with a clear message and no secret values", async () => {
  const cwd = emptyFolder();
  const r = spawnSync(process.execPath, [SERVER_FILE], {
    cwd,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  await removeFolder(cwd);       // spawnSync returns only after the process has ended
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SUPABASE_URL/);
  assert.match(r.stderr, /SUPABASE_SECRET_KEY/);
  assert.match(r.stderr, /SUPABASE_PUBLISHABLE_KEY/);
});

test("both application files pass a syntax check", () => {
  for (const file of ["server.js", "chatbot.js"]) {
    const r = spawnSync(process.execPath, ["--check", path.join(BACKEND, file)], { encoding: "utf8" });
    assert.equal(r.status, 0, file + ": " + r.stderr);
  }
});
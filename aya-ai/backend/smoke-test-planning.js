"use strict";

// =====================================================
// REAL cross-service JWT test (Node.js Booking Agent -> Python planner)
//
// Proves that ONE valid Supabase access token is accepted by BOTH services:
//   1. Python  POST /planner/turn          (token checked by Python itself)
//   2. Node    POST /api/ai/chat           (token checked by Node, then forwarded
//                                           to Python, which checks it again)
//   3. A wrong or tampered token is refused by both.
//
// Safe by design:
//   * The token is read from a HIDDEN prompt (or SMOKE_TEST_ACCESS_TOKEN).
//     It is never printed, never written to the report, never put in a URL.
//   * Only PLANNING-ONLY messages are sent, so NOTHING is written to your
//     database: no booking, no draft. (Combined planning + booking tests
//     come later, in Phase C, with your approval.)
//   * Uses the real planner, so it makes a few real model calls.
//
// Before running, start BOTH services (see PHASE_B.md):
//   Python: uvicorn on http://127.0.0.1:8000
//   Node  : PLANNER_ENABLED=true PLANNER_URL=http://127.0.0.1:8000
//
// Optional settings: NODE_URL (default http://127.0.0.1:3001),
//                    PLANNER_URL (default http://127.0.0.1:8000)
// Report: smoke_test_planning_report.txt (no token, no personal data).
// =====================================================

const fs = require("node:fs");
const crypto = require("node:crypto");

const NODE_URL = (process.env.NODE_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
const PYTHON_URL = (process.env.PLANNER_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const REPORT = "smoke_test_planning_report.txt";
const TIMEOUT_MS = 90000;

const results = [];
const note = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

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
          return resolve(buf.trim());
        }
        if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function post(url, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  } catch (error) {
    return { status: 0, json: null, error: error.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function get(url) {
  try { const res = await fetch(url); return { status: res.status }; } catch { return { status: 0 }; }
}

const conv = () => `smoke-${crypto.randomBytes(8).toString("hex")}`;

function tamper(token) {
  const last = token.slice(-1);
  return token.slice(0, -1) + (last === "A" ? "B" : "A");
}

(async () => {
  let token = (process.env.SMOKE_TEST_ACCESS_TOKEN || "").trim();
  if (!token) token = await askHidden("Paste a valid Supabase access token (hidden; leave empty to skip): ");
  if (!token) {
    console.log("No token given: valid-token checks skipped. Nothing was tested.");
    process.exit(0);
  }

  console.log(`\nNode   : ${NODE_URL}\nPython : ${PYTHON_URL}\n`);

  // ---- services up? -------------------------------------------------------
  const nodeHealth = await get(`${NODE_URL}/api/health`);
  note("Node.js backend is running", nodeHealth.status === 200, `HTTP ${nodeHealth.status}`);
  if (nodeHealth.status !== 200) return finish(token);

  // ---- 1. Python accepts the token on its own -------------------------------
  const direct = await post(`${PYTHON_URL}/planner/turn`, token, {
    message: "Plan a 90 minute visit for me", conversation_id: conv(), language: "en", booking_handled: false,
  });
  note("Python accepts a valid token directly", direct.status === 200, `HTTP ${direct.status}${direct.error ? ` ${direct.error}` : ""}`);
  const pyStatus = direct.json?.status;
  note("Python returned a real planner answer", direct.status === 200 && typeof direct.json?.reply === "string" && pyStatus !== "unavailable",
    `status=${pyStatus}`);

  // ---- 2. Node accepts it and forwards it ---------------------------------------
  const viaNode = await post(`${NODE_URL}/api/ai/chat`, token, {
    message: "Plan a 90 minute visit for me", conversation_id: conv(), language: "en",
  });
  note("Node accepts a valid token", viaNode.status === 200, `HTTP ${viaNode.status}${viaNode.error ? ` ${viaNode.error}` : ""}`);
  const nodeStatus = viaNode.json?.data?.planner_status;
  note("Node forwarded it and Python accepted it (planner answered)", ["plan_created", "needs_clarification", "not_possible", "plan_updated"].includes(nodeStatus),
    `planner_status=${nodeStatus}`);
  note("A plan request writes nothing to the booking draft", viaNode.json?.data?.draft_saved === false);
  note("Duration was not read as a visitor count", viaNode.json?.data?.extracted?.ticket_count === null);

  // ---- 3. Arabic follow-up through Node -------------------------------------------
  const c2 = conv();
  const ar1 = await post(`${NODE_URL}/api/ai/chat`, token, { message: "عايز خطة للزيارة", conversation_id: c2, language: "ar" });
  const ar2 = await post(`${NODE_URL}/api/ai/chat`, token, { message: "عندي ساعتين", conversation_id: c2, language: "ar" });
  note("Arabic planning conversation works through Node", ar1.status === 200 && ar2.status === 200 &&
    ["plan_created", "needs_clarification"].includes(ar2.json?.data?.planner_status), `statuses ${ar1.json?.data?.planner_status} -> ${ar2.json?.data?.planner_status}`);
  note("The two-hour duration was not read as 2 visitors", ar2.json?.data?.extracted?.ticket_count === null);

  // ---- 4. wrong tokens are refused by both -------------------------------------------
  const bad = tamper(token);
  const pyBad = await post(`${PYTHON_URL}/planner/turn`, bad, { message: "Plan a visit", conversation_id: conv(), language: "en" });
  note("Python refuses a tampered token", pyBad.status === 401 || pyBad.status === 403, `HTTP ${pyBad.status}`);
  const nodeBad = await post(`${NODE_URL}/api/ai/chat`, bad, { message: "Plan a visit", conversation_id: conv(), language: "en" });
  note("Node refuses a tampered token", nodeBad.status === 401, `HTTP ${nodeBad.status}`);
  const nodeNone = await post(`${NODE_URL}/api/ai/chat`, null, { message: "Plan a visit", conversation_id: conv(), language: "en" });
  note("Node refuses a request with no token", nodeNone.status === 401, `HTTP ${nodeNone.status}`);
  const pyNone = await post(`${PYTHON_URL}/planner/turn`, null, { message: "Plan a visit", conversation_id: conv(), language: "en" });
  note("Python refuses a request with no token", pyNone.status === 401 || pyNone.status === 403, `HTTP ${pyNone.status}`);

  finish(token);
})();

function finish(token) {
  const failed = results.filter((r) => !r.ok);
  const lines = [
    "Phase B cross-service JWT test (real services, no token saved)",
    `Date: ${new Date().toISOString()}`,
    "",
    ...results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`),
    "",
    failed.length ? `RESULT: ${failed.length} check(s) failed` : "RESULT: all checks passed",
  ];
  let text = lines.join("\n");
  if (token) text = text.split(token).join("[token]"); // belt and braces
  fs.writeFileSync(REPORT, text + "\n");
  console.log(`\n${failed.length ? `${failed.length} check(s) FAILED` : "All checks passed"}. Report: ${REPORT}`);
  process.exitCode = failed.length ? 1 : 0;
}
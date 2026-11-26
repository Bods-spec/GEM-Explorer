"use strict";

// =====================================================
// Phase C: REAL end-to-end test
//   Node.js Booking Agent  +  real Python Smart Visit Planner  +  real Supabase
//
//   node e2e-planning-booking.js                  full conversation (creates ONE demo booking, then cancels it)
//   node e2e-planning-booking.js --planner-down   planner-failure test (creates only a cancelled draft)
//
// WARNING: this test WRITES to your real Supabase project:
//   * booking_drafts rows (two conversations, both ended)
//   * ONE real demo booking in `bookings`, which the test then cancels
//     through the normal cancel flow (status becomes "cancelled"; rows are
//     never deleted, because that would need SQL).
// Use a DEDICATED TEST USER. Nothing runs until you type the approval phrase.
//
// Safe by design: the password and tokens are never printed, logged or
// saved; only the user's own token is used (no service-role key);
// the frontend, SQL, Museum Guide and booking confirmation logic are untouched.
// The report (e2e_planning_booking_report.txt) has no token, password or email.
// =====================================================

const fs = require("node:fs");
const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const {
  readPublicSettings, signInSession, askVisible, askHidden,
} = require("./run-planning-smoke");

const APPROVAL_PHRASE = "approved: one real test booking and cancellation";
const REPORT = "e2e_planning_booking_report.txt";
const TIMEOUT_MS = 90000;
const TEST_NAME = "Test Visitor";

// ---- tiny HTTP helper ---------------------------------------------------

function makeApi(nodeUrl, token) {
  const base = nodeUrl.replace(/\/+$/, "");
  async function call(method, route, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(base + route, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let json = null;
      try { json = await res.json(); } catch { /* no body */ }
      return { status: res.status, data: json?.data, json };
    } catch {
      return { status: 0, data: null, json: null };
    } finally {
      clearTimeout(timer);
    }
  }
  const chat = (conversationId, message, extra = {}) =>
    call("POST", "/api/ai/chat", { message, conversation_id: conversationId, language: "en", ...extra });
  const bookings = async () => {
    const r = await call("GET", "/api/bookings");
    return r.status === 200 && Array.isArray(r.data?.bookings) ? r.data.bookings : null;
  };
  return { call, chat, bookings };
}

function cairoTomorrow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  const d = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) + 1));
  return d.toISOString().slice(0, 10);
}

const newConv = (tag) => `e2e-${tag}-${crypto.randomBytes(6).toString("hex")}`;
const mask = (ref) => (typeof ref === "string" && ref.length > 6 ? `${ref.slice(0, 4)}…${ref.slice(-3)}` : "?");

/**
 * Runs the checks. Returns [{ status: "PASS"|"FAIL"|"SKIP"|"INFO", name, detail }].
 * `ownerCheck(reference)` (optional) -> "match" | "mismatch" | "unavailable".
 */
async function runE2E({ nodeUrl, token, mode = "full", ownerCheck = null }) {
  const results = [];
  const note = (status, name, detail = "") => {
    results.push({ status, name, detail });
    console.log(`${status}  ${name}${detail ? `  (${detail})` : ""}`);
    return status === "PASS";
  };
  const check = (ok, name, detail = "") => note(ok ? "PASS" : "FAIL", name, detail);

  const api = makeApi(nodeUrl, token);
  const tomorrow = cairoTomorrow();

  const health = await api.call("GET", "/api/health");
  if (!check(health.status === 200, "Node.js backend is running", `HTTP ${health.status}`)) return results;

  const before = await api.bookings();
  if (!check(before !== null, "Signed-in user can list their own bookings", before ? `${before.length} existing` : "request failed")) return results;

  if (mode === "planner-down") {
    await plannerDownTests({ api, check, note, tomorrow });
    return results;
  }

  // ======================================================================
  // A. Confirmation is blocked while a requested plan is still pending
  // ======================================================================
  const gate = newConv("gate");
  const g1 = await api.chat(gate, `Plan a visit and book 2 tickets for tomorrow. My name is ${TEST_NAME}`);
  if (g1.status !== 200) {
    check(false, "Gate: combined plan + booking message accepted", `HTTP ${g1.status}`);
  } else if (g1.data?.planner_status !== "needs_clarification" && g1.data?.planner_status !== "not_possible") {
    note("SKIP", "Gate: planner asked a question (no time given)",
      `planner answered "${g1.data?.planner_status}" instead; the gate cannot be shown with this answer (unit tests cover it)`);
  } else {
    check(g1.data.plan_pending === true, "Gate: plan is still pending (plan_pending=true)");
    check(g1.data.confirmation_revision === null, "Gate: booking summary is NOT presented while the plan is pending");
    check(g1.data.extracted?.ticket_count === 2 && g1.data.extracted?.visitor_name === TEST_NAME,
      "Gate: booking details were kept (2 visitors, name)");
    const countBefore = (await api.bookings())?.length;
    const g2 = await api.chat(gate, "yes confirm", { confirmation_revision: 1 });
    const countAfter = (await api.bookings())?.length;
    check(g2.status === 200 && g2.data?.action !== "confirm" && g2.data?.plan_pending === true,
      "Gate: 'yes, confirm' while the plan is pending confirms nothing", `HTTP ${g2.status}`);
    check(countBefore === countAfter, "Gate: no booking was created", `${countBefore} -> ${countAfter}`);
  }
  const gEnd = await api.chat(gate, "cancel");
  check(gEnd.status === 200 && (gEnd.data?.action === "reset" || gEnd.data?.action === null), "Gate: test draft closed (cancel)", `HTTP ${gEnd.status}`);

  // ======================================================================
  // B. Full conversation: plan -> modify -> book -> review -> confirm
  // ======================================================================
  const conv = newConv("main");
  let ok = true;

  // 1. 2-hour plan
  const s1 = await api.chat(conv, "I'd like a 2-hour visit plan");
  ok = check(s1.status === 200 && s1.data?.planner_status === "plan_created" && !!s1.data?.plan,
    "1. 2-hour plan requested and received", `HTTP ${s1.status}, planner_status=${s1.data?.planner_status}`);
  check(s1.data?.draft_saved === false && s1.data?.extracted?.ticket_count === null,
    "1. the 2 hours were not read as visitors and no draft was created");
  if (!ok) return skipRest(note, results);

  // 2. modify to 90 minutes
  const s2 = await api.chat(conv, "Make it 90 minutes");
  ok = check(s2.status === 200 && ["plan_updated", "plan_created"].includes(s2.data?.planner_status) && !!s2.data?.plan,
    "2. plan changed to 90 minutes", `HTTP ${s2.status}, planner_status=${s2.data?.planner_status}`);
  check(!/between 1 and 10/i.test(s2.data?.reply || "") && s2.data?.extracted?.ticket_count === null && s2.data?.draft_saved === false,
    "2. '90 minutes' was not read as 90 visitors");
  if (!ok) return skipRest(note, results);

  // 3. booking request for 2 visitors
  const s3 = await api.chat(conv, "Book 2 tickets for tomorrow");
  ok = check(s3.status === 200 && s3.data?.extracted?.ticket_count === 2 && s3.data?.extracted?.visit_date === tomorrow && s3.data?.draft_saved === true,
    "3. booking started: 2 visitors, tomorrow", `HTTP ${s3.status}`);
  check(s3.data?.planner_status === undefined, "3. a booking-only message did not call the planner");
  check(s3.data?.confirmation_revision === null && /name/i.test(s3.data?.reply || ""),
    "3. the missing detail (name) is requested, no summary yet");
  if (!ok) return skipRest(note, results);

  // 4. complete the missing detail -> review
  const s4 = await api.chat(conv, `My name is ${TEST_NAME}`);
  const revision = s4.data?.confirmation_revision;
  ok = check(s4.status === 200 && Number.isSafeInteger(revision), "4. booking summary presented", `HTTP ${s4.status}`);
  check(/demo booking, not an official museum ticket/i.test(s4.data?.reply || ""), "5. the summary carries the demo notice");
  check(s4.data?.plan_pending === undefined, "5. no plan is pending");
  if (!ok) return skipRest(note, results);

  const mid = await api.bookings();
  check(mid?.length === before.length, "5. nothing is booked before the explicit confirmation", `${before.length} -> ${mid?.length}`);

  // 6. explicit confirmation
  const s6 = await api.chat(conv, "yes confirm", { confirmation_revision: revision });
  const booking = s6.data?.booking;
  ok = check(s6.status === 200 && s6.data?.action === "confirm" && /^GEM-/.test(booking?.booking_reference || ""),
    "6. explicit confirmation created a booking", `HTTP ${s6.status}`);
  check(s6.data?.demo === true && booking?.demo === true, "6. the confirmed response is marked demo: true");
  check(booking?.ticket_count === 2 && booking?.visit_date === tomorrow && booking?.visitor_name === TEST_NAME,
    "6. the booking has the confirmed details");
  if (!ok) return skipRest(note, results);

  // 7. exactly one booking
  const ref = booking.booking_reference;
  const after = await api.bookings();
  const mine = (after || []).filter((b) => b.booking_reference === ref);
  check(after?.length === before.length + 1 && mine.length === 1, "7. exactly one new demo booking exists", `${before.length} -> ${after?.length}`);

  const again = await api.chat(conv, "yes confirm", { confirmation_revision: revision });
  const afterRepeat = await api.bookings();
  check(again.status === 200 && again.data?.booking?.booking_reference === ref && afterRepeat?.length === before.length + 1,
    "7. repeating the confirmation returns the same booking and creates no second one");

  // 8. ownership
  check(mine.length === 1, "8. the booking is in the signed-in user's own list (the server filters by the verified user id)");
  if (ownerCheck) {
    const owner = await ownerCheck(ref);
    if (owner === "match") note("PASS", "8. the booking row's user_id equals the signed-in user id (read with the user's own token)");
    else if (owner === "mismatch") note("FAIL", "8. the booking row's user_id does NOT match the signed-in user");
    else note("INFO", "8. direct row check not possible with the user's token (row-level security); ownership shown by the user's own list");
  }

  // 9. clean up through the normal cancel flow
  const c2 = newConv("cancel");
  const k1 = await api.chat(c2, `cancel booking ${ref}`);
  check(k1.status === 200 && (k1.data?.reply || "").includes(ref) && k1.data?.planner_status === undefined,
    "9. cancel flow found the test booking (planner not involved)");
  const k2 = await api.chat(c2, "yes");
  check(k2.status === 200 && k2.data?.action === "cancel_booking", "9. the test booking was cancelled after an explicit yes");
  const fin = await api.bookings();
  const row = (fin || []).find((b) => b.booking_reference === ref);
  check(row?.status === "cancelled", "9. the booking now shows status 'cancelled'", `status=${row?.status}`);
  return results;
}

function skipRest(note, results) {
  note("SKIP", "remaining steps", "a previous step failed");
  return results;
}

// ---- planner failure (Node started with a dead PLANNER_URL) ------------------------

async function plannerDownTests({ api, check, note, tomorrow }) {
  const conv = newConv("down");
  const d1 = await api.chat(conv, `Plan a 2-hour visit and book 2 tickets for tomorrow. My name is ${TEST_NAME}`);
  if (d1.data?.planner_status !== "unavailable") {
    check(false, "Planner-down: Node reports the planner as unavailable",
      `planner_status=${d1.data?.planner_status}. Start Node with a dead PLANNER_URL (see the instructions)`);
    return;
  }
  check(true, "Planner-down: the visitor is told planning is unavailable and asked how to continue");
  check(/booking only/i.test(d1.data?.reply || ""), "Planner-down: the reply offers 'continue with the booking only'");
  check(d1.data?.extracted?.ticket_count === 2 && d1.data?.extracted?.visitor_name === TEST_NAME,
    "Planner-down: booking details were kept");
  check(d1.data?.confirmation_revision === null, "Planner-down: no booking summary is presented yet");

  const before = (await api.bookings())?.length;
  const d2 = await api.chat(conv, "yes");
  const after = (await api.bookings())?.length;
  check(d2.status === 200 && d2.data?.action !== "confirm" && before === after,
    "Planner-down: 'yes' continues with the booking only and confirms nothing", `${before} -> ${after}`);
  check(Number.isSafeInteger(d2.data?.confirmation_revision) && /demo booking/i.test(d2.data?.reply || ""),
    "Planner-down: the booking summary (with demo notice) is now presented");

  const plain = newConv("plain");
  const p1 = await api.chat(plain, "book 2 tickets for tomorrow");
  check(p1.status === 200 && p1.data?.extracted?.ticket_count === 2 && p1.data?.planner_status === undefined,
    "Planner-down: a normal booking conversation is unaffected");

  for (const c of [conv, plain]) await api.chat(c, "cancel");
  note("INFO", "Planner-down: test drafts closed; no booking was confirmed");
}

// ---- command line --------------------------------------------------------------------

function writeReport(results, token) {
  const fails = results.filter((r) => r.status === "FAIL").length;
  let text = [
    "Phase C real end-to-end test (no token, password or email saved)",
    `Date: ${new Date().toISOString()}`,
    "",
    ...results.map((r) => `${r.status}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`),
    "",
    fails ? `RESULT: ${fails} check(s) FAILED` : "RESULT: no check failed",
  ].join("\n");
  if (token) text = text.split(token).join("[token]");
  fs.writeFileSync(REPORT, `${text}\n`);
  return fails;
}

async function main() {
  const mode = process.argv.includes("--planner-down") ? "planner-down" : "full";
  const nodeUrl = (process.env.NODE_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
  const { url, publishableKey } = readPublicSettings();
  if (!url || !publishableKey) { console.log("FAIL  SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not found in backend\\.env"); process.exitCode = 1; return; }
  if (!process.stdin.isTTY) { console.log("FAIL  This test needs an interactive terminal (it asks for the approval phrase)."); process.exitCode = 1; return; }

  const email = await askVisible("Dedicated TEST user email: ");
  let password = await askHidden("Password (hidden): ");
  if (!email || !password) { console.log("FAIL  Email and password are both required"); process.exitCode = 1; return; }
  const session = await signInSession({ url, publishableKey, email, password }).catch(() => null);
  password = null;
  if (!session) { console.log("FAIL  Sign in with Supabase Auth (credentials not accepted, or Supabase unreachable)"); process.exitCode = 1; return; }
  console.log("PASS  Sign in with Supabase Auth (token held in memory only)\n");

  console.log("=== WARNING: this test WRITES to your REAL Supabase project ===");
  if (mode === "full") {
    console.log("  - creates booking_drafts rows for 2 conversations");
    console.log("  - creates ONE real demo booking, then cancels it (status 'cancelled'; rows are never deleted)");
  } else {
    console.log("  - creates booking_drafts rows (then closes them). No booking is confirmed.");
  }
  console.log(`  - for the user you just signed in as (${email})`);
  console.log("  - use a DEDICATED TEST USER, not your personal account\n");
  const typed = await askVisible(`To continue, type exactly:\n${APPROVAL_PHRASE}\n> `);
  if (typed !== APPROVAL_PHRASE) { console.log("\nNot approved. Nothing was written. Stopped."); return; }

  const ownerCheck = async (reference) => {
    try {
      const client = createClient(url, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: `Bearer ${session.token}` } },
      });
      const { data, error } = await client.from("bookings").select("user_id").eq("booking_reference", reference).limit(2);
      if (error || !Array.isArray(data) || data.length !== 1 || !data[0].user_id || !session.userId) return "unavailable";
      return data[0].user_id === session.userId ? "match" : "mismatch";
    } catch { return "unavailable"; }
  };

  console.log("");
  const results = await runE2E({ nodeUrl, token: session.token, mode, ownerCheck });
  const fails = writeReport(results, session.token);
  console.log(`\n${fails ? `${fails} check(s) FAILED` : "No check failed"}. Report: ${REPORT}`);
  process.exitCode = fails ? 1 : 0;
}

if (require.main === module) main();

module.exports = { runE2E, APPROVAL_PHRASE };
"use strict";

// =====================================================
// REAL Guest Mode end-to-end test
//   real Supabase Anonymous Auth  ->  real Node.js Booking Agent
//   -> real Python Smart Visit Planner  ->  real Supabase database
//
//   node e2e-guest-real.js
//
// It uses the EXISTING guest implementation: frontend/js/guest-config.js and
// frontend/js/guest-auth.js are loaded exactly as the page loads them (in a
// small sandbox that pretends to be a page on http://localhost:5600), so this
// proves the real guest-auth.js signs in. Two fresh anonymous guests are used.
//
// NOTHING RUNS AUTOMATICALLY. It asks for two approval phrases:
//   1. before creating the two anonymous sessions (Supabase Auth records)
//   2. before creating booking records (drafts, ONE demo booking, a modification
//      request and a cancellation request) for guest 1
// If you do not type a phrase exactly, it stops and writes nothing.
//
// Safe by design: no application code is changed; no service-role key and no
// password are used (guests have none); tokens are held in memory only and are
// never printed, logged or saved; the report has no token. Guest Mode stays
// limited to local development (guest-auth.js refuses non-localhost pages and
// the backend accepts guests only with ALLOW_GUEST_USERS=true on localhost).
// =====================================================

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { readPublicSettings, askVisible } = require("./run-planning-smoke");

const APPROVAL_SESSIONS = "approved: create two anonymous test sessions";
const APPROVAL_RECORDS = "approved: one real guest booking, modification and cancellation";
const REPORT = "e2e_guest_real_report.txt";
const TIMEOUT_MS = 90000;
const TEST_NAME = "Guest Tester";

// ---- helpers --------------------------------------------------------------

const short = (id) => (typeof id === "string" && id.length >= 8 ? `${id.slice(0, 8)}…` : "?");
const norm = (u) => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
const newConv = (tag) => `e2eg-${tag}-${crypto.randomBytes(6).toString("hex")}`;

function cairoTomorrow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) + 1)).toISOString().slice(0, 10);
}

async function http(method, url, { token, apikey, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    if (apikey) headers.apikey = apikey;
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json, data: json?.data };
  } catch {
    return { status: 0, json: null, data: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Claims of a JWT, decoded locally (no signature check: the servers do that). Never returned to the caller as a token. */
function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); }
  catch { return null; }
}

/**
 * Loads the REAL guest-config.js + guest-auth.js into a sandbox that looks like
 * a page on http://localhost:5600, and asks it for a session, exactly like
 * visit.js does (window.GEMAuth.getSession()). Each call uses fresh storage =
 * a brand-new anonymous guest.
 */
async function guestSession(frontendDir) {
  const logs = [];
  const store = new Map();
  const sandbox = {
    console: { info: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), log() {} },
    fetch: (...a) => fetch(...a), atob: (s) => Buffer.from(s, "base64").toString("binary"),
    setTimeout, clearTimeout,
    crypto: crypto.webcrypto,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
  };
  sandbox.window = sandbox;
  sandbox.location = { hostname: "localhost" };
  vm.createContext(sandbox);
  const read = (f) => fs.readFileSync(path.join(frontendDir, "js", f), "utf8");
  vm.runInContext(read("guest-config.js"), sandbox, { filename: "guest-config.js" });
  vm.runInContext(read("guest-auth.js"), sandbox, { filename: "guest-auth.js" });
  const cfg = sandbox.GEM_GUEST;
  const session = sandbox.GEMAuth && typeof sandbox.GEMAuth.getSession === "function" ? await sandbox.GEMAuth.getSession() : null;
  return { cfg, session, logs, stored: () => store.has("gem-guest-session-v1") };
}

function makeApi(nodeUrl, token) {
  const base = nodeUrl.replace(/\/+$/, "");
  const call = (method, route, body) => http(method, base + route, { token, body });
  const chat = (conversationId, message, extra = {}) =>
    call("POST", "/api/ai/chat", { message, conversation_id: conversationId, language: "en", ...extra });
  const bookings = async () => {
    const r = await call("GET", "/api/bookings");
    return r.status === 200 && Array.isArray(r.data?.bookings) ? r.data.bookings : null;
  };
  return { call, chat, bookings };
}

/** Read-only probe of the database's own row-level security, with the guest's own JWT + the PUBLISHABLE key. */
async function rlsProbe(supabaseUrl, publishableKey, token, table, filter = "") {
  const r = await http("GET", `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/${table}?select=id${filter}&limit=5`, { token, apikey: publishableKey });
  if (r.status === 200 && Array.isArray(r.json)) return { kind: "rows", count: r.json.length, status: 200 };
  if (r.status === 401 || r.status === 403 || r.status === 404) return { kind: "denied", status: r.status };
  return { kind: "other", status: r.status };
}

// ---- the test --------------------------------------------------------------

/**
 * @param {{nodeUrl:string, plannerUrl:string, frontendDir:string, backendSupabaseUrl?:string,
 *          approve:(stage:"sessions"|"records")=>Promise<boolean>}} options
 * Returns [{ status: "PASS"|"FAIL"|"SKIP"|"INFO", name, detail }].
 */
async function runGuestE2E({ nodeUrl, plannerUrl, frontendDir, backendSupabaseUrl, approve }) {
  const results = [];
  const note = (status, name, detail = "") => {
    results.push({ status, name, detail });
    console.log(`${status}  ${name}${detail ? `  (${detail})` : ""}`);
    return status === "PASS";
  };
  const check = (ok, name, detail = "") => note(ok ? "PASS" : "FAIL", name, detail);
  const stop = (why) => { note("SKIP", "remaining steps", why); return results; };
  const tomorrow = cairoTomorrow();
  const planner = plannerUrl.replace(/\/+$/, "");

  // ================= PREFLIGHT (read-only, creates nothing) =================
  console.log("--- Preflight (read-only) ---");
  const nodeHealth = await http("GET", `${nodeUrl.replace(/\/+$/, "")}/api/health`);
  if (!check(nodeHealth.status === 200, "Node.js backend is running", `HTTP ${nodeHealth.status}`)) return results;
  const pyHealth = await http("GET", `${planner}/health`);
  if (!check(pyHealth.status === 200, "Python service is running", `HTTP ${pyHealth.status}`)) return results;

  let cfg;
  try {
    const sb = {};
    vm.createContext(sb); sb.window = sb;
    vm.runInContext(fs.readFileSync(path.join(frontendDir, "js", "guest-config.js"), "utf8"), sb);
    cfg = sb.GEM_GUEST;
  } catch { cfg = null; }
  if (!check(!!cfg && cfg.enabled === true && cfg.mode === "supabase" && !!cfg.supabaseUrl && !!cfg.supabasePublishableKey,
    "frontend/js/guest-config.js: guest mode enabled, mode 'supabase', URL and publishable key set")) return results;
  const publishableKey = String(cfg.supabasePublishableKey);
  const supabaseUrl = String(cfg.supabaseUrl);
  check(!/^sb_secret_/.test(publishableKey) && jwtClaims(publishableKey)?.role !== "service_role",
    "guest-config.js holds only a PUBLISHABLE key (no secret / service-role key in the browser)");
  if (backendSupabaseUrl) {
    check(norm(backendSupabaseUrl) === norm(supabaseUrl),
      "browser guest config and backend/.env point at the SAME Supabase project",
      norm(backendSupabaseUrl) === norm(supabaseUrl) ? "" : "different SUPABASE_URL: the backend could not verify guest tokens");
  }

  const noTok = await http("GET", `${nodeUrl.replace(/\/+$/, "")}/api/bookings`);
  const badTok = await http("GET", `${nodeUrl.replace(/\/+$/, "")}/api/bookings`, { token: "not-a-real-token" });
  check(noTok.status === 401 && badTok.status === 401, "JWT check (Node): no token and a fake token are refused (401)", `${noTok.status}/${badTok.status}`);
  const pyBad = await http("POST", `${planner}/planner/turn`, { token: "not-a-real-token", body: { message: "Plan a visit", conversation_id: newConv("pybad"), language: "en" } });
  check(pyBad.status === 401, "JWT check (Python): a fake token is refused (401)", `HTTP ${pyBad.status}`);

  // ================= APPROVAL 1: anonymous sessions =================
  if (!(await approve("sessions"))) return stop("not approved: nothing was created");

  // ================= STAGE 1: two fresh anonymous guests =================
  console.log("\n--- Stage 1: anonymous authentication (creates 2 Supabase Auth guest users) ---");
  const g1 = await guestSession(frontendDir);
  const g2 = await guestSession(frontendDir);
  const okAuth = !!g1.session?.accessToken && !!g2.session?.accessToken;
  if (!check(okAuth, "Anonymous authentication succeeded via the real guest-auth.js (two fresh guests)",
    okAuth ? "" : (g1.logs.concat(g2.logs).filter((l) => /\[GEM guest mode\]/.test(l)).slice(-1)[0] || "no session"))) {
    return results;
  }
  const c1 = jwtClaims(g1.session.accessToken);
  if (c1) check(c1.is_anonymous === true && c1.role === "authenticated", "the guest JWT is a Supabase 'authenticated' token flagged is_anonymous");
  else note("INFO", "the guest access token is not a readable JWT (claims not inspected); the servers verify it anyway");
  check(g1.session.user.id !== g2.session.user.id && g1.stored(), `the two guests are different users (${short(g1.session.user.id)} and ${short(g2.session.user.id)})`);

  const A = makeApi(nodeUrl, g1.session.accessToken);
  const B = makeApi(nodeUrl, g2.session.accessToken);
  const a0 = await A.bookings();
  const b0 = await B.bookings();
  if (!check(a0 !== null && b0 !== null, "Node.js backend accepts the guest JWT (GET /api/bookings = 200)",
    "if 401: set ALLOW_GUEST_USERS=true in backend\\.env, FRONTEND_ORIGIN=http://localhost:5600, restart Node")) return results;
  check(a0.length === 0 && b0.length === 0, "a fresh guest starts with no bookings", `${a0.length}/${b0.length}`);

  const py = await http("POST", `${planner}/planner/turn`, {
    token: g1.session.accessToken, body: { message: "Plan a 2-hour visit", conversation_id: newConv("py"), language: "en" },
  });
  check(py.status === 200 && typeof py.json?.status === "string",
    "Python Smart Visit Planner accepts the guest JWT (POST /planner/turn = 200)",
    py.status === 403 ? "403 GUESTS_NOT_ALLOWED: set ALLOW_GUEST_USERS=true in ai_service\\.env and restart Python" : `HTTP ${py.status}`);

  // database-level row-level security, with the guest's own JWT (read-only)
  for (const table of ["bookings", "booking_drafts"]) {
    const p = await rlsProbe(supabaseUrl, publishableKey, g1.session.accessToken, table);
    if (p.kind === "rows") check(p.count === 0, `RLS (${table}): a fresh guest reading the table directly sees no rows`, p.count ? `${p.count} ROW(S) VISIBLE: another user's data may be exposed` : "0 rows");
    else if (p.kind === "denied") note("PASS", `RLS (${table}): direct table access with a guest token is denied`, `HTTP ${p.status}`);
    else note("INFO", `RLS (${table}): direct probe inconclusive`, `HTTP ${p.status}`);
  }

  // ================= APPROVAL 2: booking records =================
  if (!(await approve("records"))) return stop("not approved: no booking records were created");

  // ================= STAGE 2: plan -> book -> list -> isolation -> modify -> cancel =================
  console.log("\n--- Stage 2: real booking records for guest 1 ---");
  const conv = newConv("main");
  let ok;

  const s1 = await A.chat(conv, "I'd like a 2-hour visit plan");
  ok = check(s1.status === 200 && s1.data?.planner_status === "plan_created" && !!s1.data?.plan,
    "1. guest asks for a 2-hour plan: Node -> Python (guest JWT) -> plan received", `HTTP ${s1.status}, planner_status=${s1.data?.planner_status}`);
  if (!ok) return stop("planning failed: is PLANNER_ENABLED=true / PLANNER_URL set in backend\\.env?");

  const s2 = await A.chat(conv, "Make it 90 minutes");
  ok = check(s2.status === 200 && ["plan_updated", "plan_created"].includes(s2.data?.planner_status) && !!s2.data?.plan && s2.data?.extracted?.ticket_count === null,
    "2. guest changes the plan to 90 minutes (not read as 90 visitors)", `HTTP ${s2.status}, planner_status=${s2.data?.planner_status}`);
  if (!ok) return stop("plan change failed");

  const s3 = await A.chat(conv, "Book 2 tickets for tomorrow");
  ok = check(s3.status === 200 && s3.data?.extracted?.ticket_count === 2 && s3.data?.extracted?.visit_date === tomorrow && s3.data?.draft_saved === true,
    "3. booking started: 2 visitors, tomorrow", `HTTP ${s3.status}`);
  if (!ok) return stop("booking start failed");

  const s4 = await A.chat(conv, `My name is ${TEST_NAME}`);
  const revision = s4.data?.confirmation_revision;
  ok = check(s4.status === 200 && Number.isSafeInteger(revision) && /demo booking, not an official museum ticket/i.test(s4.data?.reply || ""),
    "4. booking summary presented with the demo notice", `HTTP ${s4.status}`);
  if (!ok) return stop("no summary");
  check((await A.bookings())?.length === 0, "4. nothing is booked before the explicit confirmation");

  const s5 = await A.chat(conv, "yes confirm", { confirmation_revision: revision });
  const booking = s5.data?.booking;
  ok = check(s5.status === 200 && s5.data?.action === "confirm" && /^GEM-/.test(booking?.booking_reference || "") && s5.data?.demo === true && booking?.demo === true,
    "5. explicit confirmation saved ONE real demo booking in Supabase (demo: true)", `HTTP ${s5.status}`);
  if (!ok) return stop("confirmation failed");
  const ref = booking.booking_reference;

  const list1 = await A.bookings();
  const mine = (list1 || []).filter((b) => b.booking_reference === ref);
  check(list1?.length === 1 && mine.length === 1 && mine[0].ticket_count === 2 && mine[0].visit_date === tomorrow,
    "6. My Recent Bookings (GET /api/bookings) shows the guest's real booking", `${list1?.length} booking(s)`);
  const again = await A.chat(conv, "yes confirm", { confirmation_revision: revision });
  check(again.status === 200 && again.data?.booking?.booking_reference === ref && (await A.bookings())?.length === 1,
    "6. repeating the confirmation creates no second booking");

  // ---- isolation: guest 2 vs guest 1's booking ----
  console.log("\n--- Isolation: guest 2 tries to reach guest 1's booking ---");
  const bList = await B.bookings();
  check(bList !== null && bList.length === 0 && !bList.some((b) => b.booking_reference === ref),
    "7. guest 2's My Recent Bookings does not contain guest 1's booking", `${bList?.length} booking(s)`);

  const hijack = await B.chat(conv, "yes confirm", { confirmation_revision: revision });
  check(hijack.status === 200 && hijack.data?.booking?.booking_reference !== ref && (await B.bookings())?.length === 0 && (await A.bookings())?.length === 1,
    "7. guest 2 cannot continue/confirm inside guest 1's conversation", `HTTP ${hijack.status}`);

  const bCancelConv = newConv("b-cancel");
  const bc1 = await B.chat(bCancelConv, `cancel booking ${ref}`);
  const bc2 = await B.chat(bCancelConv, "yes");
  const bModConv = newConv("b-mod");
  const bm1 = await B.chat(bModConv, `Change booking ${ref} to 4 visitors.`);
  const bm2 = await B.chat(bModConv, "Yes, confirm.");
  const afterAttack = (await A.bookings() || []).find((b) => b.booking_reference === ref);
  check(bc2.data?.action !== "cancel_booking" && bm2.data?.action !== "modify_booking" && afterAttack?.status === "confirmed" && afterAttack?.ticket_count === 2,
    "7. guest 2 cannot cancel or modify guest 1's booking by its reference (still confirmed, 2 visitors)", `status=${afterAttack?.status}, visitors=${afterAttack?.ticket_count}`);
  check(!new RegExp(`${tomorrow}|${TEST_NAME}`, "i").test(`${bc1.data?.reply || ""} ${bm1.data?.reply || ""}`),
    "7. guest 2 learns nothing about the booking (no date or name in the replies)");

  const rlsB = await rlsProbe(supabaseUrl, publishableKey, g2.session.accessToken, "bookings", `&booking_reference=eq.${encodeURIComponent(ref)}`);
  if (rlsB.kind === "rows") check(rlsB.count === 0, "7. RLS: guest 2 reading `bookings` directly cannot see guest 1's row", `${rlsB.count} row(s)`);
  else if (rlsB.kind === "denied") note("PASS", "7. RLS: guest 2's direct read of `bookings` is denied", `HTTP ${rlsB.status}`);
  else note("INFO", "7. RLS: direct probe inconclusive", `HTTP ${rlsB.status}`);
  const rlsA = await rlsProbe(supabaseUrl, publishableKey, g1.session.accessToken, "bookings", `&booking_reference=eq.${encodeURIComponent(ref)}`);
  note("INFO", "7. RLS: guest 1's own direct read of its row", rlsA.kind === "rows" ? `${rlsA.count} row(s)` : `${rlsA.kind} HTTP ${rlsA.status}`);

  // ---- modify (with a hijack attempt in the middle) ----
  console.log("\n--- Modify and cancel (guest 1's own booking) ---");
  const mConv = newConv("modify");
  const m1 = await A.chat(mConv, `Change booking ${ref} to 3 visitors.`);
  check(m1.status === 200 && /I found your booking/i.test(m1.data?.reply || "") && (await A.bookings())?.find((b) => b.booking_reference === ref)?.ticket_count === 2,
    "8. modify: Egyxos asks first, nothing changes yet", `HTTP ${m1.status}`);
  const mSteal = await B.chat(mConv, "Yes, confirm.");
  check(mSteal.data?.action !== "modify_booking" && (await A.bookings())?.find((b) => b.booking_reference === ref)?.ticket_count === 2,
    "8. guest 2 cannot confirm guest 1's pending modification");
  const m2 = await A.chat(mConv, "Yes, confirm.");
  check(m2.status === 200 && m2.data?.action === "modify_booking" && m2.data?.booking?.booking_reference === ref && m2.data?.booking?.ticket_count === 3,
    "8. guest 1 confirms: the booking is modified (3 visitors, same reference)", `HTTP ${m2.status}`);
  const listM = (await A.bookings() || []).find((b) => b.booking_reference === ref);
  check(listM?.ticket_count === 3 && listM?.status === "confirmed", "8. My Recent Bookings shows 3 visitors, still confirmed");

  // ---- cancel (with a hijack attempt in the middle) ----
  const cConv = newConv("cancel");
  const k1 = await A.chat(cConv, `cancel booking ${ref}`);
  check(k1.status === 200 && (k1.data?.reply || "").includes(ref) && k1.data?.planner_status === undefined,
    "9. cancel: Egyxos finds guest 1's booking and asks first (planner not involved)", `HTTP ${k1.status}`);
  const kSteal = await B.chat(cConv, "yes");
  check(kSteal.data?.action !== "cancel_booking" && (await A.bookings() || []).find((b) => b.booking_reference === ref)?.status === "confirmed",
    "9. guest 2 cannot confirm guest 1's pending cancellation");
  const k2 = await A.chat(cConv, "yes");
  check(k2.status === 200 && k2.data?.action === "cancel_booking", "9. guest 1 confirms: the booking is cancelled", `HTTP ${k2.status}`);
  const fin = (await A.bookings() || []).find((b) => b.booking_reference === ref);
  check(fin?.status === "cancelled", "9. My Recent Bookings shows the booking as Cancelled", `status=${fin?.status}`);
  check((await B.bookings())?.length === 0, "9. guest 2 still has no bookings and was never able to see any");

  // ---- tidy: close any leftover drafts ----
  for (const [api, c] of [[B, bCancelConv], [B, bModConv], [A, mConv], [A, cConv]]) await api.chat(c, "cancel");
  note("INFO", "cleanup: leftover test drafts closed; the one demo booking is cancelled (rows are never deleted)");
  return results;
}

// ---- command line -------------------------------------------------------------------

function writeReport(results) {
  const fails = results.filter((r) => r.status === "FAIL").length;
  const text = [
    "Real Guest Mode end-to-end test (no token, password or key saved)",
    `Date: ${new Date().toISOString()}`,
    "",
    ...results.map((r) => `${r.status}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`),
    "",
    fails ? `RESULT: ${fails} check(s) FAILED` : "RESULT: no check failed",
  ].join("\n");
  fs.writeFileSync(REPORT, `${text}\n`);
  return fails;
}

async function main() {
  const nodeUrl = (process.env.NODE_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
  const plannerUrl = (process.env.PLANNER_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
  const frontendDir = process.env.E2E_FRONTEND_DIR || path.resolve(__dirname, "..", "frontend");
  const { url: backendSupabaseUrl } = readPublicSettings();

  if (!process.stdin.isTTY) { console.log("FAIL  This test needs an interactive terminal (it asks for approval phrases). Nothing was done."); process.exitCode = 1; return; }
  if (!fs.existsSync(path.join(frontendDir, "js", "guest-auth.js"))) { console.log(`FAIL  guest-auth.js not found under ${frontendDir}\\js`); process.exitCode = 1; return; }

  const approve = async (stage) => {
    if (stage === "sessions") {
      console.log("\n=== APPROVAL 1 of 2: anonymous sessions ===");
      console.log("  The next step creates TWO anonymous guest users in your REAL Supabase project");
      console.log("  (Authentication > Users, shown as anonymous). They have no email and no password.");
      console.log("  No database rows are created in this step.\n");
      const typed = await askVisible(`To continue, type exactly:\n${APPROVAL_SESSIONS}\n> `);
      if (typed !== APPROVAL_SESSIONS) { console.log("\nNot approved. Nothing was created. Stopped."); return false; }
      return true;
    }
    console.log("\n=== APPROVAL 2 of 2: booking records ===");
    console.log("  The next steps WRITE to your REAL Supabase database, for guest 1 only:");
    console.log("  - booking_drafts rows for a few conversations (closed at the end)");
    console.log("  - ONE real demo booking in `bookings`, which the test modifies (2 -> 3 visitors) and then cancels");
    console.log("  - one modification request and one cancellation request");
    console.log("  Rows are never deleted (the booking ends with status 'cancelled').");
    console.log("  The two anonymous Auth users also remain until you delete them in the Supabase dashboard.\n");
    const typed = await askVisible(`To continue, type exactly:\n${APPROVAL_RECORDS}\n> `);
    if (typed !== APPROVAL_RECORDS) { console.log("\nNot approved. No booking records were created. Stopped."); return false; }
    return true;
  };

  const results = await runGuestE2E({ nodeUrl, plannerUrl, frontendDir, backendSupabaseUrl, approve });
  const fails = writeReport(results);
  console.log(`\n${fails ? `${fails} check(s) FAILED` : "No check failed"}. Report: ${REPORT}`);
  process.exitCode = fails ? 1 : 0;
}

if (require.main === module) main();

module.exports = { runGuestE2E, APPROVAL_SESSIONS, APPROVAL_RECORDS };
"use strict";

// Unit tests for the bounded, user-scoped in-memory flow store and the
// visitor-phrase helpers (no server, no network).

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFlowStore, createPlanningFlow, isDropPlan, isAffirmative } = require("../backend/planning-flow");
const { readPlannerConfig, createPlannerClient } = require("../backend/planner-client");

const S = (extra = {}) => ({ planRequested: true, planPresented: false, awaiting: "planner", lastPlannerReply: "q", ...extra });

test("flow state is scoped to the user and the conversation", () => {
  const store = createFlowStore();
  store.set("user-a", "conv-0001", S());
  assert.equal(store.get("user-a", "conv-0001").planRequested, true);
  assert.equal(store.get("user-b", "conv-0001"), null, "another user cannot read it");
  assert.equal(store.get("user-a", "conv-0002"), null);
});

test("a read returns a copy, so callers cannot change the stored state", () => {
  const store = createFlowStore();
  store.set("u", "conv-0001", S());
  store.get("u", "conv-0001").planPresented = true;
  assert.equal(store.get("u", "conv-0001").planPresented, false);
});

test("entries expire after the TTL and the TTL slides with use", () => {
  let t = 1000;
  const store = createFlowStore({ now: () => t, ttlMs: 100, sweepEveryMs: 1 });
  store.set("u", "conv-0001", S());
  t += 80;
  assert.ok(store.get("u", "conv-0001"));
  store.set("u", "conv-0001", S());
  t += 80;
  assert.ok(store.get("u", "conv-0001"), "re-set keeps it alive");
  t += 101;
  assert.equal(store.get("u", "conv-0001"), null);
  assert.equal(store.size(), 0, "expired entries are removed");
});

test("one user cannot fill the store: per-user cap drops that user's oldest flows", () => {
  const store = createFlowStore({ maxPerUser: 3, maxFlows: 100 });
  for (let i = 0; i < 6; i += 1) store.set("greedy", `conv-000${i}`, S());
  store.set("other", "conv-9999", S());
  assert.equal(store.size(), 4);
  assert.equal(store.get("greedy", "conv-0000"), null);
  assert.ok(store.get("greedy", "conv-0005"));
  assert.ok(store.get("other", "conv-9999"), "other users are untouched");
});

test("the global cap is enforced", () => {
  const store = createFlowStore({ maxFlows: 5, maxPerUser: 100 });
  for (let i = 0; i < 20; i += 1) store.set(`u${i}`, "conv-0001", S());
  assert.equal(store.size(), 5);
  assert.ok(store.get("u19", "conv-0001"));
  assert.equal(store.get("u0", "conv-0001"), null);
});

test("the stored state holds fixed planner text only: no token, no visitor message", () => {
  const store = createFlowStore();
  store.set("u", "conv-0001", S());
  assert.deepEqual(Object.keys(store.get("u", "conv-0001")).sort(), ["awaiting", "lastPlannerReply", "planPresented", "planRequested"]);
});

test("drop-plan phrases", () => {
  for (const m of ["booking only", "Booking only please", "without a plan", "no plan", "skip the plan", "just the booking", "continue with the booking",
    "بدون خطة", "من غير خطة", "حجز بس", "كمل الحجز"]) assert.equal(isDropPlan(m), true, m);
  for (const m of ["plan my visit", "yes", "I need a plan", "خطة لمدة ساعتين"]) assert.equal(isDropPlan(m), false, m);
});

test("short affirmative answers", () => {
  for (const m of ["yes", "Yes please", "ok", "sure, continue", "ايوه", "تمام", "كمل", "yes booking only"]) assert.equal(isAffirmative(m), true, m);
  for (const m of ["no", "not now", "plan it again", "yes I want the mummies and the gold and the rest", "لا", ""]) assert.equal(isAffirmative(m), false, m);
});

test("feature flag: disabled unless PLANNER_ENABLED=true AND a valid http(s) PLANNER_URL", () => {
  assert.equal(readPlannerConfig({}).enabled, false);
  assert.equal(readPlannerConfig({ PLANNER_URL: "http://127.0.0.1:8000" }).enabled, false);
  assert.equal(readPlannerConfig({ PLANNER_ENABLED: "true" }).enabled, false);
  assert.equal(readPlannerConfig({ PLANNER_ENABLED: "true", PLANNER_URL: "ftp://x" }).enabled, false);
  assert.equal(readPlannerConfig({ PLANNER_ENABLED: "true", PLANNER_URL: "not a url" }).enabled, false);
  assert.equal(readPlannerConfig({ PLANNER_ENABLED: "yes", PLANNER_URL: "http://127.0.0.1:8000" }).enabled, false);
  const ok = readPlannerConfig({ PLANNER_ENABLED: "TRUE", PLANNER_URL: "http://127.0.0.1:8000/" });
  assert.equal(ok.enabled, true);
  assert.equal(ok.url, "http://127.0.0.1:8000");
});

test("timeout setting is bounded", () => {
  const base = { PLANNER_ENABLED: "true", PLANNER_URL: "http://127.0.0.1:8000" };
  assert.equal(readPlannerConfig(base).timeoutMs, 15000);
  assert.equal(readPlannerConfig({ ...base, PLANNER_TIMEOUT_MS: "999999" }).timeoutMs, 60000);
  assert.equal(readPlannerConfig({ ...base, PLANNER_TIMEOUT_MS: "5" }).timeoutMs, 15000);
  assert.equal(readPlannerConfig({ ...base, PLANNER_TIMEOUT_MS: "2500" }).timeoutMs, 2500);
});

test("a disabled flow changes nothing and never calls the client", async () => {
  let called = false;
  const client = createPlannerClient(readPlannerConfig({}), { fetchImpl: () => { called = true; } });
  const flow = createPlanningFlow({ client });
  const d = await flow.decide({ userId: "u", conversationId: "conv-0001", token: "t", message: "Plan a 2 hour visit", uiLanguage: "en", draft: null });
  assert.equal(called, false);
  assert.deepEqual(
    { mode: d.mode, message: d.message, prefix: d.prefix, hold: d.hold, plan: d.plan },
    { mode: "engine", message: "Plan a 2 hour visit", prefix: "", hold: false, plan: null },
  );
});

test("the client never logs the token or the visitor's message", async () => {
  const logs = [];
  const logger = { error: (...a) => logs.push(a.join(" ")) };
  const config = readPlannerConfig({ PLANNER_ENABLED: "true", PLANNER_URL: "http://127.0.0.1:9" });
  for (const fetchImpl of [
    () => { throw new Error("connect ECONNREFUSED with SECRET-TOKEN and secret message"); },
    async () => ({ ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) }),
    async () => ({ ok: true, status: 200, text: async () => "{not json SECRET-TOKEN" }),
  ]) {
    const r = await createPlannerClient(config, { fetchImpl, logger }).turn({
      token: "SECRET-TOKEN", message: "secret message", conversationId: "conv-0001", language: "en", bookingHandled: false,
    });
    assert.equal(r.ok, false);
  }
  assert.equal(logs.length, 3);
  for (const line of logs) assert.doesNotMatch(line, /SECRET-TOKEN|secret message/);
});
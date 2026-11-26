"use strict";

// The Guide is OFF by default: with no GUIDE_ENABLED / GUIDE_URL the route
// answers 503 and no request is ever sent anywhere.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server-harness");

let h;
test.before(async () => { h = await startServer(); });      // no Guide configured, like a normal install
test.after(async () => { await h.close(); });

test("1. disabled: a signed-in visitor gets 503 GUIDE_DISABLED and nothing is sent anywhere", async () => {
  const r = await h.api("POST", "/api/ai/guide", { token: h.TOKEN_A, body: { message: "Tell me about the Golden Throne" } });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: "GUIDE_DISABLED" });
  assert.deepEqual(h.outgoing, []);
});

test("2. disabled: authentication still comes first (no token: 401)", async () => {
  const r = await h.api("POST", "/api/ai/guide", { body: { message: "hi" } });
  assert.equal(r.status, 401);
  const fake = await h.api("POST", "/api/ai/guide", { token: "fake", body: { message: "hi" } });
  assert.equal(fake.status, 401);
});

test("3. disabled: the rest of the backend works as before", async () => {
  assert.equal((await h.api("GET", "/api/health")).status, 200);
  assert.equal((await h.api("GET", "/api/bookings", { token: h.TOKEN_A })).status, 200);
  const chat = await h.chat(h.TOKEN_A, "booking-conversation-0002", "I want to book 2 tickets for tomorrow");
  assert.equal(chat.status, 200);
  assert.deepEqual(h.outgoing, []);
});
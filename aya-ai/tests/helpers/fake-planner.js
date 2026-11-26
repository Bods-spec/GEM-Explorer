"use strict";

// =====================================================
// A stand-in for the Python Smart Visit Planner (POST /planner/turn).
//
// USED ONLY BY AUTOMATED TESTS. It listens on 127.0.0.1, records every
// request, and rejects tokens it does not know with 401 (like Python,
// which verifies the Supabase JWT itself). Tests script its answers
// with queue(). It proves how Node calls the planner; it says nothing
// about the real planner's wording or quality.
// =====================================================

const http = require("node:http");

function planBody(reply = "Here is your plan.", extra = {}) {
  return {
    status: "plan_created",
    reply,
    plan: { stops: [{ name: "Test Gallery", minutes: 30 }], totals: { minutes: 30 } },
    language: "en",
    ...extra,
  };
}
const statusBody = (status, reply, extra = {}) => ({ status, reply, plan: null, language: "en", ...extra });

async function startFakePlanner({ validTokens = [] } = {}) {
  const tokens = new Set(validTokens);
  const requests = [];
  const scripted = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      const auth = req.headers.authorization || "";
      const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] || null;
      requests.push({ method: req.method, url: req.url, auth, token, body });

      const send = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };

      if (req.method !== "POST" || req.url !== "/planner/turn") return send(404, { error: "NOT_FOUND" });
      if (!token || !tokens.has(token)) return send(401, { error: "UNAUTHORIZED" });

      const next = scripted.shift();
      let answer = typeof next === "function" ? next(body, token) : next;
      if (answer === undefined) answer = { body: statusBody("not_planning", "") };
      if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
      if (answer.destroy) return req.socket.destroy();
      return send(answer.status || 200, answer.raw ?? answer.body ?? {});
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    requests,
    allowToken: (t) => tokens.add(t),
    /** Next answers, in order. Each: { body, status?, delayMs?, destroy?, raw? } or a function(body, token). */
    queue: (...answers) => { scripted.push(...answers); },
    pending: () => scripted.length,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

module.exports = { startFakePlanner, planBody, statusBody };
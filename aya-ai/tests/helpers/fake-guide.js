"use strict";

// =====================================================
// A stand-in for the Python AI Museum Guide (POST /guide/chat).
//
// USED ONLY BY AUTOMATED TESTS. It listens on 127.0.0.1, records every
// request, and rejects tokens it does not know with 401 (like Python,
// which verifies the Supabase JWT itself). It also keeps conversations
// private to the user who started them, like Python does. Tests script
// its answers with queue(). It proves how Node calls the Guide; it says
// nothing about the real Guide's wording or quality.
// =====================================================

const http = require("node:http");

const CONV = "AbCdEfGhIjKlMnOpQrStUvWx";           // 24 characters, like Python's ids

function guideBody(reply = "The Golden Throne is a wooden armchair covered in gold. [1]", extra = {}) {
  return {
    status: "answered",
    reply,
    sources: [{
      n: 1,
      title: "Artefact: Golden Throne",
      url: "https://gem.eg/en/collection/artefacts/golden-throne",
      note: "Golden Throne",
      language: "en",
      verification_status: "verified",
      time_sensitive: false,
    }],
    contains_time_sensitive: false,
    handoff: null,
    conversation_id: CONV,
    language: "en",
    register: "en",
    enough_evidence: true,
    ...extra,
  };
}

async function startFakeGuide({ validTokens = [] } = {}) {
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
      requests.push({ method: req.method, url: req.url, auth, token, body, rawBody: raw });

      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };

      if (req.method !== "POST" || req.url !== "/guide/chat") return send(404, { error: "NOT_FOUND" });
      if (!token || !tokens.has(token)) return send(401, { error: "UNAUTHORIZED" });

      const next = scripted.shift();
      let answer = typeof next === "function" ? next(body, token) : next;
      if (answer === undefined) answer = { body: guideBody() };
      if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
      if (answer.destroy) return req.socket.destroy();
      return send(answer.status || 200, answer.raw ?? answer.body ?? {}, answer.headers);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    requests,
    allowToken: (t) => tokens.add(t),
    /** Next answers, in order. Each: { body, status?, headers?, delayMs?, destroy?, raw? } or a function(body, token). */
    queue: (...answers) => { scripted.push(...answers); },
    pending: () => scripted.length,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

module.exports = { startFakeGuide, guideBody, CONV };
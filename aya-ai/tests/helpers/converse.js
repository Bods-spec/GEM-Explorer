"use strict";

// Runs a conversation through the pure engine, saving the draft between
// turns the same way server.js does (the draft IS the conversation state).

const { processMessage } = require("../../backend/chatbot");

function converse(messages, { lang = "ar", now = new Date("2026-11-26T10:00:00Z"), draft = null } = {}) {
  const turns = [];
  let current = draft;
  for (const message of messages) {
    const bot = processMessage({ message, uiLanguage: lang, draft: current, now });
    turns.push({ message, ...bot });
    if (bot.action === "reset") current = null;
    else if (bot.save) {
      current = {
        status: "awaiting_confirmation",
        visit_date: bot.extracted.visit_date,
        visitors: bot.extracted.ticket_count,
        visitor_name: bot.extracted.visitor_name,
      };
    }
  }
  return { turns, last: turns[turns.length - 1], draft: current };
}

module.exports = { converse };
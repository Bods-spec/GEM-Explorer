"use strict";

// =====================================================
// GEM Explorer - Egyxos backend (one server file)
//
//   node server.js           start the API
//   node server.js --check   test the Supabase connection and exit
//
// Plain Node.js (built-in http) + Supabase. No Express, no n8n,
// no AI service. The conversation logic lives in chatbot.js.
//
// Sections:
//   1. Configuration
//   2. Supabase clients
//   3. Small helpers (JSON, body, CORS)
//   4. Authentication (real Supabase Auth + temporary Guest Mode)
//   5. Booking drafts (database access)
//   6. Booking confirmation (atomic database function)
//   7. Route handlers
//   8. HTTP server and start-up
// =====================================================

require("dotenv").config();

const http = require("node:http");
const { createClient } = require("@supabase/supabase-js");

const {
  processMessage,
  isConfirmation,
  isCancel,
  checkVisitDate,
  isValidVisitorCount,
  normalizeName,
  confirmedText,
  cancelText,
  cairoToday,
  isCancelConfirmation,
  modifyText,
  detectLanguage,
  extractBookingReference,
  detectCancelBooking,
  detectModifyBooking,
} = require("./chatbot");

const { readPlannerConfig, createPlannerClient } = require("./planner-client");
const { createPlanningFlow } = require("./planning-flow");
const {
  readGuideConfig,
  createGuideClient,
  CONVERSATION_ID_RE: GUIDE_CONVERSATION_ID_RE,
} = require("./guide-client");

// =====================================================
// 1. CONFIGURATION
// =====================================================

const PORT = Number(process.env.PORT || 3001);

const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "http://localhost:5600";

const MAX_BODY_BYTES = 16 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const CHECK_MODE = process.argv.includes("--check");

// Smart Visit Planning (Phase B). OFF unless PLANNER_ENABLED=true and
// PLANNER_URL is a valid http(s) address. When it is off, no planner
// code runs and no request is ever sent.
const plannerConfig = readPlannerConfig(process.env);
const planning = createPlanningFlow({
  client: createPlannerClient(plannerConfig),
});

// AI Museum Guide. OFF unless GUIDE_ENABLED=true and GUIDE_URL is a
// valid http(s) address. When it is off, no Guide code runs and no
// request is ever sent.
const guideConfig = readGuideConfig(process.env);
const guideClient = createGuideClient(guideConfig);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

// Names of the variables only (never their values).
const REQUIRED_ENV = CHECK_MODE
  ? ["SUPABASE_URL", "SUPABASE_SECRET_KEY"]
  : ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY"];

const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);

if (missingEnv.length > 0) {
  const message =
    "Missing configuration in backend/.env: " + missingEnv.join(", ");

  if (require.main === module) {
    console.error(message);
    process.exit(1);
  }

  throw new Error(message);
}

// =====================================================
// 2. SUPABASE CLIENTS
// =====================================================

const clientOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};

// Server-side client (secret key). It bypasses RLS, so EVERY query
// below filters by the verified user id. It never leaves this file.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  clientOptions
);

// Client used ONLY to verify access tokens (publishable key).
const authSupabase = process.env.SUPABASE_PUBLISHABLE_KEY
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_PUBLISHABLE_KEY,
      clientOptions
    )
  : null;

// =====================================================
// 3. SMALL HELPERS
// =====================================================

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  res.end(JSON.stringify(payload));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJson(req) {
  if (
    !req.headers["content-type"]
      ?.toLowerCase()
      .includes("application/json")
  ) {
    throw httpError(415, "Content-Type must be application/json");
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      throw httpError(413, "Request body is too large");
    }

    chunks.push(chunk);
  }

  let body;

  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Invalid JSON body");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "JSON body must be an object");
  }

  return body;
}

// The visitor's own access token (verified by authenticate() first).
// It is only ever forwarded to the planner or the Guide, never logged or stored.
function bearerToken(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  return match ? match[1] : null;
}

// Additive response fields. Absent when the planner took no part.
function plannerFields(decision) {
  return {
    ...(decision.plannerStatus ? { planner_status: decision.plannerStatus } : {}),
    ...(decision.plan ? { plan: decision.plan } : {}),
    ...(decision.hold ? { plan_pending: true } : {}),
  };
}

// =====================================================
// 4. AUTHENTICATION
// =====================================================

// TEMPORARY GUEST MODE (local testing only).
// Supabase Anonymous Authentication gives a guest a real, verified
// token. Guests are accepted only when ALL of these are true:
//   - ALLOW_GUEST_USERS=true in backend/.env
//   - NODE_ENV is not "production"
//   - FRONTEND_ORIGIN is a localhost address
// Remove the setting and every guest is rejected again.
function guestModeAllowed() {
  return (
    process.env.ALLOW_GUEST_USERS === "true" &&
    process.env.NODE_ENV !== "production" &&
    /^http:\/\/localhost(:\d+)?$/.test(FRONTEND_ORIGIN)
  );
}

// Returns the verified Supabase user, or null. The user id is
// NEVER taken from the request body.
async function authenticate(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(
    req.headers.authorization || ""
  );

  if (!match || !authSupabase) {
    return null;
  }

  const { data, error } = await authSupabase.auth.getUser(match[1]);

  if (error || !data?.user?.id) {
    return null;
  }

  if (data.user.is_anonymous === true && !guestModeAllowed()) {
    return null;
  }

  return data.user;
}

// =====================================================
// 5. BOOKING DRAFTS (database access)
// =====================================================

const DRAFT_FIELDS =
  "id, conversation_id, visitor_name, visit_date, visitors, status, revision, presented_revision, expires_at";

function validateIdentity(userId, conversationId) {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    throw new Error("INVALID_USER_ID");
  }

  if (
    typeof conversationId !== "string" ||
    !CONVERSATION_ID_RE.test(conversationId)
  ) {
    throw new Error("INVALID_CONVERSATION_ID");
  }
}

// null/undefined -> null. Anything else must be a valid name.
function cleanDraftName(name) {
  if (name === null || name === undefined) {
    return null;
  }

  const cleaned = normalizeName(name);

  if (cleaned === null) {
    throw new Error("INVALID_VISITOR_NAME");
  }

  return cleaned;
}

// A draft may still be missing its date or visitor count (the
// chatbot saves details as it learns them). Values that ARE present
// are always validated.
function validateDraftValues(visitDate, visitors) {
  if (visitors !== null && !isValidVisitorCount(visitors)) {
    throw new Error("INVALID_VISITORS");
  }

  if (visitDate !== null && checkVisitDate(visitDate) !== "ok") {
    throw new Error("INVALID_DATE");
  }
}

// Saves exactly what the chatbot sent, so a field the visitor asked to
// change stays cleared. The revision goes up only when something changed.
async function saveBookingDraft({
  userId,
  conversationId,
  visitDate,
  visitors,
  visitorName = null,
}) {
  validateIdentity(userId, conversationId);
  validateDraftValues(visitDate, visitors);

  const finalName = cleanDraftName(visitorName);

  const { data: existing, error: readError } = await supabase
    .from("booking_drafts")
    .select("status, revision, visit_date, visitors, visitor_name")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (readError) {
    throw readError;
  }

  if (existing && existing.status !== "awaiting_confirmation") {
    throw new Error("DRAFT_NOT_EDITABLE");
  }

  const changed =
    !existing ||
    existing.visit_date !== visitDate ||
    existing.visitors !== visitors ||
    existing.visitor_name !== finalName;

  const revision = existing
    ? existing.revision + (changed ? 1 : 0)
    : 1;

  const now = new Date();

  const { data, error } = await supabase
    .from("booking_drafts")
    .upsert(
      {
        user_id: userId,
        conversation_id: conversationId,
        visit_date: visitDate,
        visitors,
        visitor_name: finalName,
        status: "awaiting_confirmation",
        revision,
        updated_at: now.toISOString(),
        expires_at: new Date(now.getTime() + DAY_MS).toISOString(),
      },
      { onConflict: "user_id,conversation_id" }
    )
    .select(DRAFT_FIELDS)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Reads this user's draft for the conversation in ANY status (the
// chatbot must know when a booking is already completed or cancelled).
async function getConversationDraft({ userId, conversationId }) {
  validateIdentity(userId, conversationId);

  const { data, error } = await supabase
    .from("booking_drafts")
    .select(DRAFT_FIELDS)
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

// =====================================================
// 6. BOOKING CONFIRMATION
// =====================================================

function confirmationError(code, status = 409) {
  const error = new Error(code);
  error.status = status;
  return error;
}

// The visitor must have said an explicit "yes". The accepted phrases
// live in ONE place (chatbot.js) so server and chatbot cannot disagree.
function isExplicitConfirmation(message) {
  return isConfirmation(message);
}

async function confirmEgyxosBooking({
  userId,
  conversationId,
  extracted,
  expectedRevision,
}) {
  // Read only this authenticated user's draft.
  const { data: draft, error: readError } = await supabase
    .from("booking_drafts")
    .select(
      "id, visitor_name, visit_date, visitors, status, revision, presented_revision, presented_at"
    )
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (readError) {
    throw confirmationError("BOOKING_DRAFT_LOOKUP_FAILED", 500);
  }

  if (!draft) {
    throw confirmationError("BOOKING_DRAFT_NOT_FOUND");
  }

  if (
    draft.status !== "awaiting_confirmation" &&
    draft.status !== "completed"
  ) {
    throw confirmationError("BOOKING_DRAFT_NOT_ACTIVE");
  }

  // The visitor may only confirm the exact revision that was shown.
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    draft.revision !== expectedRevision ||
    draft.presented_revision !== expectedRevision ||
    !draft.presented_at
  ) {
    throw confirmationError("BOOKING_REVISION_NOT_PRESENTED");
  }

  // The stored draft is the source of truth. A value that is present
  // but different is rejected; a missing value is acceptable.
  if (
    (extracted.visit_date !== null &&
      extracted.visit_date !== draft.visit_date) ||
    (extracted.ticket_count !== null &&
      extracted.ticket_count !== draft.visitors) ||
    (extracted.visitor_name !== null &&
      extracted.visitor_name !== draft.visitor_name)
  ) {
    throw confirmationError("BOOKING_DETAILS_MISMATCH");
  }

  if (
    !draft.visitor_name ||
    !draft.visit_date ||
    !Number.isInteger(draft.visitors)
  ) {
    throw confirmationError("BOOKING_DETAILS_INCOMPLETE");
  }

  // One atomic database operation. PostgreSQL handles locking,
  // idempotency and duplicate prevention.
  const { data: booking, error } = await supabase.rpc(
    "confirm_egyxos_booking",
    {
      p_user_id: userId,
      p_conversation_id: conversationId,
      p_expected_revision: expectedRevision,
    }
  );

  if (error) {
    const allowedErrors = [
      "BOOKING_DRAFT_NOT_FOUND",
      "BOOKING_DRAFT_NOT_ACTIVE",
      "BOOKING_DRAFT_CHANGED",
      "VISITOR_NAME_REQUIRED",
      "INVALID_VISITOR_COUNT",
      "INVALID_VISIT_DATE",
    ];

    const knownError = allowedErrors.find((code) =>
      String(error.message).includes(code)
    );

    throw confirmationError(
      knownError || "BOOKING_CONFIRMATION_FAILED",
      knownError ? 409 : 500
    );
  }

  if (
    !booking ||
    booking.status !== "confirmed" ||
    !booking.booking_reference
  ) {
    throw confirmationError("INVALID_CONFIRMATION_RESULT", 500);
  }

  return booking;
}

// =====================================================
// 7. ROUTE HANDLERS
// =====================================================

// ---------- GET /api/health ----------

function handleHealth(res) {
  return sendJson(res, 200, {
    success: true,
    service: "GEM Explorer Backend",
    status: "running",
  });
}

// ---------- bookings: shared format ----------

const BOOKING_FIELDS =
  "id, booking_reference, visitor_name, visit_date, visitors, status, created_at";

function formatBooking(row) {
  return {
    id: row.id,
    booking_reference: row.booking_reference,
    visitor_name: row.visitor_name,
    visit_date: row.visit_date,
    ticket_count: row.visitors,
    status: row.status,
    created_at: row.created_at,
  };
}

// ---------- cancelling a CONFIRMED booking: database access ----------
//
// A reference alone never cancels anything. The flow is:
//   1. the visitor sends a reference -> we look it up with the reference
//      AND the verified user id, and store a short-lived "pending
//      cancellation" row for this user and conversation;
//   2. the visitor's next message must be an explicit yes -> the database
//      function cancel_egyxos_booking() checks that row and changes the
//      status in one transaction.

const CANCEL_TTL_MS = 5 * 60 * 1000;

// The visitor's OWN booking with this reference, or null. Another user's
// booking and an unknown reference look exactly the same.
async function findOwnBookingByReference(userId, reference, fields = BOOKING_FIELDS) {
  const { data, error } = await supabase
    .from("bookings")
    .select(fields)
    .eq("user_id", userId)
    .eq("booking_reference", reference)
    .limit(2);

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    return null;
  }

  if (data.length > 1) {
    throw new Error("BOOKING_REFERENCE_AMBIGUOUS");
  }

  return data[0];
}

// The visitor's open "are you sure?" row, or null. An expired row is still
// returned (expired: true) so the visitor can be told it timed out.
async function getPendingCancellation(userId, conversationId) {
  validateIdentity(userId, conversationId);

  const { data, error } = await supabase
    .from("booking_cancellation_requests")
    .select("id, booking_id, booking_reference, expires_at")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .eq("status", "pending")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data
    ? { ...data, expired: new Date(data.expires_at) <= new Date() }
    : null;
}

async function savePendingCancellation(userId, conversationId, booking) {
  validateIdentity(userId, conversationId);

  const now = new Date();

  const { error } = await supabase
    .from("booking_cancellation_requests")
    .upsert(
      {
        user_id: userId,
        conversation_id: conversationId,
        booking_id: booking.id,
        booking_reference: booking.booking_reference,
        status: "pending",
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + CANCEL_TTL_MS).toISOString(),
      },
      { onConflict: "user_id,conversation_id" }
    );

  if (error) {
    throw error;
  }
}

async function dismissPendingCancellation(userId, conversationId) {
  const { error } = await supabase
    .from("booking_cancellation_requests")
    .update({ status: "dismissed" })
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .eq("status", "pending");

  if (error) {
    throw error;
  }
}

// Calls the atomic database function. Throws an error whose .code is one
// of the known business outcomes, or "BOOKING_CANCELLATION_FAILED".
async function cancelConfirmedBooking(userId, conversationId) {
  const { data, error } = await supabase.rpc("cancel_egyxos_booking", {
    p_user_id: userId,
    p_conversation_id: conversationId,
  });

  if (error) {
    const known = [
      "CANCELLATION_NOT_REQUESTED",
      "CANCELLATION_EXPIRED",
      "BOOKING_NOT_FOUND",
      "BOOKING_NOT_CANCELLABLE",
    ].find((code) => String(error.message).includes(code));

    const failure = new Error(known || "BOOKING_CANCELLATION_FAILED");
    failure.code = known || "BOOKING_CANCELLATION_FAILED";
    throw failure;
  }

  if (!data || data.status !== "cancelled" || !data.booking_reference) {
    const failure = new Error("INVALID_CANCELLATION_RESULT");
    failure.code = "BOOKING_CANCELLATION_FAILED";
    throw failure;
  }

  return data;
}

// ---------- modifying a CONFIRMED booking: database access ----------
//
// Same shape as cancellation. A message with a reference and a change never
// changes anything: it stores a short-lived "pending modification" (the
// complete proposed values plus a snapshot of the booking) for this user
// and conversation. Only the visitor's next explicit yes calls the database
// function modify_egyxos_booking(), which re-checks everything and updates
// the SAME booking row in one transaction.

const MODIFY_TTL_MS = 5 * 60 * 1000;
const BOOKING_FIELDS_WITH_VERSION = `${BOOKING_FIELDS}, updated_at`;

// The conversation's modification row (one per user + conversation), or null.
// status "pending" = an open question (expired: true once it timed out),
// "used" = already applied, "dismissed" = closed without applying.
async function getModificationRequest(userId, conversationId) {
  validateIdentity(userId, conversationId);

  const { data, error } = await supabase
    .from("booking_modification_requests")
    .select(
      "id, booking_id, booking_reference, status, expires_at, " +
        "proposed_visit_date, proposed_visitors, proposed_visitor_name"
    )
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data
    ? { ...data, expired: new Date(data.expires_at) <= new Date() }
    : null;
}

async function savePendingModification(userId, conversationId, booking, proposed) {
  validateIdentity(userId, conversationId);

  const now = new Date();

  const { error } = await supabase
    .from("booking_modification_requests")
    .upsert(
      {
        user_id: userId,
        conversation_id: conversationId,
        booking_id: booking.id,
        booking_reference: booking.booking_reference,
        proposed_visit_date: proposed.visit_date,
        proposed_visitors: proposed.visitors,
        proposed_visitor_name: proposed.visitor_name,
        base_visit_date: booking.visit_date,
        base_visitors: booking.visitors,
        base_visitor_name: booking.visitor_name,
        // Passed back exactly as read, so the database can detect that
        // the booking changed after the proposal was shown.
        base_updated_at: booking.updated_at,
        status: "pending",
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + MODIFY_TTL_MS).toISOString(),
      },
      { onConflict: "user_id,conversation_id" }
    );

  if (error) {
    throw error;
  }
}

async function dismissPendingModification(userId, conversationId) {
  const { error } = await supabase
    .from("booking_modification_requests")
    .update({ status: "dismissed" })
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .eq("status", "pending");

  if (error) {
    throw error;
  }
}

// Calls the atomic database function. Throws an error whose .code is one
// of the known business outcomes, or "BOOKING_MODIFICATION_FAILED".
async function modifyConfirmedBooking(userId, conversationId) {
  const { data, error } = await supabase.rpc("modify_egyxos_booking", {
    p_user_id: userId,
    p_conversation_id: conversationId,
  });

  if (error) {
    const known = [
      "MODIFICATION_NOT_REQUESTED",
      "MODIFICATION_EXPIRED",
      "BOOKING_NOT_FOUND",
      "BOOKING_NOT_MODIFIABLE",
      "BOOKING_CHANGED",
      "INVALID_VISITOR_COUNT",
      "INVALID_VISIT_DATE",
      "INVALID_VISITOR_NAME",
    ].find((code) => String(error.message).includes(code));

    const failure = new Error(known || "BOOKING_MODIFICATION_FAILED");
    failure.code = known || "BOOKING_MODIFICATION_FAILED";
    throw failure;
  }

  if (!data || data.status !== "confirmed" || !data.booking_reference) {
    const failure = new Error("INVALID_MODIFICATION_RESULT");
    failure.code = "BOOKING_MODIFICATION_FAILED";
    throw failure;
  }

  return data;
}

// Does this booking already hold the values of the modification row?
function bookingMatchesModification(booking, row) {
  return (
    booking.status === "confirmed" &&
    booking.visit_date === row.proposed_visit_date &&
    booking.visitors === row.proposed_visitors &&
    (booking.visitor_name ?? null) === (row.proposed_visitor_name ?? null)
  );
}

// ---------- GET /api/bookings (My Bookings) ----------

async function handleListBookings(res, user) {
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_FIELDS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("List bookings failed:", error.message);
    return sendJson(res, 500, { error: "Could not retrieve bookings" });
  }

  return sendJson(res, 200, {
    data: { bookings: data.map(formatBooking) },
  });
}

// ---------- POST /api/bookings (legacy direct create) ----------
//
// NOT used by the page: the page books through POST /api/ai/chat.
// This route skips the chat confirmation flow, so it is OFF unless
// ENABLE_DIRECT_BOOKING_API=true is set in backend/.env.

function directBookingEnabled() {
  return process.env.ENABLE_DIRECT_BOOKING_API === "true";
}

async function handleCreateBooking(req, res, user) {
  const body = await readJson(req);
  const { visit_date, ticket_count } = body;

  if (checkVisitDate(visit_date) !== "ok") {
    return sendJson(res, 422, {
      error: "INVALID_DATE",
      message: "Choose a valid date within the next 365 days.",
    });
  }

  if (!isValidVisitorCount(ticket_count)) {
    return sendJson(res, 422, {
      error: "INVALID_VISITORS",
      message: "Number of visitors must be between 1 and 10.",
    });
  }

  const idempotencyKey = req.headers["idempotency-key"];

  if (
    typeof idempotencyKey !== "string" ||
    !CONVERSATION_ID_RE.test(idempotencyKey)
  ) {
    return sendJson(res, 400, {
      error: "INVALID_IDEMPOTENCY_KEY",
      message: "Provide a valid Idempotency-Key header.",
    });
  }

  const findExistingBooking = () =>
    supabase
      .from("bookings")
      .select(BOOKING_FIELDS)
      .eq("user_id", user.id)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

  const respondWithExisting = (row) => {
    if (row.visit_date !== visit_date || row.visitors !== ticket_count) {
      return sendJson(res, 409, {
        error: "IDEMPOTENCY_CONFLICT",
        message: "This request key was used for different details.",
      });
    }

    return sendJson(res, 200, {
      data: { booking: formatBooking(row), replayed: true },
    });
  };

  const previous = await findExistingBooking();

  if (previous.error) {
    console.error("Booking lookup failed:", previous.error.message);
    return sendJson(res, 500, { error: "Could not check existing booking" });
  }

  if (previous.data) {
    return respondWithExisting(previous.data);
  }

  const { data, error } = await supabase
    .from("bookings")
    .insert({
      user_id: user.id,
      visit_date,
      visitors: ticket_count,
      status: "confirmed",
      idempotency_key: idempotencyKey,
    })
    .select(BOOKING_FIELDS)
    .single();

  if (error) {
    if (error.code === "23505") {
      const retry = await findExistingBooking();

      if (!retry.error && retry.data) {
        return respondWithExisting(retry.data);
      }
    }

    console.error("Create booking failed:", error.message);
    return sendJson(res, 500, { error: "Could not create booking" });
  }

  return sendJson(res, 201, {
    data: { booking: formatBooking(data), replayed: false },
  });
}

// ---------- cancelling a confirmed booking: chat answers ----------

// The summary of an unfinished draft stays confirmable only if it was
// already presented and nothing changed. Cancel-flow messages do not touch
// the draft, so the page keeps the same revision.
function shownRevisionOf(draft) {
  return draft &&
    draft.status === "awaiting_confirmation" &&
    draft.presented_revision !== null &&
    draft.presented_revision === draft.revision
    ? draft.revision
    : null;
}

async function handleCancelFlow(
  res,
  { user, conversationId, bot, botLanguage, activeDraft, pendingCancellation }
) {
  const answer = (reply, extra = {}) =>
    sendJson(res, 200, {
      data: {
        reply,
        language: botLanguage,
        extracted: bot.extracted,
        action: null,
        draft_saved: false,
        confirmation_revision: shownRevisionOf(activeDraft),
        ...extra,
      },
    });

  const cancelledAnswer = (booking) =>
    answer(
      cancelText(booking.replayed ? "already" : "done", botLanguage, booking),
      { action: "cancel_booking", booking }
    );

  // ---- step 1: the visitor named a booking ----

  if (bot.action === "cancel_booking_lookup") {
    let booking;

    try {
      booking = await findOwnBookingByReference(user.id, bot.cancelReference);
    } catch (error) {
      console.error("Booking lookup failed:", error.message);
      return sendJson(res, 500, { error: "BOOKING_LOOKUP_FAILED" });
    }

    if (!booking || (booking.status !== "confirmed" && booking.status !== "cancelled")) {
      return answer(cancelText("notFound", botLanguage));
    }

    const shown = formatBooking(booking);

    if (booking.status === "cancelled") {
      return answer(cancelText("already", botLanguage, shown));
    }

    if (booking.visit_date < cairoToday()) {
      return answer(cancelText("past", botLanguage));
    }

    try {
      await savePendingCancellation(user.id, conversationId, booking);
    } catch (error) {
      console.error("Could not save pending cancellation:", error.message);
      return sendJson(res, 500, { error: "CANCELLATION_SAVE_FAILED" });
    }

    return answer(cancelText("found", botLanguage, shown));
  }

  // ---- the visitor answered after the question timed out ----

  if (bot.action === "cancel_booking_expired") {
    return answer(cancelText("expired", botLanguage));
  }

  // ---- the visitor kept the booking (the pending row is already closed) ----

  if (bot.action === "cancel_booking_decline") {
    return answer(bot.reply);
  }

  // ---- step 2: the visitor said an explicit yes ----

  if (bot.action === "cancel_booking_confirm") {
    try {
      const booking = await cancelConfirmedBooking(user.id, conversationId);
      return cancelledAnswer(booking);
    } catch (error) {
      console.error("Booking cancellation failed:", error.message);

      if (error.code === "CANCELLATION_EXPIRED") {
        return answer(cancelText("expired", botLanguage));
      }

      if (error.code === "BOOKING_NOT_CANCELLABLE") {
        return answer(cancelText("past", botLanguage));
      }

      if (error.code === "BOOKING_NOT_FOUND") {
        return answer(cancelText("notFound", botLanguage));
      }

      if (error.code === "CANCELLATION_NOT_REQUESTED" && pendingCancellation) {
        // A simultaneous request already used the question. If the booking
        // is cancelled now, that is the result the visitor wanted.
        try {
          const booking = await findOwnBookingByReference(
            user.id,
            pendingCancellation.booking_reference
          );

          if (booking && booking.status === "cancelled") {
            return cancelledAnswer({ ...formatBooking(booking), replayed: true });
          }
        } catch (lookupError) {
          console.error("Booking lookup failed:", lookupError.message);
        }

        return answer(cancelText("expired", botLanguage));
      }

      return sendJson(res, 500, { error: "BOOKING_CANCELLATION_FAILED" });
    }
  }

  // ---- no database work: Egyxos only explains (invalid reference, ask for one) ----

  return answer(bot.reply);
}

// ---------- modifying a confirmed booking: chat answers ----------

async function handleModifyFlow(
  res,
  { user, conversationId, bot, botLanguage, activeDraft, pendingModification, replayBooking }
) {
  const answer = (reply, extra = {}) =>
    sendJson(res, 200, {
      data: {
        reply,
        language: botLanguage,
        extracted: bot.extracted,
        action: null,
        draft_saved: false,
        confirmation_revision: shownRevisionOf(activeDraft),
        ...extra,
      },
    });

  const modifiedAnswer = (booking) =>
    answer(modifyText("done", botLanguage, null, booking), {
      action: "modify_booking",
      booking,
    });

  // ---- step 1: the visitor named a booking and a change ----

  if (bot.action === "modify_booking_lookup") {
    let booking;

    try {
      booking = await findOwnBookingByReference(
        user.id,
        bot.modifyReference,
        BOOKING_FIELDS_WITH_VERSION
      );
    } catch (error) {
      console.error("Booking lookup failed:", error.message);
      return sendJson(res, 500, { error: "BOOKING_LOOKUP_FAILED" });
    }

    if (!booking || (booking.status !== "confirmed" && booking.status !== "cancelled")) {
      return answer(modifyText("notFound", botLanguage));
    }

    const shown = formatBooking(booking);

    if (booking.status === "cancelled") {
      return answer(modifyText("cancelled", botLanguage, shown));
    }

    if (booking.visit_date < cairoToday()) {
      return answer(modifyText("past", botLanguage));
    }

    // The complete proposal: the changed fields plus everything unchanged.
    const changes = bot.modifyChanges || {};
    const proposed = {
      visit_date: changes.visit_date ?? booking.visit_date,
      visitors: changes.visitors ?? booking.visitors,
      visitor_name: changes.visitor_name ?? booking.visitor_name,
    };

    // The same rules the database enforces, checked again here.
    if (
      checkVisitDate(proposed.visit_date) !== "ok" ||
      !isValidVisitorCount(proposed.visitors) ||
      (changes.visitor_name !== undefined && !normalizeName(changes.visitor_name))
    ) {
      return answer(modifyText("failed", botLanguage));
    }

    const proposedShown = {
      ...shown,
      visit_date: proposed.visit_date,
      ticket_count: proposed.visitors,
      visitor_name: proposed.visitor_name,
    };

    // Nothing would change: no question, no pending row.
    if (
      proposed.visit_date === booking.visit_date &&
      proposed.visitors === booking.visitors &&
      (proposed.visitor_name ?? null) === (booking.visitor_name ?? null)
    ) {
      return answer(modifyText("same", botLanguage, shown));
    }

    try {
      await savePendingModification(user.id, conversationId, booking, proposed);
    } catch (error) {
      console.error("Could not save pending modification:", error.message);
      return sendJson(res, 500, { error: "MODIFICATION_SAVE_FAILED" });
    }

    return answer(modifyText("found", botLanguage, shown, proposedShown));
  }

  // ---- the visitor answered after the question timed out ----

  if (bot.action === "modify_booking_expired") {
    return answer(modifyText("expired", botLanguage));
  }

  // ---- the visitor kept the booking (the pending row is already closed) ----

  if (bot.action === "modify_booking_decline") {
    return answer(bot.reply);
  }

  // ---- the same "yes" again, after the change was already applied ----

  if (bot.action === "modify_booking_replay" && replayBooking) {
    return modifiedAnswer(replayBooking);
  }

  // ---- step 2: the visitor said an explicit yes ----

  if (bot.action === "modify_booking_confirm") {
    try {
      const booking = await modifyConfirmedBooking(user.id, conversationId);
      return modifiedAnswer(booking);
    } catch (error) {
      console.error("Booking modification failed:", error.message);

      if (error.code === "MODIFICATION_EXPIRED") {
        return answer(modifyText("expired", botLanguage));
      }

      if (error.code === "BOOKING_CHANGED") {
        return answer(modifyText("stale", botLanguage));
      }

      if (error.code === "BOOKING_NOT_FOUND") {
        return answer(modifyText("notFound", botLanguage));
      }

      if (error.code === "BOOKING_NOT_MODIFIABLE") {
        // Cancelled after the proposal, or the visit date has passed.
        try {
          const booking = await findOwnBookingByReference(
            user.id,
            pendingModification.booking_reference
          );

          if (booking && booking.status === "cancelled") {
            return answer(modifyText("cancelled", botLanguage, formatBooking(booking)));
          }
        } catch (lookupError) {
          console.error("Booking lookup failed:", lookupError.message);
        }

        return answer(modifyText("past", botLanguage));
      }

      if (error.code === "MODIFICATION_NOT_REQUESTED" && pendingModification) {
        // A simultaneous request already used the question. If the booking
        // holds the proposed values now, that is the result the visitor wanted.
        try {
          const booking = await findOwnBookingByReference(
            user.id,
            pendingModification.booking_reference
          );

          if (booking && bookingMatchesModification(booking, pendingModification)) {
            return modifiedAnswer(formatBooking(booking));
          }
        } catch (lookupError) {
          console.error("Booking lookup failed:", lookupError.message);
        }

        return answer(modifyText("expired", botLanguage));
      }

      if (String(error.code).startsWith("INVALID_")) {
        return answer(modifyText("failed", botLanguage));
      }

      return sendJson(res, 500, { error: "BOOKING_MODIFICATION_FAILED" });
    }
  }

  // ---- no database work: Egyxos only explains (ask for a reference, a change...) ----

  return answer(bot.reply);
}

// ---------- POST /api/ai/chat (Egyxos rule-based chat) ----------
//
// The endpoint name is kept so the frontend contract does not change,
// but no AI service is called: chatbot.js decides what Egyxos says.
// This route owns every database write, so all booking safeguards
// (revisions, explicit confirmation, atomic RPC) stay in force.

async function handleChat(req, res, user) {
  // ---- Read and validate the request ----

  const body = await readJson(req);

  const message =
    typeof body.message === "string" ? body.message.trim() : null;

  const conversationId = body.conversation_id;
  const language = body.language === "en" ? "en" : "ar";

  if (
    !message ||
    message.length > 2000 ||
    typeof conversationId !== "string" ||
    !CONVERSATION_ID_RE.test(conversationId)
  ) {
    return sendJson(res, 400, { error: "INVALID_CHAT_REQUEST" });
  }

  // ---- Read the stored draft ----
  // The draft in the database IS the conversation state.
  // The browser is never trusted for it.

  let storedDraft;

  try {
    storedDraft = await getConversationDraft({
      userId: user.id,
      conversationId,
    });
  } catch (error) {
    console.error("Draft lookup failed:", error.message);
    return sendJson(res, 500, { error: "BOOKING_DRAFT_LOOKUP_FAILED" });
  }

  // An unconfirmed draft past its expiry counts as "nothing saved yet".
  const draftExpired =
    storedDraft &&
    storedDraft.status === "awaiting_confirmation" &&
    new Date(storedDraft.expires_at) <= new Date();

  const activeDraft = draftExpired ? null : storedDraft;

  // ---- Is a cancellation question waiting for this visitor's answer? ----
  // Only the database says so (never the browser). If this cannot be
  // checked we stop: a "yes" must never be guessed.

  let openCancellation = null;

  try {
    openCancellation = await getPendingCancellation(
      user.id,
      conversationId
    );
  } catch (error) {
    console.error("Cancellation lookup failed:", error.message);
    return sendJson(res, 500, { error: "CANCELLATION_LOOKUP_FAILED" });
  }

  // An expired question can no longer be answered.
  const pendingCancellation =
    openCancellation && !openCancellation.expired ? openCancellation : null;

  // ---- Is a modification question waiting for this visitor's answer? ----
  // One row per conversation: "pending" is an open question, "used" is a
  // change that was already applied. Same fail-closed rule as above.

  let modificationRow = null;

  try {
    modificationRow = await getModificationRequest(user.id, conversationId);
  } catch (error) {
    console.error("Modification lookup failed:", error.message);
    return sendJson(res, 500, { error: "MODIFICATION_LOOKUP_FAILED" });
  }

  const openModification =
    modificationRow && modificationRow.status === "pending"
      ? modificationRow
      : null;

  const pendingModification =
    openModification && !openModification.expired ? openModification : null;

  const usedModification =
    modificationRow && modificationRow.status === "used" ? modificationRow : null;

  // ---- Two open questions at once (two simultaneous requests) ----
  // A "yes" could mean either, so close both and ask again.

  if (pendingCancellation && pendingModification) {
    try {
      await dismissPendingCancellation(user.id, conversationId);
      await dismissPendingModification(user.id, conversationId);
    } catch (error) {
      console.error("Could not close pending questions:", error.message);
      return sendJson(res, 500, { error: "PENDING_DISMISS_FAILED" });
    }

    const ambiguousLanguage = detectLanguage(message, language);

    return sendJson(res, 200, {
      data: {
        reply: modifyText("ambiguousPending", ambiguousLanguage),
        language: ambiguousLanguage,
        extracted: {
          visit_date: activeDraft?.visit_date ?? null,
          ticket_count: activeDraft?.visitors ?? null,
          visitor_name: activeDraft?.visitor_name ?? null,
        },
        action: null,
        draft_saved: false,
        confirmation_revision: shownRevisionOf(activeDraft),
      },
    });
  }

  // ---- Smart Visit Planning (feature flag) ----
  // Runs BEFORE the booking parser, because the parser would read a
  // visit duration ("90 minutes") as a visitor count. With the flag off
  // this returns the message unchanged and does nothing else. Messages
  // about an already CONFIRMED booking (a GEM-... reference, or an open
  // cancel/modify question) never reach the planner.

  const confirmedBookingTalk =
    Boolean(pendingCancellation || pendingModification || usedModification) ||
    Boolean(extractBookingReference(message)) ||
    detectCancelBooking(message).intent ||
    detectModifyBooking(message).intent;

  let decision;

  try {
    decision = await planning.decide({
      userId: user.id,
      conversationId,
      token: bearerToken(req),
      message,
      uiLanguage: language,
      draft: activeDraft,
      skip: confirmedBookingTalk,
    });
  } catch (error) {
    console.error("Planning step failed:", error.message);

    decision = {
      mode: "engine",
      message,
      prefix: "",
      hold: false,
      holdReply: "",
      plan: null,
      plannerStatus: null,
    };
  }

  // Planning only, and no booking in progress: answer with the plan.
  // Nothing is saved.
  if (decision.mode === "direct") {
    return sendJson(res, 200, {
      data: {
        reply: decision.prefix,
        language: detectLanguage(message, language),
        extracted: {
          visit_date: null,
          ticket_count: null,
          visitor_name: null,
        },
        action: null,
        draft_saved: false,
        confirmation_revision: null,
        ...plannerFields(decision),
      },
    });
  }

  // What the booking chatbot reads. Equal to `message` unless the
  // planner took part in this turn (a duration is removed from it).
  const engineMessage = decision.message;

  // ---- Run the rule-based chatbot (pure: no database access) ----

  let bot = processMessage({
    message: engineMessage,
    uiLanguage: language,
    draft: activeDraft,
    pendingCancellation: pendingCancellation
      ? { reference: pendingCancellation.booking_reference }
      : null,
    pendingModification: pendingModification
      ? { reference: pendingModification.booking_reference }
      : null,
  });

  // A "yes, cancel it" that arrives after the question expired: say so.
  // (A real draft confirmation in the same conversation still wins.)
  if (
    openCancellation?.expired &&
    bot.action !== "confirm" &&
    !bot.modifyFlow &&
    isCancelConfirmation(message)
  ) {
    bot = { ...bot, cancelFlow: true, action: "cancel_booking_expired" };
  }

  // A "yes" that arrives after a modification question expired: say so.
  if (
    openModification?.expired &&
    bot.action !== "confirm" &&
    !bot.cancelFlow &&
    !bot.modifyFlow &&
    isConfirmation(message)
  ) {
    bot = { ...bot, modifyFlow: true, action: "modify_booking_expired" };
  }

  // The same "yes" sent again after the change was applied: Egyxos repeats
  // the result and the database is not called, so nothing is applied twice.
  // Only with no other open question and no unfinished draft waiting for
  // its own "yes", and only while the proposal's own time window is open.
  let replayBooking = null;

  if (
    usedModification &&
    !usedModification.expired &&
    bot.action === null &&
    !bot.cancelFlow &&
    !bot.modifyFlow &&
    !pendingCancellation &&
    activeDraft?.status !== "awaiting_confirmation" &&
    isConfirmation(message)
  ) {
    try {
      const booking = await findOwnBookingByReference(
        user.id,
        usedModification.booking_reference
      );

      if (booking && bookingMatchesModification(booking, usedModification)) {
        replayBooking = formatBooking(booking);
        bot = { ...bot, modifyFlow: true, action: "modify_booking_replay" };
      }
    } catch (error) {
      console.error("Booking lookup failed:", error.message);
    }
  }

  const visitDate = bot.extracted.visit_date;
  const visitors = bot.extracted.ticket_count;
  const visitorName = bot.extracted.visitor_name;
  const botLanguage = bot.language === "en" ? "en" : "ar";

  // ---- Invalidate the previously presented revision ----
  // Any message that is not a confirmation may change the booking,
  // so the summary the visitor saw before no longer counts.
  // Messages about cancelling a DIFFERENT, confirmed booking do not
  // touch the draft, so the summary on screen stays valid.

  if (!isExplicitConfirmation(engineMessage) && !bot.cancelFlow && !bot.modifyFlow) {
    const { error: revokeError } = await supabase
      .from("booking_drafts")
      .update({ presented_revision: null, presented_at: null })
      .eq("user_id", user.id)
      .eq("conversation_id", conversationId)
      .eq("status", "awaiting_confirmation");

    if (revokeError) {
      console.error(
        "Could not invalidate previous confirmation:",
        revokeError.message
      );

      return sendJson(res, 500, {
        error: "BOOKING_PRESENTATION_RESET_FAILED",
      });
    }
  }

  // ---- A pending cancellation lives for exactly ONE answer ----
  // Anything except the explicit "yes" closes it, so an old question can
  // never be answered by a later, unrelated "yes".

  if (openCancellation && bot.action !== "cancel_booking_confirm") {
    try {
      await dismissPendingCancellation(user.id, conversationId);
    } catch (error) {
      console.error("Could not close pending cancellation:", error.message);
      return sendJson(res, 500, { error: "CANCELLATION_DISMISS_FAILED" });
    }
  }

  // ---- A pending modification lives for exactly ONE answer ----
  // Anything except the explicit "yes" closes it (the same rule as above).

  if (openModification && bot.action !== "modify_booking_confirm") {
    try {
      await dismissPendingModification(user.id, conversationId);
    } catch (error) {
      console.error("Could not close pending modification:", error.message);
      return sendJson(res, 500, { error: "MODIFICATION_DISMISS_FAILED" });
    }
  }

  // ---- Modifying a CONFIRMED booking ----

  if (bot.modifyFlow) {
    return await handleModifyFlow(res, {
      user,
      conversationId,
      bot,
      botLanguage,
      activeDraft,
      pendingModification,
      replayBooking,
    });
  }

  // ---- Cancelling a CONFIRMED booking ----

  if (bot.cancelFlow) {
    return await handleCancelFlow(res, {
      user,
      conversationId,
      bot,
      botLanguage,
      activeDraft,
      pendingCancellation,
    });
  }

  // ---- Cancel the booking request ----

  if (bot.action === "reset") {
    // Defense in depth: cancelling a draft is destructive.
    if (!isCancel(message)) {
      return sendJson(res, 409, { error: "EXPLICIT_RESET_REQUIRED" });
    }

    const { data: cancelled, error } = await supabase
      .from("booking_drafts")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)
      .eq("conversation_id", conversationId)
      .eq("status", "awaiting_confirmation")
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("Draft cancellation failed:", error.message);
      return sendJson(res, 500, { error: "BOOKING_RESET_FAILED" });
    }

    if (!cancelled) {
      return sendJson(res, 409, { error: "NO_ACTIVE_DRAFT_TO_CANCEL" });
    }

    return sendJson(res, 200, {
      data: {
        reply: bot.reply,
        language: botLanguage,
        extracted: {
          visit_date: null,
          ticket_count: null,
          visitor_name: null,
        },
        action: "reset",
        draft_saved: false,
        new_conversation_required: true,
      },
    });
  }

  // ---- Confirm the booking ----

  if (bot.action === "confirm") {
    // A plan the visitor asked for has not been shown yet: nothing can be
    // confirmed. (No booking function is called.)
    if (decision.hold) {
      return sendJson(res, 200, {
        data: {
          reply: decision.holdReply || bot.reply,
          language: botLanguage,
          extracted: bot.extracted,
          action: null,
          draft_saved: false,
          confirmation_revision: null,
          ...plannerFields(decision),
        },
      });
    }

    // Do not trust the chatbot action alone.
    if (!isExplicitConfirmation(message)) {
      return sendJson(res, 409, {
        error: "EXPLICIT_CONFIRMATION_REQUIRED",
        message: "Please explicitly confirm the booking.",
      });
    }

    // The client must send back the revision from the latest summary.
    if (
      !Number.isSafeInteger(body.confirmation_revision) ||
      body.confirmation_revision < 1
    ) {
      return sendJson(res, 409, {
        error: "CONFIRMATION_REVISION_REQUIRED",
      });
    }

    let booking;

    try {
      booking = await confirmEgyxosBooking({
        userId: user.id,
        conversationId,
        extracted: {
          visit_date: visitDate,
          ticket_count: visitors,
          visitor_name: visitorName,
        },
        expectedRevision: body.confirmation_revision,
      });
    } catch (error) {
      console.error("Booking confirmation failed:", error.message);

      return sendJson(res, error.status || 500, {
        error:
          error.status === 409
            ? error.message
            : "BOOKING_CONFIRMATION_FAILED",
      });
    }

    planning.forget(user.id, conversationId);

    return sendJson(res, 200, {
      data: {
        reply: confirmedText(booking, botLanguage),
        language: botLanguage,
        extracted: {
          visit_date: booking.visit_date,
          ticket_count: booking.ticket_count,
          visitor_name: booking.visitor_name,
        },
        action: "confirm",
        draft_saved: false,
        // Additive: every booking here is a demo booking.
        demo: true,
        booking: { ...booking, demo: true },
      },
    });
  }

  // ---- Save the draft (and present the revision when complete) ----

  let draftSaved = false;
  let confirmationRevision = null;
  let returnedExtracted = bot.extracted;

  if (bot.save) {
    if (
      (visitDate !== null && checkVisitDate(visitDate) !== "ok") ||
      (visitors !== null && !isValidVisitorCount(visitors))
    ) {
      return sendJson(res, 422, { error: "INVALID_BOOKING_DETAILS" });
    }

    try {
      const draft = await saveBookingDraft({
        userId: user.id,
        conversationId,
        visitDate,
        visitors,
        visitorName,
      });

      draftSaved = true;

      returnedExtracted = {
        visit_date: draft.visit_date,
        ticket_count: draft.visitors,
        visitor_name: draft.visitor_name,
      };

      // Only a COMPLETE draft can be confirmed, so only then is
      // its revision "presented" to the visitor. While a requested plan
      // has not been shown (decision.hold) nothing is presented.
      if (!decision.hold && draft.visit_date && draft.visitors && draft.visitor_name) {
        const { data: presented, error: presentationError } =
          await supabase
            .from("booking_drafts")
            .update({
              presented_revision: draft.revision,
              presented_at: new Date().toISOString(),
            })
            .eq("id", draft.id)
            .eq("user_id", user.id)
            .eq("status", "awaiting_confirmation")
            .eq("revision", draft.revision)
            .select("revision")
            .maybeSingle();

        if (presentationError) {
          throw presentationError;
        }

        if (!presented) {
          return sendJson(res, 409, { error: "BOOKING_DRAFT_CHANGED" });
        }

        confirmationRevision = presented.revision;
      }
    } catch (error) {
      console.error("Booking draft save failed:", error.message);
      return sendJson(res, 500, { error: "BOOKING_DRAFT_SAVE_FAILED" });
    }
  }

  // The plan (if any) comes first, then the booking continues. While a
  // requested plan is unfinished, the planner's question is the reply.
  const replyText = decision.hold
    ? decision.holdReply || bot.reply
    : decision.prefix
      ? `${decision.prefix}\n\n${bot.reply}`
      : bot.reply;

  return sendJson(res, 200, {
    data: {
      reply: replyText,
      language: botLanguage,
      extracted: returnedExtracted,
      action: null,
      draft_saved: draftSaved,
      confirmation_revision: confirmationRevision,
      ...plannerFields(decision),
      ...(bot.newConversationRequired
        ? { new_conversation_required: true }
        : {}),
    },
  });
}

// ---------- POST /api/ai/guide (AI Museum Guide) ----------
//
// A thin, safe proxy to the Python Guide. It reads no database, writes
// nothing and holds no conversation state: Python keeps the (private,
// per-user) conversation. Node only
//   - checks the visitor's login (same rules as every other route),
//   - validates the request,
//   - forwards the visitor's OWN token (never a service key),
//   - returns the Guide's fields, rebuilt by guide-client.js.
// The visitor's message and the Guide's reply are never logged.

const GUIDE_MAX_MESSAGE_CHARS = 500;

async function handleGuide(req, res, user) {
  if (!guideClient.enabled) {
    return sendJson(res, 503, { error: "GUIDE_DISABLED" });
  }

  const body = await readJson(req);

  const message =
    typeof body.message === "string" ? body.message.trim() : null;
  const conversationId = body.conversation_id;

  const idGiven = conversationId !== undefined && conversationId !== null;

  if (
    !message ||
    message.length > GUIDE_MAX_MESSAGE_CHARS ||
    (idGiven &&
      (typeof conversationId !== "string" ||
        !GUIDE_CONVERSATION_ID_RE.test(conversationId)))
  ) {
    return sendJson(res, 400, { error: "INVALID_GUIDE_REQUEST" });
  }

  // The user id is not sent: Python verifies the same token itself.
  const result = await guideClient.chat({
    token: bearerToken(req),
    message,
    conversationId: idGiven ? conversationId : undefined,
  });

  if (result.ok) {
    return sendJson(res, 200, result.data);
  }

  if (result.reason === "timeout") {
    return sendJson(res, 504, { error: "GUIDE_TIMEOUT" });
  }

  if (result.reason === "rejected") {
    const { status, code } = result;

    if (status === 401) {
      return sendJson(res, 401, { error: "UNAUTHORIZED" });
    }

    if (status === 403) {
      return sendJson(res, 403, { error: "GUESTS_NOT_ALLOWED" });
    }

    if (status === 404 && code === "CONVERSATION_NOT_FOUND") {
      return sendJson(res, 404, { error: "CONVERSATION_NOT_FOUND" });
    }

    if (status === 429) {
      if (result.retryAfter) {
        res.setHeader("Retry-After", String(result.retryAfter));
      }

      return sendJson(res, 429, {
        error: code === "DAILY_LIMIT_REACHED" ? "DAILY_LIMIT_REACHED" : "RATE_LIMITED",
      });
    }

    if (status === 400 || status === 422) {
      return sendJson(res, 400, { error: "INVALID_GUIDE_REQUEST" });
    }
  }

  // Python down, misconfigured, slow, or sent something unusable.
  return sendJson(res, 503, { error: "GUIDE_UNAVAILABLE" });
}

// =====================================================
// 8. HTTP SERVER AND START-UP
// =====================================================

const server = http.createServer(async (req, res) => {
  try {
    // ---- CORS: only the configured frontend origin ----

    const origin = req.headers.origin;

    if (origin) {
      if (origin !== FRONTEND_ORIGIN) {
        return sendJson(res, 403, { error: "Origin not allowed" });
      }

      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Idempotency-Key"
      );
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const pathname = new URL(req.url, "http://localhost").pathname;

    if (req.method === "GET" && pathname === "/api/health") {
      return handleHealth(res);
    }

    if (req.method === "POST" && pathname === "/api/ai/chat") {
      const user = await authenticate(req);

      if (!user) {
        return sendJson(res, 401, { error: "UNAUTHORIZED" });
      }

      return await handleChat(req, res, user);
    }

    if (req.method === "POST" && pathname === "/api/ai/guide") {
      const user = await authenticate(req);

      if (!user) {
        return sendJson(res, 401, { error: "UNAUTHORIZED" });
      }

      return await handleGuide(req, res, user);
    }

    if (
      pathname === "/api/bookings" &&
      (req.method === "GET" || req.method === "POST")
    ) {
      if (req.method === "POST" && !directBookingEnabled()) {
        return sendJson(res, 403, { error: "DIRECT_BOOKING_DISABLED" });
      }

      const user = await authenticate(req);

      if (!user) {
        return sendJson(res, 401, {
          error: "UNAUTHORIZED",
          message: "Please sign in first.",
        });
      }

      return req.method === "GET"
        ? await handleListBookings(res, user)
        : await handleCreateBooking(req, res, user);
    }

    return sendJson(res, 404, { error: "Route not found" });
  } catch (error) {
    console.error("Backend error:", error.message);

    if (!res.headersSent) {
      return sendJson(res, error.status || 500, {
        error:
          error.status && error.status < 500
            ? error.message
            : "Internal server error",
      });
    }

    res.end();
  }
});

// node server.js --check : confirm Supabase can be reached, then exit.
async function checkSupabase() {
  console.log("Testing Supabase connection...");

  const { count, error } = await supabase
    .from("bookings")
    .select("*", { count: "exact", head: true });

  if (error) {
    console.error("Supabase connection failed:", error.message);
    process.exitCode = 1;
    return;
  }

  console.log("Supabase connected successfully!");
  console.log("Bookings table is accessible.");
  console.log("Total bookings:", count);
}

function start() {
  server.listen(PORT, () => {
    console.log(`GEM Backend running on http://localhost:${PORT}`);
    console.log(`Allowed frontend origin: ${FRONTEND_ORIGIN}`);

    if (process.env.ALLOW_GUEST_USERS === "true") {
      console.warn(
        guestModeAllowed()
          ? "WARNING: Guest Mode is ON (local testing only). Remove ALLOW_GUEST_USERS from .env to turn it off."
          : "Guest Mode is requested but IGNORED (needs NODE_ENV not production and a localhost FRONTEND_ORIGIN)."
      );
    }

    if (plannerConfig.enabled) {
      console.log(`Smart Visit Planner: ON (${plannerConfig.url})`);
    } else if (plannerConfig.requestedButNoUrl) {
      console.warn("PLANNER_ENABLED=true but PLANNER_URL is missing or invalid: the planner stays OFF.");
    }

    if (guideConfig.enabled) {
      console.log(`AI Museum Guide: ON (${guideConfig.url})`);
    } else if (guideConfig.requestedButNoUrl) {
      console.warn("GUIDE_ENABLED=true but GUIDE_URL is missing or invalid: the Guide stays OFF.");
    }

    if (directBookingEnabled()) {
      console.warn(
        "WARNING: POST /api/bookings is ON (ENABLE_DIRECT_BOOKING_API=true). It skips the chat confirmation flow."
      );
    }
  });
}

if (require.main === module) {
  if (CHECK_MODE) {
    checkSupabase().catch((error) => {
      console.error("Connection error:", error.message);
      process.exitCode = 1;
    });
  } else {
    start();
  }
}

// Exported for the automated tests only.
module.exports = { server, start, guestModeAllowed };
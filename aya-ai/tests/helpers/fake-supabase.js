"use strict";

// =====================================================
// In-memory stand-in for the Supabase client and Supabase Auth.
//
// USED ONLY BY AUTOMATED TESTS. It supports exactly the query
// shapes that server.js, booking-drafts.js and confirm-booking.js
// use, and re-implements public.confirm_egyxos_booking from the
// SQL you supplied. Tests that use this file are MOCKED tests:
// they never touch a real Supabase project.
// =====================================================

const crypto = require("node:crypto");
const { cairoToday, addDays } = require("../../backend/chatbot");

function createFakeDb() {
  return {
    tables: {
      booking_drafts: [],
      bookings: [],
      booking_cancellation_requests: [],
      booking_modification_requests: [],
    },
    failNext: null, // { table, op } -> next matching call returns a database error
    tokens: new Map(), // access token -> user id
    guestTokens: new Map(), // access token -> user id of an ANONYMOUS (guest) user
    calls: [], // every call, for assertions
  };
}

const uuid = () => crypto.randomUUID();

// A strictly increasing timestamp, like a real updated_at: two changes in the
// same millisecond still get different values, so a stale snapshot is always
// detectable.
let lastStamp = 0;
function stamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

function reference() {
  return "GEM-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function pick(row, cols) {
  if (!cols || cols === "*") return { ...row };
  const out = {};
  for (const c of cols.split(",").map((x) => x.trim())) out[c] = row[c];
  return out;
}

class Query {
  constructor(db, table) {
    Object.assign(this, { db, table, op: "select", filters: [], cols: "*", returning: false });
  }
  select(cols = "*") { this.cols = cols; if (this.op !== "select") this.returning = true; return this; }
  insert(payload) { this.op = "insert"; this.payload = payload; return this; }
  update(payload) { this.op = "update"; this.payload = payload; return this; }
  upsert(payload, opts = {}) { this.op = "upsert"; this.payload = payload; this.onConflict = opts.onConflict; return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  gt(col, val) { this.filters.push((r) => r[col] > val); return this; }
  order(col, { ascending = true } = {}) { this.orderBy = { col, ascending }; return this; }
  limit(n) { this.limitTo = n; return this; }
  maybeSingle() { this.mode = "maybe"; return this.run(); }
  single() { this.mode = "single"; return this.run(); }
  then(resolve, reject) { return this.run().then(resolve, reject); }

  async run() {
    await new Promise((r) => setImmediate(r)); // behave like real I/O
    const { db, table } = this;
    db.calls.push({ table, op: this.op });

    if (db.failNext && db.failNext.table === table && db.failNext.op === this.op) {
      db.failNext = null;
      return { data: null, error: { message: "simulated database failure", code: "XX000" } };
    }

    const rows = db.tables[table];
    const match = () => rows.filter((r) => this.filters.every((f) => f(r)));
    let result;

    if (this.op === "select") {
      result = match();
      if (this.orderBy) {
        const { col, ascending } = this.orderBy;
        result.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1));
      }
    } else if (this.op === "update") {
      result = match();
      for (const r of result) Object.assign(r, this.payload);
    } else if (this.op === "upsert") {
      if (table === "booking_modification_requests" && !(this.payload.proposed_visitors >= 1 && this.payload.proposed_visitors <= 10)) {
        return { data: null, error: { message: "violates check constraint booking_modification_requests_proposed_visitors_check", code: "23514" } };
      }
      const keys = (this.onConflict || "").split(",").map((k) => k.trim());
      let row = rows.find((r) => keys.every((k) => r[k] === this.payload[k]));
      if (row) Object.assign(row, this.payload);
      else {
        row = {
          id: uuid(), created_at: new Date().toISOString(),
          presented_revision: null, presented_at: null, ...this.payload,
        };
        rows.push(row);
      }
      result = [row];
    } else if (this.op === "insert") {
      const payload = this.payload;
      if (payload.idempotency_key && rows.some((r) => r.user_id === payload.user_id && r.idempotency_key === payload.idempotency_key)) {
        return { data: null, error: { message: "duplicate key", code: "23505" } };
      }
      const created = stamp();
      const row = { id: uuid(), booking_reference: reference(), created_at: created, updated_at: created, ...payload };
      rows.push(row);
      result = [row];
    }

    if ((this.op === "insert" || this.op === "update" || this.op === "upsert") && !this.returning) {
      return { data: null, error: null };
    }
    if (this.limitTo !== undefined) result = result.slice(0, this.limitTo);
    const projected = result.map((r) => pick(r, this.cols));
    if (this.mode === "maybe") return { data: projected[0] ?? null, error: null };
    if (this.mode === "single") {
      return projected.length === 1
        ? { data: projected[0], error: null }
        : { data: null, error: { message: "single row expected", code: "PGRST116" } };
    }
    return { data: projected, error: null };
  }
}

function createFakeSupabase(db) {
  return {
    from: (table) => new Query(db, table),

    // Port of public.confirm_egyxos_booking (the SQL you pasted).
    async rpc(name, args) {
      await new Promise((r) => setImmediate(r));
      db.calls.push({ table: "rpc", op: name });
      const fail = (message) => ({ data: null, error: { message } });
      if (db.failNext && db.failNext.table === "rpc" && db.failNext.op === name) {
        db.failNext = null;
        return fail("simulated database failure");
      }

      // Port of public.cancel_egyxos_booking (cancel_booking.sql). It runs
      // synchronously after the first await, so like the SQL function it is
      // atomic: two simultaneous calls cannot both change the booking.
      if (name === "cancel_egyxos_booking") {
        const { p_user_id: userId, p_conversation_id: convId } = args;
        const request = db.tables.booking_cancellation_requests.find((r) => r.user_id === userId && r.conversation_id === convId);
        if (!request || request.status !== "pending") return fail("CANCELLATION_NOT_REQUESTED");
        if (new Date(request.expires_at) <= new Date()) return fail("CANCELLATION_EXPIRED");

        const result = (b, replayed) => ({
          data: {
            id: b.id, booking_reference: b.booking_reference, visitor_name: b.visitor_name,
            visit_date: b.visit_date, ticket_count: b.visitors, status: b.status,
            created_at: b.created_at, replayed,
          },
          error: null,
        });

        const booking = db.tables.bookings.find((b) => b.id === request.booking_id && b.user_id === userId);
        if (!booking) return fail("BOOKING_NOT_FOUND");
        if (booking.status === "confirmed" && booking.visit_date >= cairoToday()) {
          booking.status = "cancelled";
          booking.updated_at = stamp();
          request.status = "used";
          return result(booking, false);
        }
        if (booking.status === "cancelled") {
          request.status = "used";
          return result(booking, true);
        }
        return fail("BOOKING_NOT_CANCELLABLE");
      }

      // Port of public.modify_egyxos_booking (modify_booking.sql). Same checks in
      // the same order. It runs synchronously after the first await, so like the
      // SQL function (row locks) two simultaneous calls cannot both apply.
      if (name === "modify_egyxos_booking") {
        const { p_user_id: userId, p_conversation_id: convId } = args;
        const request = db.tables.booking_modification_requests.find((r) => r.user_id === userId && r.conversation_id === convId);
        if (!request || request.status !== "pending") return fail("MODIFICATION_NOT_REQUESTED");
        if (new Date(request.expires_at) <= new Date()) return fail("MODIFICATION_EXPIRED");

        const booking = db.tables.bookings.find((b) => b.id === request.booking_id && b.user_id === userId);
        if (!booking) return fail("BOOKING_NOT_FOUND");
        const today = cairoToday();
        if (booking.status !== "confirmed" || booking.visit_date < today) return fail("BOOKING_NOT_MODIFIABLE");

        if (
          booking.updated_at !== request.base_updated_at ||
          booking.visit_date !== request.base_visit_date ||
          booking.visitors !== request.base_visitors ||
          (booking.visitor_name ?? null) !== (request.base_visitor_name ?? null)
        ) return fail("BOOKING_CHANGED");

        if (!(request.proposed_visitors >= 1 && request.proposed_visitors <= 10)) return fail("INVALID_VISITOR_COUNT");
        if (request.proposed_visit_date < today || request.proposed_visit_date > addDays(today, 365)) return fail("INVALID_VISIT_DATE");
        const trimmed = typeof request.proposed_visitor_name === "string" ? request.proposed_visitor_name.trim() : "";
        const newName = trimmed === "" ? null : trimmed;
        if (newName !== null && (newName.length < 2 || newName.length > 100)) return fail("INVALID_VISITOR_NAME");

        booking.visit_date = request.proposed_visit_date;
        booking.visitors = request.proposed_visitors;
        booking.visitor_name = newName;
        booking.updated_at = stamp();
        request.status = "used";
        return {
          data: {
            id: booking.id, booking_reference: booking.booking_reference, visitor_name: booking.visitor_name,
            visit_date: booking.visit_date, ticket_count: booking.visitors, status: booking.status,
            created_at: booking.created_at,
          },
          error: null,
        };
      }

      if (name !== "confirm_egyxos_booking") return fail("function not found");

      const { p_user_id: userId, p_conversation_id: convId, p_expected_revision: rev } = args;
      if (!userId || !convId || rev === null || rev === undefined) return fail("INVALID_CONFIRMATION_REQUEST");

      const draft = db.tables.booking_drafts.find((d) => d.user_id === userId && d.conversation_id === convId);
      if (!draft) return fail("BOOKING_DRAFT_NOT_FOUND");

      let booking = db.tables.bookings.find((b) => b.draft_id === draft.id);
      let replayed = false;

      if (booking) replayed = true;
      else {
        if (draft.status !== "awaiting_confirmation" || new Date(draft.expires_at) <= new Date()) return fail("BOOKING_DRAFT_NOT_ACTIVE");
        if (draft.revision !== rev) return fail("BOOKING_DRAFT_CHANGED");
        if (!draft.visitor_name || draft.visitor_name.trim().length < 2 || draft.visitor_name.trim().length > 100) return fail("VISITOR_NAME_REQUIRED");
        if (draft.visitors == null || draft.visitors < 1 || draft.visitors > 10) return fail("INVALID_VISITOR_COUNT");
        const today = cairoToday();
        if (draft.visit_date == null || draft.visit_date < today || draft.visit_date > addDays(today, 365)) return fail("INVALID_VISIT_DATE");

        booking = {
          id: uuid(), user_id: userId, draft_id: draft.id, visitor_name: draft.visitor_name,
          visit_date: draft.visit_date, visitors: draft.visitors, status: "confirmed",
          idempotency_key: "egyxos:" + draft.id, booking_reference: reference(),
          created_at: stamp(), updated_at: stamp(),
        };
        db.tables.bookings.push(booking);
        draft.status = "completed";
      }
      return {
        data: {
          id: booking.id, booking_reference: booking.booking_reference,
          visitor_name: booking.visitor_name, visit_date: booking.visit_date,
          ticket_count: booking.visitors, status: booking.status, replayed,
        },
        error: null,
      };
    },
  };
}

function createFakeAuth(db) {
  return {
    auth: {
      async getUser(token) {
        const id = db.tokens.get(token);
        if (id) return { data: { user: { id, is_anonymous: false } }, error: null };
        const guest = db.guestTokens.get(token);
        if (guest) return { data: { user: { id: guest, is_anonymous: true } }, error: null };
        return { data: { user: null }, error: { message: "invalid JWT" } };
      },
    },
  };
}

/**
 * Replace @supabase/supabase-js createClient BEFORE server.js is loaded.
 * server.js creates two clients: one with the secret key (database) and
 * one with the publishable key (token checks). The fake returns the
 * matching stand-in for each. Nothing here reaches a real Supabase project.
 */
function installSupabaseMock(db, backendDir) {
  // the SDK is installed in backend/node_modules, so resolve it from there
  const sdk = require(require.resolve("@supabase/supabase-js", { paths: [backendDir] }));
  const database = createFakeSupabase(db);
  const auth = createFakeAuth(db);
  const original = sdk.createClient;
  sdk.createClient = (url, key) => (String(key).includes("publishable") ? auth : database);
  return () => { sdk.createClient = original; };
}

module.exports = { createFakeDb, createFakeSupabase, createFakeAuth, installSupabaseMock };
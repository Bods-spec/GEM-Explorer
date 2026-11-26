# Phase B: Booking Agent + Smart Visit Planner (Node.js side)

One visitor-facing agent: the **AI Booking Agent**. Planning is an internal tool
(`POST /planner/turn` on the Python service). There is no third agent.

## What changed (and what did not)

| File | Change |
|---|---|
| `chatbot/router.js` | NEW. Pure functions: planning vs booking vs both; removes durations ("90 minutes", "ساعتين") before the booking parser sees them. |
| `planner-client.js` | NEW. Calls Python `/planner/turn` with the visitor's own token, one attempt, timeout, no retries, never logs token/message. |
| `planning-flow.js` | NEW. Decides each turn; keeps a small bounded, user-scoped **in-memory** flow state. |
| `server.js` | Small hooks only (see below). Booking code, revisions, atomic RPC: untouched. |
| `chatbot/responses.js` | Demo notice line added to the booking review (English + Egyptian Arabic). |
| tests | `router.test.js`, `planning.test.js`, `planning-flow.test.js`, `helpers/fake-planner.js`, harness option, 3 regression tests in `server.test.js`. |
| `smoke-test-planning.js` | NEW. Real valid-JWT test across Node + Python (planning-only, writes nothing). |

Not touched: SQL, Supabase data, knowledge notes, frontend, Login/Register, `booking-drafts.js`, `confirm-booking.js`, the engine and parser.

## Feature flag (OFF by default)

Add to `backend\.env` only when you want planning on:

```
PLANNER_ENABLED=true
PLANNER_URL=http://127.0.0.1:8000
PLANNER_TIMEOUT_MS=15000
```

Without `PLANNER_ENABLED=true` AND a valid `PLANNER_URL`, no planner code runs and
no request is ever sent: the Booking Agent behaves exactly as before
(except the two additive demo changes below).

## How a message is handled

1. Authenticate (unchanged). Read the stored draft (unchanged).
2. **Planning step (before the booking parser):**
   - cancel / confirm words -> booking engine, always.
   - a duration, plan word ("plan", "خطة", "itinerary"...), or a plan edit after a plan was shown ("remove the gold gallery") -> planner.
   - planning words + booking words ("book", "احجز", "tickets") -> **both**: planner gets `booking_handled=true`; the booking engine gets the message with the duration removed, so "2 hours" can never become 2 (or 120) visitors.
   - otherwise -> booking engine only (no planner call).
3. The reply is **plan first, then the booking continues** (next question or booking summary).
4. If the planner asks a question, the booking details are saved but the booking summary is **not** presented until the plan is shown. "yes" cannot confirm anything in that state.
5. Planner down / slow / refuses the token / bad answer: the visitor is told, booking details are kept, and asked: "continue with the booking only, or try the plan again?" "yes", "booking only", "بدون خطة" continue the booking; a new planning message retries. A plan request is never silently dropped.

## Additive response fields (existing clients keep working)

- `planner_status`, `plan` (structured plan, only when one was made), `plan_pending: true` (a requested plan is unfinished).
- Booking summary text now includes: *This is a demo booking, not an official museum ticket.* / *ده حجز تجريبي مش تذكرة رسمية للمتحف.*
- Confirmed response: `demo: true` and `booking.demo: true`. All other fields unchanged.

## Memory (important)

The planning flow state lives **in Node.js memory only**: lost when Node restarts.
Key = authenticated user id + conversation id (one visitor can never touch another's).
Sliding TTL 24 h (same as a booking draft), at most 20 flows per user, 2000 overall.
It stores only 4 small fields (no token, no message). The Python plan memory is also
lost when Python restarts (30 min TTL). A restart never loses a *booking* (those are in the database).
After a Node restart, a visitor mid-plan would simply be asked again.

## Windows commands

Node tests (mocked; no network, no Supabase):

```powershell
cd "D:\University\Level 4\Web\Project\backend"
node --test test/*.test.js
```

Expected: `# tests 110`, `# pass 110`, `# fail 0`.

Python tests (unchanged count):

```powershell
cd "D:\University\Level 4\Web\Project\ai_service"
.\.venv\Scripts\Activate.ps1
python -m pytest -q
```

Expected: `469 passed`.

Real cross-service JWT test (needs both services; writes nothing to your database):

```powershell
# Window 1: Python
cd "D:\University\Level 4\Web\Project\ai_service"
.\.venv\Scripts\Activate.ps1
python -m uvicorn app.main:app --port 8000

# Window 2: Node (planner ON for this window only)
cd "D:\University\Level 4\Web\Project\backend"
$env:PLANNER_ENABLED = "true"
$env:PLANNER_URL = "http://127.0.0.1:8000"
node server.js

# Window 3: the test (paste a valid Supabase access token when asked; it is hidden)
cd "D:\University\Level 4\Web\Project\backend"
node smoke-test-planning.js
```

Report: `backend\smoke_test_planning_report.txt` (contains no token). Nothing in this test creates a draft or booking.
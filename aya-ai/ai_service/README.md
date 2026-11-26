# GEM Explorer AI Service (Python + FastAPI)

Step 1: the service starts and answers `GET /health`.
Step 2: `POST /rag/search` (museum knowledge search, Arabic and English) and the ingestion script, tested **only with fake OpenAI and Supabase servers**.
Step 3: `POST /guide/chat`, the conversational AI Museum Guide (Arabic, Egyptian Arabic, English), tested with a **fake** model first; `smoke_test_guide.py` tests it for real.
Step 4: `POST /planner/chat`, the Smart Visit Planner (a conversational visit plan from the time, interests and must-see items), tested with a **fake** model first; `smoke_test_planner.py` tests it for real.
The guide and the planner never touch the Node booking backend or the frontend: booking requests are only handed over (see below).

## Where it lives

Put this folder next to your existing ones:

```
D:\University\Level 4\Web\Project\
  backend\      (Node booking backend, unchanged)
  frontend\     (unchanged)
  tests\        (Node tests, unchanged)
  ai_service\   <- this folder
```

## Run it on Windows (PowerShell)

You need Python 3.10 or newer. Check with `python --version`.
(If your prompt starts with `(base)` you use Anaconda. That is fine: use `python`, not `py`.)

**Important:** install the packages only *inside* the `.venv` folder, never into Anaconda's `(base)`.
The safety check in step 3 proves you are in the right place before anything is installed.

```powershell
cd "D:\University\Level 4\Web\Project\ai_service"

# 1) one-time: create a private Python environment inside this folder
python -m venv .venv

# 2) activate it (you will see (.venv) at the start of the line)
.\.venv\Scripts\Activate.ps1

# 3) SAFETY CHECK: this must print a path that ends with ...\ai_service\.venv\Scripts\python.exe
(Get-Command python).Source

# 4) one-time: install the packages (only if step 3 was correct)
python -m pip install --upgrade pip
pip install -r requirements-dev.txt

# 5) one-time: create your settings file (the defaults are fine for now)
copy .env.example .env

# 6) start the service
python -m uvicorn app.main:app --reload --port 8000
```

Leave that window open. In your browser open:

- http://localhost:8000/health  -> should show `{"status":"ok", ...}`
- http://localhost:8000/docs    -> automatic API page

Stop the service with **Ctrl + C**. Next time you only need steps 2 and 6.

## Run the tests

In a second PowerShell window:

```powershell
cd "D:\University\Level 4\Web\Project\ai_service"
.\.venv\Scripts\Activate.ps1
python -m pytest
```

Expected: `424 passed` (all with fake servers: no internet, no keys, no cost).

## Step 3: the AI Museum Guide

`POST /guide/chat` (login required, same token as `/rag/search`). Body: `{"message": "...", "conversation_id": "optional"}`.
The answer has `status`, `reply`, `sources` (title + official link), `handoff`, `conversation_id`, `language`, `register`.

What happens to every message:

1. A booking request (book / change / cancel / "where is my booking") is **handed over** (`status: "handoff"`, `target: "booking_system"`). The guide never books anything and makes no model or search call for it.
2. Greetings and thanks get a fixed reply. Questions about other museums are refused.
3. A follow-up ("and what is it made of?") is rewritten into a full question using the conversation.
4. The existing RAG finds notes. A **judge** step must point at a sentence in a note that answers the question; the code checks that the sentence really is in the note.
5. Only approved notes go to the writing step. The code then checks citations, numbers (every number must be in a note), links (only gem.eg or a cited source) and language. If anything fails, the visitor gets a fixed "I could not verify this" reply.
6. If no note answers (restaurant, drone, Great Pyramid...) the visitor gets a fixed "not in my verified sources" reply with the official website. Nothing is invented.

Limits: 6 messages/minute and 100/day per user, 1000/day for the whole service (plus the existing per-IP limit). Messages are at most 500 characters.
Memory: the last 6 turns are kept **in the service's memory** for 30 minutes (lost on restart). Logs hold only counts and statuses, never message text, notes, keys or tokens.

Settings (`.env`): `OPENAI_CHAT_MODEL` has **no default on purpose**: OpenAI retires models, so pick one that is available to your account today (check OpenAI's models and deprecations pages). Without it `/guide/chat` answers `503 GUIDE_NOT_CONFIGURED`.

Real test (read-only, costs a few cents):

```powershell
python smoke_test_guide.py
```

It writes `smoke_test_guide_report.md` with every reply (and a trace line: notes searched, reused, judge verdict), so you can read the wording yourself.

Follow-ups: when a follow-up needed rewriting ("where is it?"), the notes used in earlier **answered** turns of the same conversation are offered to the judge too (at most 3 extra, only notes from the knowledge base with a trusted status and their source link). The judge must still quote the note, so nothing is assumed, and the citation is the note's own source.

**Valid-login check:** run `python smoke_test_guide_targeted.py` (or `smoke_test_guide.py`). It asks `Paste a CURRENT Supabase access token` at a **hidden** prompt: nothing is shown, printed or saved. Press Enter to skip. The token is read from an existing logged-in session (see the steps in the chat), expires after about an hour, and is only sent to your local service.

**Known, documented, non-blocking limitations (MVP):**
- Cross-language retrieval (an Arabic question finding only the English note, or the reverse) is 4/12. Same-language retrieval works. Improving it is a separate follow-up.
- For two Arabic ticket questions (A8, G6) the right note is 2nd in the RAG ranking. The guide reads 5 notes and its judge picks the right one. `smoke_test_rag.py` reports these as `KNOWN LIMITATION`, not as failures.
- The guide checks quotes, citations, numbers, links and language in code, but cannot check an invented *name* or word by code; the judge/answer instructions and the real smoke test cover that.

## Step 4: the Smart Visit Planner

`POST /planner/chat` (login required, same token as the guide). Body: `{"message": "...", "conversation_id": "optional"}`. Send the `conversation_id` of the previous answer to change the **same** plan ("Make it 90 minutes and remove the Grand Stairs").

The answer is JSON: `status`, `conversation_id`, `reply` (readable text), `time_budget_minutes`, `preferences` (time, pace, interests, must-see, removed), `plan`, `unmatched_requests`, `assumptions`, `limitations`, `handoff`, `language`, `register`.
`plan` holds `stops` (`order`, `key`, `name`, `minutes`, `priority`, `because`, `summary`, `highlights`, `sources`, `verification_status`), `not_included`, `issues`, `transition_minutes_each`, `transitions_total`, `rest_buffer_minutes`, `total_estimated_minutes`, `free_minutes`.

`status` is one of: `plan_created`, `plan_updated`, `needs_clarification` (`clarification`: `ask_time` or `time_conflict`), `not_possible`, `handoff`, `out_of_scope` (another museum), `not_planning` (a question for the Guide), `smalltalk`, `unavailable`.

How a plan is made (the model never writes a stop, a number or a sentence the visitor sees):

1. A booking request is **handed over** (`status: "handoff"`, `target: "booking_system"`), with no model call. The planner cannot create, change or cancel a booking.
2. ONE model call only reads the message: time, pace, interests, must-see places. Its answer must fit a strict schema whose choices are the real places and tags from the database, and the code drops anything else (unknown keys, a time the message never mentions, wording not in the message).
3. Plain code builds the plan from the Supabase tables `museum_entities` and `museum_sources` (read-only): must-see places first, then places matching the interests, then optional fillers. Each stop uses the team's estimated minutes (scaled by pace) and only stops that fit inside the time are included. A small flat buffer is added between stops (and a rest buffer for visits of 2.5 hours or more).
4. The text is fixed English / Standard Arabic / Egyptian Arabic wording, so it cannot invent facts. Every stop shows 1-2 verified source links.

If the must-see places cannot fit, the planner says so and how many minutes they need; it does not quietly build a different plan. The same holds when the only must-see place has no verified time estimate (Khufu's Boats Museum): the planner says so and offers "plan without it". An Egyptian-Arabic visitor keeps Egyptian Arabic in short follow-ups.

The planner is a **tool of the Egyxos Booking Agent**, not a separate chatbot for visitors: see `INTEGRATION_PLAN.md`. `/planner/chat` is the development and test endpoint.

Limits: 10 messages/minute and 200/day per user, 1000/day for the whole service (own counters, separate from the Guide), plus the existing per-IP limit. Messages are at most 500 characters. Conversation memory holds only the preferences (no visitor text), in the service's memory for 30 minutes (lost on restart). The place list is cached for 10 minutes.

Real test (read-only, no embeddings, costs a fraction of a cent):

```powershell
python smoke_test_planner.py
```

It writes `smoke_test_planner_report.md` with every reply, what the model understood, and the stops with their sources. It asks for a token at a **hidden** prompt for the valid-login check (press Enter to skip).

**Known limitations (MVP):**
- Only 5 areas have a team-estimated time, so a plan can only schedule those (Grand Hall, Grand Stairs, Hanging Obelisk, Main Galleries, Tutankhamun Galleries). Khufu's Boats Museum is named but never scheduled.
- Minutes are **team estimates**, not official timings. There is no map, so no walking distances, floors, room numbers or "optimised routes" are ever stated. The order is the museum's own group-tour order.
- On short general visits (no interests given) the later areas of the tour order may be left out; the reply asks for interests so they can be prioritised.
- Artefacts appear as highlights inside their area (at most 3); they get no separate time.
- Understanding unusual wording depends on the real model: read the "model understood" lines in the smoke report.
- No frontend or booking integration yet; the handoff is a structured answer only.

## Check the knowledge files (dry run, no network)

```powershell
python -m app.ingest
```

This only validates the dataset and prints what *would* be uploaded. It does not need keys.
The real upload is `python -m app.ingest --apply`. **Do not run it yet**: it needs the approved SQL, your keys, and your go-ahead.

## If something goes wrong

- **"running scripts is disabled"** when activating: run
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`
  then activate again (this only affects that one window).
- **Activation still fails:** skip it and use the environment's Python directly:
  `.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000`
- **"address already in use":** use another port, for example `--port 8001`.
- **`py` is not recognised:** use `python` instead of `py` (as above).

## Folders

| Path | What it is |
|---|---|
| `app/main.py` | The FastAPI application: `/health`, `POST /rag/search`, `/guide/chat`, `/planner/chat` |
| `app/config.py` | Reads settings from `.env` (never prints secrets) |
| `app/clients.py` | Small OpenAI-embeddings and Supabase REST clients |
| `app/rag.py` | Search logic: language, query cleaning, relevance filter, ranking of the notes about what the visitor named |
| `app/domain.py` | Which GEM places/artefacts a question names, and whether it asks about another museum (hand-written lists) |
| `app/security.py` | Login check, guest rule, rate limits, daily cap (RAG and Guide) |
| `app/guide.py` | The guide pipeline: booking handoff, rewrite of follow-ups, evidence judge, answer, code checks |
| `app/guide_prompts.py` | The three model instructions (UNDERSTAND, JUDGE, ANSWER) and how data is fenced off |
| `app/guide_text.py` | Booking-intent rules, greetings, Egyptian-Arabic detection, the fixed replies |
| `app/planner.py` | The planner: booking handoff, one extraction call, checks on what the model returned, merging edits, building the reply |
| `app/planner_core.py` | Pure code that builds the plan (selection, minutes, buffers) from the catalogue |
| `app/catalog.py` | Reads the verified places and sources from Supabase (read-only, cached) |
| `app/planner_prompts.py` | The one model instruction (EXTRACT) and its strict schema |
| `app/planner_text.py` | The fixed English / Arabic / Egyptian wording of plans and questions |
| `app/conversations.py` | Server-side conversation memory (per user, expires, capped) |
| `app/services.py` | Builds the clients once |
| `app/ingest.py` | Knowledge ingestion script (dry run by default) |
| `smoke_test_planner.py` | The REAL test of the planner (real OpenAI chat + Supabase, read-only). `python smoke_test_planner.py` |
| `smoke_test_guide_targeted.py` | A small real test of the Step 3 fixes only (follow-ups, broad questions, tickets, refusals, login). `python smoke_test_guide_targeted.py` |
| `smoke_test_guide.py` | The REAL test of the guide (real OpenAI chat + embeddings + Supabase, read-only). `python smoke_test_guide.py` |
| `smoke_test_rag.py` | The REAL end-to-end test (real OpenAI + Supabase, read-only). Run it yourself: `python smoke_test_rag.py` |
| `tests/` | Automatic tests with fake OpenAI/Supabase (no network needed) |
| `knowledge/` | The prepared museum dataset (JSON) and its review document. Not uploaded anywhere yet |
| `sql/` | The RAG database migration, its rollback, and a read-only verification file. **None of it has been run.** Waits for your approval |
| `.env.example` | Template for your private `.env` (the real `.env` is never shared) |
| `requirements.txt`, `requirements-dev.txt` | Package lists |
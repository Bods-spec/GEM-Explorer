# GEM Explorer AI — Phase 2 plan

**Status:** Foundation only. The backend serves the existing homepage, provides health + sections endpoints, and a database-backed artifacts read API. The AI route is wired but returns HTTP 503 until an API key and verified vector store are configured. No login, payments, bookings, or admin mutations are implemented in this release.

## Technology
- Browser: HTML, CSS, JavaScript
- App API: Node.js 20+, Express 5
- Relational DB: Supabase PostgreSQL via @supabase/supabase-js
- Knowledge-based AI: OpenAI Responses API + File Search vector store (RAG)
- Independent, student-built site; not a GEM official service

## Demo endpoints
- GET /api/health (works without DB or API keys)
- GET /api/db-health (verifies Supabase connection; requires .env and schema)
- GET /api/sections (database-backed section names; requires Supabase)
- GET /api/artifacts (requires Supabase and imported PostgreSQL schema)
- GET /api/artifacts/:id (requires Supabase)
- POST /api/ai/chat {"question":"Who is Ramesses II?"} (requires configured OpenAI key + vector store)

## Four-team plan
- Student 1 (Lead, ~40%): existing homepage, design system, backend foundation, schema, RAG integration, admin, integration/deployment.
- Student 2 (~20%): artifacts pages, detailed cards, filtering, curated source data, read API refinements.
- Student 3 (~20%): login/register/profile using Supabase Auth, JWT authorization, favorites, RLS tests.
- Student 4 (~20%): visit planner, demo bookings and protected endpoints, museum map, tests.

## Critical interface agreement
- JSON APIs: success {data: ...}; failure {error: CODE, message?: text}
- Auth to be finalized before implementation; no plaintext passwords, no unprotected admin routes.
- Bookings never represent official ticket issuance.
- Avoid inventing artifact facts. Every artifact must have reliable source_url and image_credit.
- Git branches: feature/backend-foundation, feature/collections, feature/authentication, feature/visit-planner.

## Priority
1. Working homepage + API health + Git source control.
2. DB schema + real artifacts CRUD (admin only) + curated factual records.
3. Auth + favorites + visit planner + demo bookings.
4. Curated knowledge documents and AI RAG, tested with 20 questions including unanswerable questions.
5. Admin analytics, documentation, deployment, UX testing.
6. Optional: licensed 3D model viewer / custom path suggestions / QR codes (no location or object-identity claims without verified data).

## Cost and security
The OpenAI API requires an account with billing; ChatGPT subscription doesn't automatically pay for API use. Vector store storage and file-search calls can add cost. Keep the API key in backend/.env only (NEVER frontend or GitHub). Rate-limit, constrain prompts, set usage budgets, and test that missing knowledge returns 'I don't know.' Before public deployment add authentication/quota to AI route and a production API host; GitHub Pages cannot run Node.js.

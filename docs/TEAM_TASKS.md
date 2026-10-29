# GEM Explorer AI — Team Tasks (4 contributors)

## Rules and ownership
Each contributor works on a **branch of this same repository**, not a personal ZIP project. Everyone delivers front-end, JavaScript, backend/data integration, smoke tests, and a small README note. Do not edit `main` directly; open a Pull Request. The lead reviews and merges. **Do not modify `database/schema.sql`, `backend/server.js`, or shared global styles without discussing the change with the lead first.**

The source of truth is `docs/API_CONTRACT.md`. Supabase Auth owns passwords; never store or send plaintext passwords. Database changes must be reviewed by the lead. User-facing design must match `frontend/css/style.css` tokens and work in Arabic and English as feasible.

## Lead — project owner (about 40%)
Own: existing homepage, shared design/navigation, Express server, Supabase schema/config, AI Guide (RAG from verified museum sources), admin dashboard and authorized admin CRUD, deployments, reviews and final integration.

**Next milestones:** bootstrap and verify Supabase; publish updated base branch; agree API contract; implement shared auth verification helper; make AI source set and test hallucinations; implement role-protected admin functionality. `frontend/ai.html` is a starter UI only. The AI cannot answer until configured.

## Ameen — Collections & Artifacts (about 20%)
Branch: `feature/ameen-collections`

**Own files:** `frontend/collections.html`, `frontend/artifact.html`, `frontend/css/collections.css`, `frontend/js/collections.js`, `frontend/js/artifact.js`, `docs/ARTIFACT_SOURCES.md` (new). Review edits proposed to existing `backend/routes/artifacts.js` with lead.

**Scope:** responsive collection grid; search, filter by era/section, details view (use `id` in URL or query string), loading/empty/error UI; connect to `GET /api/artifacts` and `GET /api/artifacts/:id`; prepare 20–30 carefully verified records with `title_en`, `title_ar`, `era`, `description_en`, `description_ar`, `section_id`, `image_url`, `image_credit`, `source_url`. Request lead to insert/publish verified data via a controlled seed/admin path.

**Definition of done:** can open 20+ published records, search both languages, filter and see a real details page; responsive; records include citations and image credits; basic manual test documented. Do not invent artifacts or image permissions.

## Hend — Accounts & Favorites (about 20%)
Branch: `feature/hend-auth`

**Own files:** `frontend/login.html`, `frontend/register.html`, `frontend/profile.html`, `frontend/css/auth.css`, `frontend/js/auth.js`, `frontend/js/profile.js`, `backend/routes/profile.js` (new, agree auth routes with lead).

**Scope:** Supabase Auth signup/login/logout with the **publishable** key on frontend (no server secrets); form validation and friendly errors; profile read; favorites add/list/remove using protected access; agree JWT verification with lead; if any protected endpoint uses secret-backed server DB client, explicitly check user JWT and user ID for each request. Profile editing needs a reviewed RLS/schema change (currently read-only).

**Definition of done:** test user can sign up, sign in/out, see own profile, favorite and unfavorite a published artifact; unauthenticated requests denied; users cannot read another user's favorites. Never implement your own password table or allow role=admin from signup.

## Aya — Visit Planner & Demo Bookings (about 20%)
Branch: `feature/aya-visit-planner`

**Own files:** `frontend/visit.html`, `frontend/planner.html`, `frontend/css/visit.css`, `frontend/js/visit.js`, `frontend/js/planner.js`, `backend/routes/bookings.js` (new).

**Scope:** select date, 1–10 persons, plan visit by interests and available hours using verified museum section data; create educational **demo** booking only for logged-in users; show own booking history and loading/error/empty states; coordinate JWT authorization with Hend and lead. Never claim the booking is an official GEM ticket or take payment.

**Definition of done:** chosen plan displays correctly; valid date/quantity checks; authenticated booking persists to `bookings`, history shows only own records, invalid/anonymous booking rejected. Avoid unverified travel time, exact museum routes, prices or opening hours.

## Team handoff
1. Build UI with clear test data and no keys while lead configures Supabase.
2. Read `docs/API_CONTRACT.md` before connecting endpoints.
3. Commit little and often to your own branch, then `Push origin` and create a PR.
4. PR description: changed files, screenshots, test steps, dependencies and anything not yet working.
5. Lead reviews/merges; everyone pulls newest `main` before beginning the next feature.

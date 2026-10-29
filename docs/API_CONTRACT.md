# GEM Explorer AI — Shared API and Database Contract

## Current (already implemented in v0.3)
- `GET /api/health` -> `{ "status": "ok", ... }` (Express)
- `GET /api/db-health` -> `{ "status": "connected", "provider": "supabase" }` when configured
- `GET /api/sections` -> `{ "data": [{ "id":1,"slug":"...","title_en":"...","title_ar":"...","source_url":"..." }] }`
- `GET /api/artifacts?page=1&limit=20&q=ramesses` -> `{ "data": [...], "page":1,"limit":20 }`; only published artifacts; search supported by title (`q`); filters by `era` and `section` are **not yet implemented**; teammate should propose contract addition before coding.
- `GET /api/artifacts/:id` -> `{ "data": { ... } }`; unknown id -> HTTP 404 `{ "error": "ARTIFACT_NOT_FOUND" }`
- `POST /api/ai/chat` with `{ "question": "..." }` -> `{ "answer": "...", "sources": [...] }` when configured; otherwise HTTP 503 `{ "error": "AI_NOT_CONFIGURED", ... }`

## Planned endpoints (not implemented yet; agree exact inputs before building)
- Supabase Auth SDK: register / login / logout; frontend uses publishable key only.
- `GET /api/auth/me` -> current user's profile (optional; may be handled by Supabase SDK + RLS instead).
- `GET /api/favorites/me`, `POST /api/favorites` body `{ "artifact_id": 1 }`, `DELETE /api/favorites/:artifactId`.
- `POST /api/bookings` body `{ "visit_date": "YYYY-MM-DD", "ticket_count": 2 }` -> created demo booking for authenticated user.
- `GET /api/bookings/me` -> `{ "data": [...] }` only for current user.
- `POST /api/admin/artifacts`, `PATCH /api/admin/artifacts/:id`, `DELETE /api/admin/artifacts/:id` -> **lead only**, requires explicit admin authorization.

## Access rules (mandatory)
- `Authorization: Bearer <access_token>` on user-specific Express API calls. Backend **verifies the JWT** using Supabase Auth and derives user_id from verified identity; never trust user_id from request body/query.
- `SUPABASE_SECRET_KEY` lives exclusively in `backend/.env`; its server client bypasses RLS, so every write needs robust server-side auth checks and explicit role checks for admin routes.
- Supabase publishable key may be used by browser SDK, but tables must have correct RLS and grants. Users must never self-edit their role.
- Supabase Auth (`auth.users`) stores credentials; `public.profiles` stores public app metadata, role (`visitor/admin`) and name. Never store custom password hashes.

## DB tables currently defined in `database/schema.sql`
- `profiles(id uuid, full_name text, role visitor/admin, created_at)`
- `museum_sections(id bigint, slug, title_en, title_ar, source_url, created_at)`
- `artifacts(id bigint, section_id bigint?, title_en/ar, era?, description_en/ar?, image_url?, image_credit?, source_url?, is_published boolean, created_at)`
- `favorites(user_id uuid, artifact_id bigint, created_at)` unique pair
- `bookings(id uuid, user_id uuid, visit_date date, ticket_count integer 1–10, status demo_pending/demo_cancelled, created_at)`

## Consistency rules
- Success API body: `{ "data": ... }` (except health/AI endpoints); error: `{ "error": "CODE", "message": "..." }`.
- Use `fetch('/api/...')` against **local Node/Express** during integration, not the static GitHub Pages site. GitHub Pages does **not** host the API.
- For `artifacts` data, always provide reliable `source_url` and attribution/license for images. Only approved, published entries should appear in public queries.
- Any new endpoint/table/field must be proposed to the lead and recorded here before merging.

# GEM Explorer — Supabase Migration Contracts

Database: Supabase PostgreSQL, SQL in `database/schema.sql`.
Server: Express, `@supabase/supabase-js` with `SUPABASE_URL` and server-only `SUPABASE_SECRET_KEY`.

## Read endpoints (implemented)
- `GET /api/health` -> Express status, works without DB.
- `GET /api/db-health` -> requires Supabase, returns `{ "status": "connected", "provider": "supabase" }`.
- `GET /api/sections` -> `{ "data": [{"id":1,"slug":"grand-hall","title_en":"Grand Hall", ...}] }`.
- `GET /api/artifacts?page=1&limit=20&q=ramesses` -> `{ "data": [], "page":1, "limit":20 }` if no records.
- `GET /api/artifacts/:id` -> `{ "data": { ... } }` or 404.
- `POST /api/ai/chat` -> existing AI route; separate OpenAI integration.

## Storage contracts for next features (NOT implemented yet)
- `auth.users`: managed by Supabase Auth. No passwords in public database.
- `public.profiles`: `id uuid (auth.users.id)`, `full_name`, `role ('visitor'|'admin')`.
- `public.favorites`: composite `(user_id uuid, artifact_id bigint)`.
- `public.bookings`: `(id uuid, user_id uuid, visit_date date, ticket_count integer 1..10, status)` demo-only.
- `public.artifacts`: `id bigint`, `title_en`, `title_ar`, `section_id`, `era`, `description_*`, `image_url`, `image_credit`, `source_url`, `is_published`.
- `public.museum_sections`: `id bigint`, `slug`, `title_en`, `title_ar`, `source_url`.

Browser publishable key + user JWT respects RLS. Secret backend key bypasses RLS; never expose it, and never implement unprotected writes. Admin elevation must be performed by a trusted administrator, not profile self-edit.

## Common errors
- `DATABASE_NOT_CONFIGURED`: fill in `backend/.env`, restart Node.
- `DATABASE_CONNECTION_FAILED`: inspect URL/key, SQL editor ran successfully, grants, and network.
- `DATABASE_QUERY_FAILED`: tables may not exist or SQL permissions need fixing; see Node terminal logs.
- Homepage works but AI says setup needed: Supabase is separate from OpenAI vector store and key.

# GEM Explorer AI — Phase 2 Supabase Starter (for Student 1)

This is the original Phase 2 website migrated from **MySQL to Supabase PostgreSQL**. No redesign: the existing Homepage, AI Guide and animations are preserved. AI still needs OpenAI configuration and verified source files. Auth, booking write APIs and the admin dashboard are next-stage work (not falsely advertised as complete).

## 1. Create Supabase project
1. Go to https://supabase.com/dashboard -> New Project -> name `gem-explorer-ai` -> choose region and a new strong **database password** (save it privately). Free plan is sufficient for initial prototyping, subject to quotas.
2. Select your project -> **SQL Editor** -> New query.
3. Open `database/schema.sql` with VS Code; copy and run all SQL inside the Supabase SQL Editor. You do **not** run it in MySQL Workbench.
4. Check **Table Editor** -> `profiles`, `museum_sections`, `artifacts`, `favorites`, `bookings`. `museum_sections` has 5 reference entries; `artifacts` is intentionally empty. `auth.users` is used for actual login accounts, not a home-built password table.
5. Run: `select title_en from public.museum_sections order by id;` to confirm seeded sections.

## 2. Find connection details
1. Dashboard -> **Project Settings > API Keys** (or **Connect** for URL).
2. Copy **Project URL** (`https://...supabase.co`) and the **server-only secret key** (`sb_secret_...`). Do not use the database password and do not paste the key in ChatGPT or GitHub.
3. Only the Node.js server reads this secret. Frontend never includes it. New Supabase publishable keys (`sb_publishable_...`) will be used by the Auth teammate later, with RLS policies enabled.

## 3. Run on Windows + VS Code
Open the inner `GEM-Explorer` folder in VS Code (File -> Open Folder); then in the Terminal:
```powershell
cd backend
npm.cmd install
Copy-Item .env.example .env
```
If `.env` already exists, **edit it, do not overwrite it**. In `backend/.env` replace the placeholders:
```dotenv
PORT=3000
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SECRET_KEY=sb_secret_YOUR_SECRET_KEY
OPENAI_API_KEY=
OPENAI_VECTOR_STORE_ID=
OPENAI_MODEL=gpt-4.1-mini
```
Then run:
```powershell
npm.cmd run dev
```
Go to:
- http://localhost:3000/api/health -> `status: ok` (checks Express)
- http://localhost:3000/api/db-health -> `status: connected`, `provider: supabase` (checks DB)
- http://localhost:3000/api/sections -> 5 museum sections (DB response)
- http://localhost:3000/api/artifacts -> `data: []` until real artifact records are added
- http://localhost:3000/ -> existing Homepage
- http://localhost:3000/ai.html -> existing AI UI (requires separate OpenAI setup)

If Node says `npm` not recognized, install Node.js LTS and restart VS Code. If the terminal is already in `...\GEM-Explorer\backend`, DO NOT type `cd backend` again.

## 4. Important collaboration and safety
- `database/schema.sql` is PostgreSQL SQL; it replaces the prior MySQL schema. Never submit old `DB_HOST`/`DB_PASSWORD` fields expecting them to work.
- `public.profiles.id` is a UUID linked to `auth.users.id`; do not create your own password hashes table. Student 3 should use Supabase Auth; no self-service `admin` role changes.
- Public museum info is read-only; favorites and demo bookings are protected by RLS. All admin routes need authentication AND explicit role checks because a secret key bypasses RLS.
- `.env` must never be committed or shared. If leaked, rotate the secret key in Supabase.
- GitHub Pages serves only static files. It cannot execute Express routes. A deployed Node.js backend will be required for real database/AI functionality.
- `OPENAI_API_KEY` and `OPENAI_VECTOR_STORE_ID` are **separate** from Supabase; AI chat will still report setup needed until both are configured.

## 5. Work distribution
- Student 1: Express server, Supabase migration, shared UI, admin API (after auth), integration.
- Student 2: Collection UI, public artifact queries, verified source content.
- Student 3: Supabase Auth (signup/signin), profiles and favorites with user JWT/RLS.
- Student 4: Demo bookings and visit planner with logged-in user.

Official references: https://supabase.com/docs/guides/getting-started/api-keys ; https://supabase.com/docs/guides/database/postgres/row-level-security ; https://supabase.com/docs/guides/auth/managing-user-data

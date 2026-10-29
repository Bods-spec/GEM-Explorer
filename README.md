# GEM Explorer AI — Team-Ready Phase 2 (v0.3.1)

**University Web Design project · 4 students · independent educational museum platform**

The existing immersive GEM-inspired homepage and AI chat UI are included, as well as a Node.js/Express backend foundation and a **Supabase PostgreSQL** database schema. **AI responses, authentication, booking write APIs, and the admin dashboard are not yet complete.** GitHub Pages serves static frontend only; run the Node server for APIs.

## Start here
- **Team assignments**: [`docs/TEAM_TASKS.md`](docs/TEAM_TASKS.md)
- **GitHub branches / collaboration**: [`docs/GITHUB_TEAM_WORKFLOW.md`](docs/GITHUB_TEAM_WORKFLOW.md)
- **API and database contract**: [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md)
- **Supabase setup**: [`README-PHASE2-START-HERE.md`](README-PHASE2-START-HERE.md)
- **Phase 2 roadmap**: [`docs/PHASE2_ROADMAP.md`](docs/PHASE2_ROADMAP.md)
- **Image source/credit information**: [`IMAGE_CREDITS.md`](IMAGE_CREDITS.md)

## Run locally
Install Node.js (20+). In VS Code, open the **inner `GEM-Explorer` folder**, then:

```powershell
cd backend
npm.cmd install
Copy-Item .env.example .env
# Edit backend/.env with Supabase URL and SERVER-ONLY secret key, privately
npm.cmd run dev
```

If `.env` already exists, edit it instead of copying over it.

- Homepage: http://localhost:3000/
- AI chat UI: http://localhost:3000/ai.html
- Express health: http://localhost:3000/api/health
- Supabase health: http://localhost:3000/api/db-health (requires Supabase configuration/schema)
- Museum sections: http://localhost:3000/api/sections (requires Supabase configuration/schema)
- Public artifact list: http://localhost:3000/api/artifacts (initially empty)

**Never commit `.env`, tokens, paid model API keys, or `node_modules`.** `backend/.env.example` contains placeholders only. The Supabase **publishable** key can be used in browser-side Auth with proper RLS; the secret key must stay server-side.

## GitHub Pages
Published static URL: `https://bods-spec.github.io/GEM-Explorer/frontend/`. Pages cannot host the Node server or dynamic APIs, so the AI chat will show setup errors there until a separate backend is deployed and the frontend is configured to call it.

## Current status
- ✅ Static homepage and responsive visual design
- ✅ Express API foundation + static site server
- ✅ AI Guide UI + guarded placeholder API route
- ✅ Supabase migration code and PostgreSQL schema (actual DB connection needs setup)
- ⏳ Curated museum artifacts, users and favorites, visit planner, demo booking endpoints, verified RAG knowledge store, admin UI and full integration

Museum content is for education and is not an official GEM website. Bookings are simulations only; never claim official tickets or process payments.

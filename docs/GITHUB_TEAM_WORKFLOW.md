# GitHub collaboration guide (recommended: GitHub Desktop)

## One-time setup (lead)
1. In personal repository `Bods-spec/GEM-Explorer`, open Settings -> Collaborators -> Add people. Invite Ameen, Hend, Aya by exact GitHub username and wait for acceptance.
2. Publish **phase 2** to the existing repo. In GitHub Desktop, clone the **existing** repository, create `chore/phase2-team-bootstrap` from `main`, then copy the contents of the `GEM-Explorer` folder from this release over the local *cloned repository* directory (do NOT overwrite or delete its `.git` directory). Commit, Publish/Push, create a PR and merge to `main`.
3. Do not upload the outer ZIP or the directory containing the inner `GEM-Explorer`. The GitHub repo root must contain `frontend/`, `backend/`, `database/`, `docs/`.
4. Check that `.env` and `node_modules` are excluded (`.gitignore`). **Never share Supabase secret/API keys**. The `.env.example` file is safe if it only contains placeholders.

## One-time setup (each contributor)
1. Install GitHub Desktop and VS Code. Sign in on GitHub Desktop with your own GitHub account.
2. `File -> Clone repository -> URL`: `https://github.com/Bods-spec/GEM-Explorer.git`; choose a local folder.
3. Ensure `main` is current; `Fetch origin` / `Pull origin`.
4. `Current Branch -> New Branch` from `main`. Use one of:
   - Ameen: `feature/ameen-collections`
   - Hend: `feature/hend-auth`
   - Aya: `feature/aya-visit-planner`
5. Open the cloned folder in VS Code. Implement only your assigned pages/assets/routes on your branch.

## Daily collaboration
1. Check `Fetch origin`, and pull newest `main` before a new branch. If you are mid-feature, bring `main` into your feature branch only when ready to resolve possible conflicts.
2. Commit a meaningful feature: Summary e.g. `Add collection filters and artifact cards`.
3. Push / Publish branch. Use GitHub `Compare & pull request`, base=`main`; attach screenshots and list tested endpoints.
4. Lead reviews, asks for changes or merges the PR. Then everyone pulls the latest `main`.
5. Do not share ZIPs via WhatsApp as the main collaboration mechanism; it loses history and creates overwrite conflicts.

## Notes
- Existing static site: `https://bods-spec.github.io/GEM-Explorer/frontend/`; static hosting cannot run Node.js, Supabase-backed Express routes, or AI API. Use `http://localhost:3000` for full-stack local testing until the backend is deployed to suitable hosting.
- No accidental public secrets. Check that `.env` is ignored and use `git status` / GitHub Desktop Changes before every commit.
- No direct edits to `main` from any teammate (including lead, except emergencies).
- When two contributors need the same shared file (`backend/server.js`, `frontend/css/style.css`, `database/schema.sql`) agree beforehand; lead owns the integration edit.

# GEM Explorer — Homepage v1
**Web Design course | Team of 4 | Student 1 is lead developer**

A responsive, cinematic landing page inspired by the Grand Egyptian Museum in Giza. This version is the **front-end Homepage milestone**, not the finished website. No database, authentication, or booking backend has been implemented yet.

## Run locally (Windows / VS Code)
1. Unzip `GEM-Explorer-Homepage-v1.zip`.
2. Open the `GEM-Explorer` folder in VS Code.
3. Install the **Live Server** VS Code extension.
4. Right-click `frontend/index.html` and choose **Open with Live Server**.
5. Test on a desktop and in the browser's mobile Device Toolbar.

Alternative: double-click `frontend/index.html`. Basic features work without Live Server, but Live Server will be needed as the project expands.

**Internet access is required** for images from Wikimedia Commons and web fonts. The CSS provides dark illustrated gradients if assets cannot load. See `IMAGE_CREDITS.md` for licenses.

## What's included in v1
- Full viewport hero with 3 slides, previous/next buttons, automatic rotation (pauses when tab inactive or hovered)
- Navigation menu with responsive mobile layout
- English / Arabic switch (RTL when Arabic), stored in browser when available
- Discover, collection, journey, visit, and footer sections
- Collection cards that open an accessible details dialog
- Scroll-reveal, scroll progress, and accessibility support for reduced motion
- Legitimate link to the official museum and official tickets, **no mock payment screens**

## Folder structure
```
GEM-Explorer/
  frontend/
    index.html
    css/style.css
    js/app.js
    assets/brand-mark.svg
    assets/favicon.svg
  backend/
    routes/ (future)
    controllers/ (future)
    config/ (future)
    middleware/ (future)
  database/ (future)
  docs/ (planning notes)
  IMAGE_CREDITS.md
  README.md
  .gitignore
```

## Team roles
1. **Student 1 (Lead / ~40%)**: Design system, Homepage, global navigation, Node.js/Express app skeleton, initial MySQL setup, Admin foundation, merge/testing/deployment.
2. Student 2 (~20%): Collection listing + detail page, client search/filter, artifact read-only API.
3. Student 3 (~20%): Login/register/profile, user forms, secure auth API.
4. Student 4 (~20%): Visit planning, demo booking form and booking API, booking history tests.

Shared requirement: all students must participate in front-end, back-end, and integration. These are primary owners, not exclusive territories.

## Next integration contract (proposed, not implemented yet)
When the back-end begins, use Node.js + Express + MySQL. Proposed endpoints:
- `GET /api/artifacts` (list with search and filters)
- `GET /api/artifacts/:id` (details)
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me` (protected)
- `POST /api/bookings` (protected, **educational demo only**)
- `GET /api/bookings/me` (protected)
- `POST /api/admin/artifacts` (admin only)

Database tables: `users`, `artifacts`, `bookings`. Passwords must be hashed (bcrypt or argon2); never store plain-text passwords. Secrets are server-side in environment variables. Avoid presenting demo bookings as valid museum tickets.

## Design system
- Colors in `frontend/css/style.css` under `:root` (`--gold`, `--night`, `--sand`, etc.)
- Display font: Cormorant Garamond; UI font: DM Sans; Arabic font: Tajawal
- Responsive breakpoints: 1050px, 800px, 580px
- Each section has a unique `id` for anchor navigation and future routing
- User-facing strings are centralized in `frontend/js/app.js` (translations object)

## Suggested smoke test
- Slide next/previous changes the photo and title
- Language button changes text direction and section labels
- Menu opens and closes at mobile widths
- Collection card opens detail popup; Esc/backdrop/close button closes it
- Anchor links scroll to correct sections
- Reduced-motion setting disables automatic slide movement
- Official tickets link opens `https://tickets.gem.eg/`

## Course submission
The provided assignment template asks for a semantic responsive HTML/CSS front-end, JavaScript interactivity, Node.js backend, database, documentation, live demo, and a role description for each team member. This archive satisfies the **initial Homepage milestone** only.

## Notes
The site does not use official GEM branding or claim affiliation with the museum. Do not use the GEM logo or copyrighted images without checking permission and attribution.

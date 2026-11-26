/* ==========================================================================
 * TEMPORARY GUEST MODE: settings (local development only)
 *
 * Lets you open http://localhost:5600/visit.html and book through Egyxos
 * without a Login/Register screen, until the real authentication is ready.
 *
 * TO TURN GUEST MODE OFF (do any ONE of these):
 *   1. set  enabled: false  below, or
 *   2. delete the two <script> lines marked "TEMPORARY GUEST MODE" in visit.html, or
 *   3. delete guest-auth.js and guest-config.js.
 * Also remove ALLOW_GUEST_USERS from backend/.env: without it the backend
 * refuses guest users no matter what the browser does.
 *
 * mode:
 *   'supabase'  REAL guest sign-in with Supabase Anonymous Authentication.
 *               Needs "Allow anonymous sign-ins" turned on in the Supabase
 *               project (Authentication > Sign In / Providers).
 *               Bookings are saved in your real Supabase project.
 *   'memory'    No Supabase at all. Works ONLY with the in-memory test backend
 *               (node test/dev-memory-server.js). Nothing is saved anywhere.
 *
 * SECURITY: only the PUBLISHABLE key (starts with sb_publishable_ or the legacy
 * "anon" key) may be written here. Never paste a secret / service_role key.
 * guest-auth.js refuses to run if it detects one.
 * ========================================================================== */
window.GEM_GUEST = {
  enabled: true,
  mode: 'supabase',
  supabaseUrl: 'https://lrllqgkpleuvlckgeejw.supabase.co',            // e.g. https://abcdxyz.supabase.co
  supabasePublishableKey: 'sb_publishable_tuZG7TY2igTBC_8Jd9K4nQ_Ce4B1qaa'  // e.g. sb_publishable_...
};
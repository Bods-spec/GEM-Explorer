'use strict';
const { createClient } = require('@supabase/supabase-js');

// The secret key is ONLY available to this trusted Node.js server.
// It bypasses RLS: expose narrowly-scoped API routes and validate every write.
let instance;
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) return null;
  if (!instance) {
    instance = createClient(url, secret, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });
  }
  return instance;
}
module.exports = { getSupabase };

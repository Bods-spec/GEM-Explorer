'use strict';
const { Router } = require('express');
const { getSupabase } = require('../config/db');
const router = Router();
const COLUMNS = 'id,title_en,title_ar,era,section_id,description_en,description_ar,image_url,source_url';

function dbOr503(res) {
  const db = getSupabase();
  if (!db) res.status(503).json({ error: 'DATABASE_NOT_CONFIGURED', message: 'Set SUPABASE_URL and SUPABASE_SECRET_KEY in backend/.env.' });
  return db;
}

router.get('/', async (req, res, next) => {
  try {
    const db = dbOr503(res);
    if (!db) return;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const page = Math.min(10000, Math.max(1, parseInt(req.query.page, 10) || 1));
    // Never interpolate arbitrary client text into PostgREST logical filter syntax.
    const q = String(req.query.q || '').slice(0, 80).replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim();
    let query = db.from('artifacts').select(COLUMNS).eq('is_published', true);
    if (q) query = query.or(`title_en.ilike.%${q}%,title_ar.ilike.%${q}%`);
    const { data, error } = await query.order('id', { ascending: false }).range((page - 1) * limit, page * limit - 1);
    if (error) { console.error('Supabase artifacts error:', error.code || error.message); return res.status(502).json({ error: 'DATABASE_QUERY_FAILED' }); }
    res.json({ data: data || [], page, limit });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'INVALID_ID' });
    const db = dbOr503(res);
    if (!db) return;
    const { data, error } = await db.from('artifacts').select(COLUMNS).eq('id', req.params.id).eq('is_published', true).maybeSingle();
    if (error) { console.error('Supabase artifact error:', error.code || error.message); return res.status(502).json({ error: 'DATABASE_QUERY_FAILED' }); }
    if (!data) return res.status(404).json({ error: 'ARTIFACT_NOT_FOUND' });
    res.json({ data });
  } catch (err) { next(err); }
});
module.exports = router;

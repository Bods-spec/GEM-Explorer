'use strict';
const { Router } = require('express');
const { getSupabase } = require('../config/db');
const router = Router();
router.get('/', async (req, res, next) => {
  try {
    const db = getSupabase();
    if (!db) return res.status(503).json({ error: 'DATABASE_NOT_CONFIGURED' });
    const { data, error } = await db.from('museum_sections').select('id,slug,title_en,title_ar,source_url').order('id');
    if (error) { console.error('Supabase sections error:', error.code || error.message); return res.status(502).json({ error: 'DATABASE_QUERY_FAILED' }); }
    res.json({ data: data || [] });
  } catch (err) { next(err); }
});
module.exports = router;

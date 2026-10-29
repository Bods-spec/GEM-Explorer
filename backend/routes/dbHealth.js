'use strict';
const { Router } = require('express');
const { getSupabase } = require('../config/db');
const router = Router();
router.get('/', async (req, res, next) => {
  try {
    const db = getSupabase();
    if (!db) return res.status(503).json({ status: 'not_configured', error: 'DATABASE_NOT_CONFIGURED' });
    const { error } = await db.from('museum_sections').select('id').limit(1);
    if (error) {
      console.error('Database health check failed:', error.code || error.message);
      return res.status(502).json({ status: 'error', error: 'DATABASE_CONNECTION_FAILED' });
    }
    res.json({ status: 'connected', provider: 'supabase' });
  } catch (err) { next(err); }
});
module.exports = router;

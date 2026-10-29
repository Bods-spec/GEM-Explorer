'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const artifactsRouter = require('./routes/artifacts');
const sectionsRouter = require('./routes/sections');
const dbHealthRouter = require('./routes/dbHealth');
const aiRouter = require('./routes/ai');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const frontend = path.resolve(__dirname, '..', 'frontend');
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 150, standardHeaders: 'draft-8', legacyHeaders: false }));

app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'GEM Explorer API', version: '0.3.0' }));
app.use('/api/db-health', dbHealthRouter);
app.use('/api/sections', sectionsRouter);
app.use('/api/artifacts', artifactsRouter);
app.use('/api/ai', aiRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'API_ROUTE_NOT_FOUND' }));

app.use(express.static(frontend));
app.use((req, res) => res.status(404).send('Page not found'));
app.use((err, req, res, next) => {
  console.error('Server error:', err.code || err.message);
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Request failed. Check backend logs.' });
});
if (require.main === module) app.listen(PORT, () => {
  console.log(`GEM Explorer running at http://localhost:${PORT}`);
  console.log(`AI Guide UI: http://localhost:${PORT}/ai.html`);
  console.log(`Database check: http://localhost:${PORT}/api/db-health`);
});
module.exports = app;

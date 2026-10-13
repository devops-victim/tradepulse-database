const { setTimeout: sleep } = require('node:timers/promises');
const v = require('../validation');
const config = require('../config');
const trades = require('../services/trades');
const { ApiError } = require('../errors');
const callback = require('../webhook-validation');
module.exports = function controllers(db, extractions) {
 return {
  health: async (req, res) => {
   try { await db.query('SELECT 1'); res.status(extractions.active ? 200 : 503).json({ success: extractions.active, api: 'healthy', database: 'healthy', extractionWorker: extractions.active ? 'healthy' : 'unavailable' }); }
   catch { res.status(503).json({ success: false, api: 'healthy', database: 'unavailable' }); }
  },
  getTrades: async (req, res) => {
   v.allowed(req.query, ['limit','cursor','symbol','from','to','delay']);
   const filters = v.filters(req.query), page = v.page(req.query, JSON.stringify(filters)), delay = v.delay(req.query.delay);
   // Abort unnecessary delay when a synchronous client disconnects.
   const abort = new AbortController(), close = () => abort.abort();
   res.on('close', close);
   try { if (delay) await sleep(delay, undefined, { signal: abort.signal }); if (!res.destroyed) res.json(await trades.list(db, filters, page)); }
   catch (error) { if (error.name !== 'AbortError') throw error; }
   finally { res.off('close', close); }
  },
  trade: async (req, res) => {
   if (!/^[A-Za-z0-9_-]{1,40}$/.test(req.params.tradeId)) v.bad('tradeId must be 1–40 identifier characters');
   const { rows } = await db.query(`SELECT ${trades.fields} FROM trades WHERE trade_id=$1`, [req.params.tradeId]);
   if (!rows.length) throw new ApiError(404, 'TRADE_NOT_FOUND', 'Trade not found');
   res.json({ success: true, data: rows[0] });
  },
  symbols: async (req, res) => { const { rows } = await db.query('SELECT DISTINCT symbol FROM trades ORDER BY symbol'); res.json({ success: true, data: rows.map(row => row.symbol) }); },
  stats: async (req, res) => {
   const { rows } = await db.query('SELECT COUNT(*)::integer AS total_trades, COUNT(DISTINCT symbol)::integer AS total_symbols, COUNT(DISTINCT client)::integer AS total_clients FROM trades');
   res.json({ success: true, data: rows[0] });
  },
  createExtraction: async (req, res) => {
   v.allowed(req.query, []); v.allowed(req.body ?? {}, ['symbol','from','to','delay','callbackUrl','clientJobId']);
   const body = req.body ?? {}, registration = callback.registration(body, extractions.webhookOptions);
   const result = await extractions.create(v.filters(body), v.delay(body.delay, config.extractionDelay), registration, callback.idempotencyKey(req.get('Idempotency-Key')));
   res.location(result.statusUrl).status(202).json({ success: true, ...result });
  },
  extraction: async (req, res) => { v.allowed(req.query, []); res.json({ success: true, data: await extractions.get(v.uuid(req.params.jobId)) }); },
  notification: async (req, res) => {
   callback.authorize(req.get('Authorization'), extractions.webhookOptions); v.allowed(req.query, []);
   res.json({ success: true, data: await extractions.outbox.get(v.uuid(req.params.jobId)) });
  },
  redeliver: async (req, res) => {
   callback.authorize(req.get('Authorization'), extractions.webhookOptions); v.allowed(req.query, []); v.allowed(req.body ?? {}, []);
   res.status(202).json({ success: true, ...await extractions.outbox.redeliver(v.uuid(req.params.jobId)) });
  },
  extractionResults: async (req, res) => {
   v.allowed(req.query, ['limit','cursor']);
   const id = v.uuid(req.params.jobId), page = v.page(req.query, id), job = await extractions.get(id);
   if (job.status === 'failed') throw new ApiError(409, 'EXTRACTION_FAILED', job.error);
   if (job.status !== 'completed') throw new ApiError(409, 'EXTRACTION_NOT_READY', 'Extraction results are not ready');
   res.json(await trades.list(db, {}, page, id));
  }
 };
};

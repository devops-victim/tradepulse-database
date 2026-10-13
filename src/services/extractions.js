const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ApiError } = require('../errors');
const { where, fields } = require('./trades');
const config = require('../config');
const callback = require('../webhook-validation');
const transaction = require('../db/transaction');
const Outbox = require('./outbox');

class ExtractionService extends EventEmitter {
 constructor(db, webhookOptions = config.webhook) {
  super(); this.db = db; this.active = false; this.timers = new Map(); this.tasks = new Set();
  this.webhookOptions = webhookOptions;
  this.outbox = new Outbox(db, webhookOptions);
  this.outbox.on('fatal', error => { this.active = false; this.emit('fatal', error); });
  this.on('terminal', id => this.outbox.wake(id));
  this.on('submitted', id => this.dispatch(id));
 }
 async start(options = {}) {
  this.lock = await this.db.connect();
  this.lock.on('error', () => { this.active = false; this.emit('fatal', new Error('Worker database connection lost; restart required')); });
  try {
   const { rows } = await this.lock.query('SELECT pg_try_advisory_lock(hashtext(current_schema()), 74001) AS acquired');
   if (!rows[0].acquired) throw new Error('Another extraction worker is active; run one service instance');
   this.active = true;
   await this.outbox.start(options);
   // One recovery scan at startup, never a periodic scan or polling loop.
   const jobs = await this.db.query("SELECT job_id FROM extraction_jobs WHERE status IN ('pending','processing')");
   for (const job of jobs.rows) this.dispatch(job.job_id);
  } catch (error) { this.active = false; await this.outbox.stop(); this.lock.release(true); this.lock = null; throw error; }
 }
 dispatch(id) {
  if (!this.active || this.timers.has(id)) return;
  const task = this.schedule(id).catch(error => this.fail(id, error));
  this.tasks.add(task); task.finally(() => this.tasks.delete(task));
 }
 async schedule(id) {
  const { rows } = await this.db.query("UPDATE extraction_jobs SET status='processing', started_at=COALESCE(started_at,NOW()) WHERE job_id=$1 AND status IN ('pending','processing') RETURNING ready_at", [id]);
  if (!rows.length || !this.active) return;
  const remaining = Math.max(0, Date.parse(rows[0].ready_at) - Date.now());
  const timer = setTimeout(() => {
   this.timers.delete(id);
   if (!this.active) return;
   const task = this.terminal(id, 'completed').catch(error => this.fail(id, error));
   this.tasks.add(task); task.finally(() => this.tasks.delete(task));
  }, remaining);
  this.timers.set(id, timer);
 }
 async fail(id, error) {
  console.error('Extraction failed:', error.code || error.name);
  try { await this.terminal(id, 'failed', 'Extraction processing failed'); }
  catch { this.active = false; this.emit('fatal', new Error('Cannot persist extraction failure; restart required')); }
 }
 async terminal(id, status, error = null) {
  const changed = await transaction(this.db, async client => {
   const result = await client.query(`UPDATE extraction_jobs SET status=$2, error=$3, completed_at=NOW()
    WHERE job_id=$1 AND status IN ('pending','processing') RETURNING job_id, callback_url`, [id, status, error]);
   if (!result.rows.length) return false;
   if (result.rows[0].callback_url) await client.query('INSERT INTO extraction_outbox(job_id,terminal_status) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, status]);
   return true;
  });
  // Dispatch only once the status and terminal event are committed together.
  if (changed) this.emit('terminal', id);
 }
 async stop() {
  this.active = false;
  for (const timer of this.timers.values()) clearTimeout(timer);
  this.timers.clear();
  await Promise.allSettled([...this.tasks]);
  await this.outbox.stop();
  if (this.lock) { await this.lock.query('SELECT pg_advisory_unlock(hashtext(current_schema()), 74001)').catch(() => {}); this.lock.release(); this.lock = null; }
 }
 async create(filters, delay, registration = {}, key) {
  if (!this.active) throw new ApiError(503, 'WORKER_UNAVAILABLE', 'Extraction worker unavailable');
  registration = callback.registration(registration, this.webhookOptions);
  key = callback.idempotencyKey(key);
  const fingerprint = key ? createHash('sha256').update(JSON.stringify({symbol:filters.symbol ?? null,from:callback.canonicalTime(filters.from),to:callback.canonicalTime(filters.to),delay,callbackUrl:registration.callbackUrl ?? null,clientJobId:registration.clientJobId ?? null})).digest('hex') : null;
  const id = randomUUID(), client = await this.db.connect();
  let jobId = id;
  try {
   await client.query('BEGIN');
   const inserted = await client.query(`INSERT INTO extraction_jobs (job_id,filters,delay_ms,ready_at,callback_url,client_job_id,idempotency_key,request_fingerprint)
    VALUES ($1,$2,$3::integer,NOW()+($3::integer * INTERVAL '1 millisecond'),$4,$5,$6,$7)
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING job_id`, [id, JSON.stringify(filters), delay, registration.callbackUrl ?? null, registration.clientJobId ?? null, key ?? null, fingerprint]);
   if (!inserted.rows.length) {
    // ON CONFLICT waits for concurrent transactions; this new statement sees the winner.
    const { rows } = await client.query('SELECT job_id,request_fingerprint FROM extraction_jobs WHERE idempotency_key=$1', [key]);
    if (!rows.length || rows[0].request_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different extraction request');
    jobId = rows[0].job_id;
   } else {
   const { values, clauses } = where(filters, [id]);
   // A single INSERT SELECT observes a consistent MVCC snapshot and copies values.
   const result = await client.query(`INSERT INTO extraction_results (job_id,${fields}) SELECT $1,${fields} FROM trades ${clauses.length ? 'WHERE '+clauses.join(' AND ') : ''}`, values);
   await client.query('UPDATE extraction_jobs SET total_records=$2 WHERE job_id=$1', [id, result.rowCount]);
   }
   await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
  // The job is durable before acknowledging it; processing owns no HTTP connection.
  if (jobId === id) setImmediate(() => this.emit('submitted', id));
  return { jobId, status: 'pending', statusUrl: `/extractions/${jobId}`, resultsUrl: `/extractions/${jobId}/results` };
 }
 async get(id) {
  const { rows } = await this.db.query('SELECT job_id,status,filters,delay_ms,ready_at,total_records,error,created_at,started_at,completed_at FROM extraction_jobs WHERE job_id=$1', [id]);
  if (!rows.length) throw new ApiError(404, 'JOB_NOT_FOUND', 'Extraction job not found');
  return rows[0];
 }
}
module.exports = ExtractionService;

const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ApiError } = require('../errors');
const { where, fields } = require('./trades');

class ExtractionService extends EventEmitter {
 constructor(db) {
  super(); this.db = db; this.active = false; this.timers = new Map(); this.tasks = new Set();
  this.on('submitted', id => this.dispatch(id));
 }
 async start() {
  this.lock = await this.db.connect();
  this.lock.on('error', () => { this.active = false; this.emit('fatal', new Error('Worker database connection lost; restart required')); });
  try {
   const { rows } = await this.lock.query('SELECT pg_try_advisory_lock(hashtext(current_schema()), 74001) AS acquired');
   if (!rows[0].acquired) throw new Error('Another extraction worker is active; run one service instance');
   this.active = true;
   // One recovery scan at startup, never a periodic scan or polling loop.
   const jobs = await this.db.query("SELECT job_id FROM extraction_jobs WHERE status IN ('pending','processing')");
   for (const job of jobs.rows) this.dispatch(job.job_id);
  } catch (error) { this.active = false; this.lock.release(true); this.lock = null; throw error; }
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
   const task = this.db.query("UPDATE extraction_jobs SET status='completed', completed_at=NOW(), error=NULL WHERE job_id=$1 AND status='processing'", [id]).catch(error => this.fail(id, error));
   this.tasks.add(task); task.finally(() => this.tasks.delete(task));
  }, remaining);
  this.timers.set(id, timer);
 }
 async fail(id, error) {
  console.error('Extraction failed:', error.code || error.name);
  try { await this.db.query("UPDATE extraction_jobs SET status='failed', error=$2, completed_at=NOW() WHERE job_id=$1 AND status IN ('pending','processing')", [id, 'Extraction processing failed']); }
  catch { this.active = false; this.emit('fatal', new Error('Cannot persist extraction failure; restart required')); }
 }
 async stop() {
  this.active = false;
  for (const timer of this.timers.values()) clearTimeout(timer);
  this.timers.clear();
  await Promise.allSettled([...this.tasks]);
  if (this.lock) { await this.lock.query('SELECT pg_advisory_unlock(hashtext(current_schema()), 74001)').catch(() => {}); this.lock.release(); this.lock = null; }
 }
 async create(filters, delay) {
  if (!this.active) throw new ApiError(503, 'WORKER_UNAVAILABLE', 'Extraction worker unavailable');
  const id = randomUUID(), client = await this.db.connect();
  try {
   await client.query('BEGIN');
   await client.query("INSERT INTO extraction_jobs (job_id,filters,delay_ms,ready_at) VALUES ($1,$2,$3::integer,NOW()+($3::integer * INTERVAL '1 millisecond'))", [id, JSON.stringify(filters), delay]);
   const { values, clauses } = where(filters, [id]);
   // A single INSERT SELECT observes a consistent MVCC snapshot and copies values.
   const result = await client.query(`INSERT INTO extraction_results (job_id,${fields}) SELECT $1,${fields} FROM trades ${clauses.length ? 'WHERE '+clauses.join(' AND ') : ''}`, values);
   await client.query('UPDATE extraction_jobs SET total_records=$2 WHERE job_id=$1', [id, result.rowCount]);
   await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
  // The job is durable before acknowledging it; processing owns no HTTP connection.
  setImmediate(() => this.emit('submitted', id));
  return { jobId: id, status: 'pending', statusUrl: `/extractions/${id}`, resultsUrl: `/extractions/${id}/results` };
 }
 async get(id) {
  const { rows } = await this.db.query('SELECT * FROM extraction_jobs WHERE job_id=$1', [id]);
  if (!rows.length) throw new ApiError(404, 'JOB_NOT_FOUND', 'Extraction job not found');
  return rows[0];
 }
}
module.exports = ExtractionService;

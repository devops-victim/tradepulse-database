const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const pool = require('../src/db');
async function migrate(db = pool) {
 const client = await db.connect();
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(74001, 2)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const dir = path.join(__dirname, '../migrations');
  for (const name of (await fs.readdir(dir)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
   const sql = await fs.readFile(path.join(dir, name), 'utf8'), checksum = createHash('sha256').update(sql).digest('hex');
   const { rows } = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
   if (rows.length) { if (rows[0].checksum !== checksum) throw new Error(`Applied migration ${name} changed; add a new migration instead`); continue; }
   await client.query(sql); await client.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [name, checksum]);
   console.log(`Applied ${name}`);
  }
  await client.query('COMMIT');
 } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
 finally { client.release(); }
}
if (require.main === module) migrate().catch(e => { console.error('Migration failed:', e.code || e.message); process.exitCode = 1; }).finally(() => pool.end());
module.exports = migrate;

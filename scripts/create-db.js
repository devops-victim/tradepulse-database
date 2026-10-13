const { Client } = require('pg');
const config = require('../src/config');
async function main() {
 if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
 const url = new URL(process.env.DATABASE_URL);
 if (url.pathname !== '/bse_trades') throw new Error('DATABASE_URL must target bse_trades for db:create');
 url.pathname = '/postgres';
 const client = new Client({ ...config.database, connectionString: url.toString() });
 try {
  await client.connect();
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', ['bse_trades']);
  if (!rows.length) { try { await client.query('CREATE DATABASE bse_trades'); } catch (e) { if (e.code !== '42P04') throw e; } }
  console.log('Database bse_trades is ready');
 } finally { await client.end(); }
}
main().catch(e => { console.error('Database creation failed:', e.code || e.message); process.exitCode = 1; });

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
function integer(name, fallback, min, max) {
 const value = process.env[name] ?? String(fallback);
 if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
 return Number(value);
}
const maxDelay = integer('MAX_DELAY_MS', 900000, 0, 900000);
module.exports = {
 port: integer('PORT', 4001, 1, 65535), maxDelay,
 defaultDelay: integer('DEFAULT_DELAY_MS', 0, 0, maxDelay),
 extractionDelay: integer('DEFAULT_EXTRACTION_DELAY_MS', 0, 0, maxDelay),
 corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
 database: {
  connectionString: process.env.DATABASE_URL,
  max: integer('PG_POOL_MAX', 10, 2, 100),
  connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 20000,
  options: '-c timezone=UTC',
  ...(process.env.PG_SSL_CA_FILE ? { ssl: { ca: fs.readFileSync(process.env.PG_SSL_CA_FILE, 'utf8'), rejectUnauthorized: true } } : {})
 }
};

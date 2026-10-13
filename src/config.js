require('dotenv').config({ quiet: true });
const fs = require('node:fs');
function integer(name, fallback, min, max) {
    const value = process.env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return Number(value);
}
const maxDelay = integer('MAX_DELAY_MS', 900000, 0, 900000);
const production = process.env.NODE_ENV === 'production';
const secret = process.env.BSE_WEBHOOK_SECRET || '';
if (secret && (secret.length < 32 || secret.length > 512 || !/^[\x21-\x7e]+$/.test(secret))) throw new Error('BSE_WEBHOOK_SECRET must contain 32–512 printable non-space ASCII characters');
const callbackAllowlist = (process.env.BSE_CALLBACK_ALLOWLIST ?? (production ? '' : 'http://localhost:4000/api/bse/notifications')).split(',').map(value => value.trim()).filter(Boolean);
for (const destination of callbackAllowlist) {
    const url = new URL(destination);
    if (!/^https?:\/\//.test(destination) || url.username || url.password || destination.slice(destination.indexOf('://') + 3).split('/')[0].includes('@') || destination.includes('#') || destination.includes('?') || (production && url.protocol !== 'https:')) throw new Error('BSE_CALLBACK_ALLOWLIST must contain exact HTTP(S) URLs without credentials/query/fragment; production requires HTTPS');
}
module.exports = {
    port: integer('PORT', 4001, 1, 65535), maxDelay,
    defaultDelay: integer('DEFAULT_DELAY_MS', 0, 0, maxDelay),
    extractionDelay: integer('DEFAULT_EXTRACTION_DELAY_MS', 0, 0, maxDelay),
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    webhook: {
        secret, production, allowlist: callbackAllowlist,
        timeoutMs: integer('BSE_WEBHOOK_TIMEOUT_MS', 10000, 100, 25000),
        maxAttempts: integer('BSE_WEBHOOK_MAX_ATTEMPTS', 6, 1, 20),
        retryBaseMs: integer('BSE_WEBHOOK_RETRY_BASE_MS', 1000, 10, 300000),
        retryMaxMs: integer('BSE_WEBHOOK_RETRY_MAX_MS', 300000, 10, 900000),
        responseLimitBytes: 16384
    },
    database: {
        connectionString: process.env.DATABASE_URL,
        max: integer('PG_POOL_MAX', 10, 2, 100),
        connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 20000,
        options: '-c timezone=UTC',
        ssl: process.env.PG_SSL_CA_FILE
            ? {
                ca: fs.readFileSync(process.env.PG_SSL_CA_FILE, 'utf8'),
                rejectUnauthorized: true
            }
            : process.env.PG_SSL === 'false'
                ? { rejectUnauthorized: true }
                : undefined
    }
};

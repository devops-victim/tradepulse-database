const pool = require('./db');
const config = require('./config');
const ExtractionService = require('./services/extractions');
const createApp = require('./app');
const worker = new ExtractionService(pool);
let server, stopping = false;
async function shutdown(code = 0) {
    if (stopping) return; stopping = true;
    const deadline = setTimeout(() => process.exit(code || 1), 10000); deadline.unref();
    if (server) { server.close(); server.closeAllConnections(); }
    await worker.stop(); await pool.end(); clearTimeout(deadline); process.exitCode = code;
}
worker.on('fatal', error => { console.error(error.message); shutdown(1).catch(() => process.exit(1)); });
process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));
process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; configure .env');
    await pool.query('SELECT trade_id FROM trades LIMIT 1');
    await worker.start();
    server = createApp(pool, worker).listen(config.port, () => console.log(`BSE Trade API listening on port ${config.port}`));
    // Synchronous delay endpoint supports 15 minutes; async results never delay.
    server.timeout = config.maxDelay + 30000;
    server.requestTimeout = 30000;
    server.on('error', error => { console.error('HTTP server failed:', error.code); shutdown(1).catch(() => process.exit(1)); });
})().catch(async error => { console.error('Startup failed:', error.code || error.message); await shutdown(1); });

const { Pool, types } = require('pg');
const config = require('../config');
// Preserve PostgreSQL microseconds for exact cursor boundaries.
types.setTypeParser(1184, value => value.replace(' ', 'T').replace(/\+00$/, 'Z'));
const pool = new Pool(config.database);
pool.on('error', error => console.error('Idle database connection failed:', error.code || 'connection error'));
module.exports = pool;

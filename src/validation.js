const { ApiError } = require('./errors');
const config = require('./config');
const bad = message => { throw new ApiError(400, 'INVALID_PARAMETER', message); };
function number(value, name, fallback, min, max) {
 if (value === undefined) return fallback;
 if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) bad(`${name} must be an integer between ${min} and ${max}`);
 return Number(value);
}
function timestamp(value, name) {
 if (value === undefined) return undefined;
 const m = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 if (!m || value.startsWith('0000') || !Number.isFinite(Date.parse(value)) || new Date(`${m[1]}T00:00:00Z`).toISOString().slice(0,10) !== m[1] || +m[2] > 23 || +m[3] > 59 || +m[4] > 59 || (m[5] !== 'Z' && (+m[5].slice(1,3) > 15 || +m[5].slice(4) > 59))) bad(`${name} must be a valid ISO 8601 timestamp with timezone`);
 return value;
}
function filters(input) {
 let symbol;
 if (input.symbol !== undefined) {
  if (typeof input.symbol !== 'string' || !/^[A-Z0-9.-]{1,20}$/.test(input.symbol)) bad('symbol must be 1–20 uppercase symbol characters');
  symbol = input.symbol;
 }
 const from = timestamp(input.from, 'from'), to = timestamp(input.to, 'to');
 const micros = value => BigInt(Date.parse(value))*1000n + BigInt((/\.(\d+)/.exec(value)?.[1] || '').padEnd(6,'0').slice(3));
 if (from && to && micros(from) > micros(to)) bad('from must be before or equal to to');
 return { symbol, from, to };
}
function allowed(input, names) {
 if (!input || typeof input !== 'object' || Array.isArray(input)) bad('Expected an object');
 for (const key of Object.keys(input)) if (!names.includes(key)) bad(`Unknown parameter: ${key}`);
}
function page(input, scope) {
 const limit = number(input.limit, 'limit', 100, 1, 1000);
 let cursor;
 if (input.cursor !== undefined) {
  try {
   if (typeof input.cursor !== 'string' || input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw Error();
   cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
   if (cursor.v !== 1 || cursor.scope !== scope || typeof cursor.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(cursor.id)) throw Error();
   timestamp(cursor.ts, 'cursor timestamp');
   if (!cursor.ts) throw Error();
  } catch { bad('cursor is invalid or belongs to different filters/job'); }
 }
 return { limit, cursor, scope };
}
function uuid(value) {
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) bad('jobId must be a valid UUID v4');
 return value;
}
module.exports = { bad, number, timestamp, filters, allowed, page, uuid, delay: (value, fallback = config.defaultDelay) => number(value, 'delay', fallback, 0, config.maxDelay) };

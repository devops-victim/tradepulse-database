const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validation');
const { generate } = require('../scripts/seed');
const pool = require('../src/db');
test('validates limits, delays, repeated inputs and dates before SQL', () => {
 assert.equal(v.page({}, 'test').limit, 100);
 assert.equal(v.delay('900000'), 900000);
 for (const limit of ['0','1001','1.5','-1', ['2','3']]) assert.throws(() => v.page({limit}, 'test'));
 for (const delay of ['900001','NaN',{},'-1']) assert.throws(() => v.delay(delay));
 for (const from of ['2026-02-30T00:00:00Z','2026-01-01','2026-01-01T24:00:00Z','2026-01-01T00:00:00+23:00','0000-01-01T00:00:00Z']) assert.throws(() => v.filters({from}));
 assert.throws(() => v.filters({from:'2026-10-13T00:00:00.000002Z',to:'2026-10-13T00:00:00.000001Z'}));
 assert.throws(() => v.filters({symbol: "TCS'; DROP TABLE trades;--"}));
 assert.throws(() => v.allowed({unknown:1}, ['symbol']));
});
test('cursor preserves microseconds and rejects cross-scope/malformed cursors', () => {
 const cursor = Buffer.from(JSON.stringify({v:1,scope:'TCS',ts:'2026-10-13T00:00:00.123456Z',id:'BSE-TRD-000001'})).toString('base64url');
 assert.equal(v.page({cursor}, 'TCS').cursor.ts, '2026-10-13T00:00:00.123456Z');
 assert.throws(() => v.page({cursor}, 'INFY'));
 assert.throws(() => v.page({cursor:'invalid'}, 'TCS'));
});
test('fixed seed gives 10000 unique trades in the requested ranges', async () => {
 const reference = '2026-10-13T00:00:00Z', rows = generate(reference);
 assert.deepEqual(rows, generate(reference)); assert.equal(rows.length, 10000);
 assert.equal(new Set(rows.map(row=>row[0])).size, 10000);
 assert.equal(new Set(rows.map(row=>row[2])).size, 10);
 for (const row of rows) { assert.ok(row[3]>=1 && row[3]<=5000); assert.ok(Number(row[4])>0); assert.ok(Date.parse(row[5])<Date.parse(reference) && Date.parse(row[5])>=Date.parse(reference)-30*86400000); }
 await pool.end();
});

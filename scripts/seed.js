const pool = require('../src/db');
const stocks = { RELIANCE: 1400, TCS: 3400, INFY: 1700, HDFCBANK: 1000, ICICIBANK: 1350, SBIN: 800, ITC: 410, WIPRO: 260, LT: 3600, BHARTIARTL: 1900 };
function generate(referenceTime, count = 10000) {
 let state = 20261013;
 const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
 const symbols = Object.keys(stocks), rows = [];
 const reference = Date.parse(referenceTime);
 if (!Number.isFinite(reference)) throw new Error('Invalid SEED_REFERENCE_TIME');
 for (let i=1; i<=count; i++) {
  const symbol = symbols[Math.floor(random()*symbols.length)];
  rows.push([`BSE-TRD-${String(i).padStart(6,'0')}`, `CLIENT-${String(1+Math.floor(random()*100)).padStart(3,'0')}`, symbol, 1+Math.floor(random()*5000), (stocks[symbol]*(0.85+random()*0.30)).toFixed(2), new Date(reference-Math.floor(random()*30*86400000)-1).toISOString()]);
 }
 return rows;
}
async function seed(db = pool) {
 const client = await db.connect();
 try {
  await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(74001, 3)');
  await client.query('CREATE TABLE IF NOT EXISTS seed_metadata (name TEXT PRIMARY KEY, reference_time TIMESTAMPTZ NOT NULL)');
  const reference = process.env.SEED_REFERENCE_TIME || new Date().toISOString();
  generate(reference, 0);
  await client.query("INSERT INTO seed_metadata(name,reference_time) VALUES ('bse-10000-v1',$1) ON CONFLICT DO NOTHING", [reference]);
  const { rows } = await client.query("SELECT reference_time FROM seed_metadata WHERE name='bse-10000-v1'");
  const data = generate(rows[0].reference_time); let inserted = 0;
  for (let start=0; start<data.length; start+=500) {
   const batch = data.slice(start,start+500), values = batch.flat();
   const tuples = batch.map((_, i) => '('+Array.from({length:6}, (_,j)=>`$${i*6+j+1}`).join(',')+')').join(',');
   const result = await client.query(`INSERT INTO trades(trade_id,client,symbol,quantity,price,timestamp) VALUES ${tuples} ON CONFLICT (trade_id) DO NOTHING`, values);
   inserted += result.rowCount;
  }
  await client.query('COMMIT'); console.log(`Seeded ${inserted} new trades (10000 deterministic seed IDs)`);
 } catch(error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
 finally { client.release(); }
}
if (require.main === module) seed().catch(e => { console.error('Seed failed:', e.code || e.message); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { seed, generate };

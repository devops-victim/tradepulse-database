require('../src/config');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const config = require('../src/config');
const globalPool = require('../src/db');
const migrate = require('../scripts/migrate');
const { seed } = require('../scripts/seed');
const Worker = require('../src/services/extractions');
const createApp = require('../src/app');
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
test('PostgreSQL API integration and durable extraction recovery', {skip: !process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL}, async t => {
 const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
 const admin = new Pool({...config.database,connectionString:url});
 const schema = 'test_'+randomUUID().replaceAll('-','');
 let db, worker, server;
 try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = new Pool({...config.database,connectionString:url,options:`-c search_path=${schema} -c timezone=UTC`});
  await migrate(db); await migrate(db); await seed(db); await seed(db);
  worker = new Worker(db); await worker.start();
  server = createApp(db,worker).listen(0); await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(path, options) { const res=await fetch(base+path,options); return {status:res.status,body:await res.json()}; }
  const post = body => request('/extractions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await t.test('exactly 10000 unique seeded records; schema constraints; metadata endpoints', async () => {
   const count = await db.query('SELECT COUNT(*)::int AS total,COUNT(DISTINCT trade_id)::int AS unique FROM trades');
   assert.deepEqual(count.rows[0],{total:10000,unique:10000});
   assert.equal((await request('/health')).status,200);
   assert.equal((await request('/stats')).body.data.total_trades,10000);
   assert.equal((await request('/symbols')).body.data.length,10);
   assert.equal((await request('/trades/BSE-TRD-000001')).status,200);
   assert.equal((await request('/trades/missing')).status,404);
   await assert.rejects(db.query('UPDATE trades SET quantity=0 WHERE trade_id=$1',['BSE-TRD-000001']),{code:'23514'});
  });
  await t.test('full cursor traversal has stable order and no missing or duplicate rows', async () => {
   let cursor, ids=[], previous;
   do {
    const result=await request('/getTrades?limit=1000'+(cursor?'&cursor='+cursor:'')); assert.equal(result.status,200);
    for (const row of result.body.data) {
     if (previous) assert.ok(previous.timestamp>row.timestamp || (previous.timestamp===row.timestamp && previous.trade_id>row.trade_id));
     ids.push(row.trade_id); previous=row;
    }
    cursor=result.body.nextCursor;
   } while(cursor);
   assert.equal(ids.length,10000); assert.equal(new Set(ids).size,10000);
  });
  await t.test('symbol and inclusive date filters; microsecond cursor ties', async () => {
   const first=(await request('/getTrades?symbol=TCS&limit=1')).body.data[0];
   const result=await request(`/getTrades?symbol=TCS&from=${encodeURIComponent(first.timestamp)}&to=${encodeURIComponent(first.timestamp)}`);
   assert.equal(result.status,200); assert.ok(result.body.count>=1); assert.ok(result.body.data.every(r=>r.symbol==='TCS'&&r.timestamp===first.timestamp));
   assert.equal((await request('/getTrades?symbol=UNKNOWN')).body.count,0);
   await db.query("INSERT INTO trades(trade_id,client,symbol,quantity,price,timestamp) VALUES ('MICRO-1','CLIENT-001','MICRO',1,1,'2026-10-13T00:00:00.123456Z'),('MICRO-2','CLIENT-001','MICRO',1,1,'2026-10-13T00:00:00.123457Z'),('MICRO-3','CLIENT-001','MICRO',1,1,'2026-10-13T00:00:00.123456Z')");
   let cursor, ids=[];
   do { const r=(await request('/getTrades?symbol=MICRO&limit=1'+(cursor?'&cursor='+cursor:''))).body; ids.push(...r.data.map(x=>x.trade_id)); cursor=r.nextCursor; } while(cursor);
   assert.deepEqual(ids,['MICRO-2','MICRO-3','MICRO-1']);
   await db.query("DELETE FROM trades WHERE symbol='MICRO'");
  });
  await t.test('nonblocking delay keeps health responsive', async () => {
   const start=Date.now(), delayed=request('/getTrades?delay=350&limit=1');
   await sleep(40); const healthStart=Date.now(); assert.equal((await request('/health')).status,200); assert.ok(Date.now()-healthStart<250);
   assert.equal((await delayed).status,200); assert.ok(Date.now()-start>=330);
  });
  await t.test('202 is immediate, disconnect independent, results are immutable and paginated', async () => {
   const start=Date.now(), created=await post({symbol:'TCS',delay:900});
   assert.equal(created.status,202); assert.ok(Date.now()-start<600);
   const id=created.body.jobId;
   assert.equal((await request(`/extractions/${id}/results`)).status,409);
   const original=(await db.query("SELECT price FROM trades WHERE symbol='TCS' ORDER BY timestamp DESC,trade_id DESC LIMIT 1")).rows[0].price;
   await db.query("UPDATE trades SET price=price+1 WHERE symbol='TCS'");
   await sleep(1000);
   assert.equal((await request(`/extractions/${id}`)).body.data.status,'completed');
   const result=await request(`/extractions/${id}/results?limit=10`); assert.equal(result.status,200); assert.equal(result.body.count,10); assert.equal(result.body.data[0].price,original);
   const next=await request(`/extractions/${id}/results?limit=10&cursor=${result.body.nextCursor}`); assert.equal(next.body.count,10); assert.ok(!next.body.data.some(r=>result.body.data.some(p=>p.trade_id===r.trade_id)));
   assert.equal((await request(`/extractions/${id}/results?delay=100`)).status,400);
   await db.query("UPDATE trades SET price=price-1 WHERE symbol='TCS'");
  });
  await t.test('pending and processing jobs resume at startup using the persisted deadline', async () => {
   const created=await post({symbol:'INFY',delay:500}), id=created.body.jobId;
   await sleep(50); await worker.stop();
   await db.query("UPDATE extraction_jobs SET status='pending' WHERE job_id=$1",[id]);
   worker = new Worker(db); await worker.start();
   await sleep(600);
   assert.equal((await worker.get(id)).status,'completed');
   const processing=await worker.create({symbol:'ITC'},400); await sleep(40); await worker.stop();
   worker=new Worker(db); await worker.start(); await sleep(450);
   assert.equal((await worker.get(processing.jobId)).status,'completed');
  });
  await t.test('failed jobs and invalid requests produce clear responses', async () => {
   const id=randomUUID();
   await db.query("INSERT INTO extraction_jobs(job_id,status,filters,delay_ms,ready_at,error) VALUES ($1,'failed','{}',0,NOW(),'Extraction processing failed')",[id]);
   assert.equal((await request(`/extractions/${id}/results`)).body.error.code,'EXTRACTION_FAILED');
   assert.equal((await request(`/extractions/${randomUUID()}`)).status,404);
   assert.equal((await request('/extractions/not-a-uuid')).status,400);
   for (const path of ['/getTrades?limit=0','/getTrades?delay=900001','/getTrades?from=bad','/getTrades?from=2026-10-13T00:00:00Z&to=2026-10-12T00:00:00Z','/getTrades?symbol=tcs']) assert.equal((await request(path)).status,400,path);
   assert.equal((await post({delay:900001})).status,400);
   assert.equal((await post({limit:100})).status,400);
  });
  await t.test('worker exclusivity and processing failures are persisted', async () => {
   const other = new Worker(db); await assert.rejects(other.start(), /Another extraction worker/);
   await worker.stop();
   let injectFailure = true;
   const faultyDb = { connect: async () => {
    const client = await db.connect();
    return { on: (...args) => client.on(...args), release: () => client.release(), query: (sql, values) => {
     if (injectFailure && sql.startsWith('UPDATE extraction_jobs SET status=$2') && values[1] === 'completed') { injectFailure=false; return Promise.reject(new Error('simulated processing failure')); }
     return client.query(sql, values);
    } };
   }, query: (sql, values) => db.query(sql, values) };
   worker=new Worker(faultyDb); await worker.start();
   const created=await worker.create({},0); await sleep(100);
   assert.equal((await worker.get(created.jobId)).status,'failed');
   assert.equal((await request(`/extractions/${created.jobId}/results`)).status,409);
  });
 } finally {
  if(server) {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
  if(worker) await worker.stop();
  if(db) await db.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); await globalPool.end();
 }
});

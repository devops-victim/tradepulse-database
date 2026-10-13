require('../src/config');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const { Pool } = require('pg');
const config = require('../src/config');
const globalPool = require('../src/db');
const migrate = require('../scripts/migrate');
const Worker = require('../src/services/extractions');
const createApp = require('../src/app');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fingerprint = db => db.query("SELECT COUNT(*)::int AS count,md5(string_agg(row_to_json(t)::text,'' ORDER BY trade_id)) AS fingerprint FROM trades t").then(r=>r.rows[0]);

test('durable callbacks and idempotency using isolated PostgreSQL and real HTTP', {skip:!process.env.DATABASE_URL&&!process.env.TEST_DATABASE_URL, timeout:90000}, async t => {
    const admin = new Pool({...config.database, connectionString:process.env.TEST_DATABASE_URL||process.env.DATABASE_URL});
    const schema='webhook_test_'+randomUUID().replaceAll('-','');
    let db, worker, api, receiver, port, mode='accept';
    const events=new EventEmitter(), received=[], requests=[];
    const options={...config.webhook,secret:randomUUID()+randomUUID(),timeoutMs:150,maxAttempts:3,retryBaseMs:80,retryMaxMs:200,responseLimitBytes:1024,production:false};
    function waitForCallback(id, timeout=4000) {
        const existing=received.find(x=>x.externalJobId===id); if(existing)return Promise.resolve(existing);
        return new Promise((resolve,reject)=>{
            const listener=payload=>{if(payload.externalJobId===id){clearTimeout(deadline);events.off('accepted',listener);resolve(payload);}};
            const deadline=setTimeout(()=>{events.off('accepted',listener);reject(Error('Callback did not arrive'));},timeout);
            events.on('accepted',listener);
        });
    }
    function waitForAttempt(clientJobId) {
        if(requests.some(x=>x.payload.clientJobId===clientJobId))return Promise.resolve();
        return new Promise((resolve,reject)=>{
            const listener=payload=>{if(payload.clientJobId===clientJobId){clearTimeout(deadline);events.off('attempt',listener);resolve();}};
            const deadline=setTimeout(()=>{events.off('attempt',listener);reject(Error('HTTP attempt did not start'));},2000);events.on('attempt',listener);
        });
    }
    async function startReceiver() {
        receiver=http.createServer(async (req,res)=>{
            try {
                const chunks=[];for await(const chunk of req)chunks.push(chunk);
                const payload=JSON.parse(Buffer.concat(chunks).toString());
                const behavior=mode;
                requests.push({payload,auth:req.headers.authorization,path:req.url});
                events.emit('attempt',payload);
                assert.equal(req.headers.authorization,'Bearer '+options.secret);assert.equal(req.url,'/api/bse/notifications');
                assert.deepEqual(Object.keys(payload).sort(),['clientJobId','externalJobId','status']);
                const committed=await db.query('SELECT status FROM extraction_jobs WHERE job_id=$1',[payload.externalJobId]);assert.equal(committed.rows[0].status,payload.status);
                if(behavior==='timeout')return;
                if(behavior==='disconnect'){req.socket.destroy();return;}
                if(behavior==='retry'){res.writeHead(429,{'Retry-After':'0'});res.end('later');mode='accept';return;}
                if(behavior==='retry-date'){res.writeHead(503,{'Retry-After':new Date(Date.now()+100000).toUTCString()});res.end();mode='accept';return;}
                if(behavior==='permanent'){res.writeHead(400);res.end('invalid');return;}
                if(behavior==='redirect'){res.writeHead(302,{Location:'http://localhost:1/forbidden'});res.end();return;}
                if(behavior==='large'){res.writeHead(503);res.end('x'.repeat(10000));mode='accept';return;}
                await db.query('INSERT INTO fixture_notifications(job_id,client_job_id,status) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[payload.externalJobId,payload.clientJobId,payload.status]);
                received.push(payload);events.emit('accepted',payload);
                res.writeHead(202);res.end();
            }catch {res.writeHead(500);res.end();}
        });
        receiver.listen(port||0,'127.0.0.1');await new Promise(r=>receiver.once('listening',r));port=receiver.address().port;
    }
    async function stopReceiver(){if(receiver){receiver.closeAllConnections();await new Promise(r=>receiver.close(r));receiver=null;}}
    let base;
    async function request(path,settings){const response=await fetch(base+path,{...settings,signal:AbortSignal.timeout(5000)});return {status:response.status,body:await response.json()};}
    const registration=()=>({callbackUrl:options.allowlist[0],clientJobId:randomUUID()});
    const post=(body,key)=>request('/extractions',{method:'POST',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)});
    const auth={Authorization:'Bearer '+options.secret};
    async function restart(){await worker.stop();worker=new Worker(db,options);await worker.start();api.closeAllConnections();await new Promise(r=>api.close(r));api=createApp(db,worker).listen(0);await new Promise(r=>api.once('listening',r));base=`http://127.0.0.1:${api.address().port}`;}
    try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        db=new Pool({...config.database,connectionString:process.env.TEST_DATABASE_URL||process.env.DATABASE_URL,options:`-c search_path=${schema} -c timezone=UTC`});
        await migrate(db);await migrate(db);
        await db.query("INSERT INTO trades(trade_id,client,symbol,quantity,price,timestamp) VALUES ('BSE-TRD-000001','CLIENT-001','TCS',100,3200,NOW()),('BSE-TRD-000002','CLIENT-002','TCS',50,3300,NOW()),('BSE-TRD-000003','CLIENT-001','INFY',75,1700,NOW())");
        await db.query('CREATE TABLE fixture_notifications(job_id UUID PRIMARY KEY,client_job_id UUID,status TEXT)');
        const before=await fingerprint(db);
        await startReceiver();options.allowlist=[`http://127.0.0.1:${port}/api/bse/notifications`];
        worker=new Worker(db,options);await worker.start();api=createApp(db,worker).listen(0);await new Promise(r=>api.once('listening',r));base=`http://127.0.0.1:${api.address().port}`;
        await t.test('existing requests, validation and status/result shapes remain compatible',async()=>{
            const result=await post({delay:0});assert.equal(result.status,202);assert.deepEqual(Object.keys(result.body).sort(),['success','jobId','status','statusUrl','resultsUrl'].sort());
            for(const body of [{callbackUrl:options.allowlist[0]},{clientJobId:randomUUID()},{...registration(),clientJobId:'bad'},{...registration(),callbackUrl:'http://127.0.0.1:1/api/bse/notifications'},{...registration(),callbackUrl:options.allowlist[0]+'?secret=x'}])assert.equal((await post(body)).status,400);
            const status=await request(result.body.statusUrl);assert.equal(status.status,200);assert.ok(!Object.keys(status.body.data).some(k=>['callback_url','idempotency_key','request_fingerprint','client_job_id'].includes(k)));
        });
        await t.test('prompt 202, early 409, independent timer, authenticated callback and paginated results',async()=>{
            const reg=registration(),start=Date.now(),created=await post({...reg,symbol:'TCS',delay:350});assert.equal(created.status,202);assert.ok(Date.now()-start<300);
            const id=created.body.jobId;assert.equal((await request(`/extractions/${id}/results`)).body.error.code,'EXTRACTION_NOT_READY');
            assert.equal((await request('/health')).status,200);
            const callback=await waitForCallback(id);assert.deepEqual(callback,{externalJobId:id,clientJobId:reg.clientJobId,status:'completed'});
            const page=await request(`/extractions/${id}/results?limit=1`);assert.equal(page.status,200);assert.equal(page.body.count,1);assert.ok(page.body.nextCursor);
            assert.equal((await request(`/extractions/${id}/results?limit=1&cursor=${page.body.nextCursor}`)).body.count,1);
            assert.deepEqual((await request(created.body.statusUrl)).body.data.filters,{symbol:'TCS'});
            await sleep(40);assert.equal((await worker.outbox.get(id)).state,'delivered');
        });
        await t.test('idempotent concurrent retries produce one snapshot; conflicting reuse is 409',async()=>{
            const reg=registration(),key=randomUUID(),body={...reg,symbol:'TCS',delay:50,from:'2026-01-01T00:00:00Z'};
            const responses=await Promise.all(Array.from({length:8},()=>post(body,key)));assert.ok(responses.every(r=>r.status===202));assert.equal(new Set(responses.map(r=>r.body.jobId)).size,1);
            const equivalent=await post({...body,from:'2026-01-01T05:30:00.000000+05:30',clientJobId:body.clientJobId.toUpperCase()},key);assert.equal(equivalent.body.jobId,responses[0].body.jobId);
            for(const changed of [{delay:51},{symbol:'INFY'},{clientJobId:randomUUID()}])assert.equal((await post({...body,...changed},key)).body.error.code,'IDEMPOTENCY_CONFLICT');
            const count=await db.query('SELECT count(*)::int AS n FROM extraction_jobs WHERE idempotency_key=$1',[key]);assert.equal(count.rows[0].n,1);
            await waitForCallback(responses[0].body.jobId);
            const keyWithoutCallbacks=randomUUID();const a=await post({delay:0},keyWithoutCallbacks),b=await post({delay:0},keyWithoutCallbacks);assert.equal(a.body.jobId,b.body.jobId);
            const aNoKey=await post({delay:0}),bNoKey=await post({delay:0});assert.notEqual(aNoKey.body.jobId,bNoKey.body.jobId);
        });
        await t.test('completion can notify before the client receives its extraction receipt',async()=>{
            const outer=express();outer.use((req,res,next)=>{const json=res.json.bind(res);res.json=body=>{setTimeout(()=>json(body),200);return res;};next();});outer.use(createApp(db,worker));
            const slow=outer.listen(0);await new Promise(r=>slow.once('listening',r));const reg=registration();let receiptReceived=false;
            const listener=payload=>{if(payload.clientJobId===reg.clientJobId)assert.equal(receiptReceived,false);};events.on('accepted',listener);
            try{const response=await fetch(`http://127.0.0.1:${slow.address().port}/extractions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...reg,delay:0})});receiptReceived=true;const body=await response.json();assert.ok(received.some(x=>x.externalJobId===body.jobId));}
            finally{events.off('accepted',listener);slow.closeAllConnections();await new Promise(r=>slow.close(r));}
        });
        await t.test('terminal failure atomically emits a failed callback without results',async()=>{
            const created=await post({...registration(),delay:1000});const id=created.body.jobId;
            await worker.fail(id,new Error('injected extraction failure'));assert.equal((await waitForCallback(id)).status,'failed');
            assert.equal((await request(`/extractions/${id}/results`)).body.error.code,'EXTRACTION_FAILED');
            await worker.terminal(id,'completed');assert.equal((await worker.get(id)).status,'failed');
            assert.equal((await db.query('SELECT count(*)::int AS n FROM extraction_outbox WHERE job_id=$1',[id])).rows[0].n,1);
        });
        await t.test('outbox insertion failure rolls back terminal status; racing terminal events claim once',async()=>{
            const created=await post({...registration(),delay:1000});const id=created.body.jobId;
            const faultyDb={connect:async()=>{const client=await db.connect();return {release:()=>client.release(),query:(sql,values)=>sql.startsWith('INSERT INTO extraction_outbox')?Promise.reject(new Error('injected outbox insert failure')):client.query(sql,values)};}};
            const faultyWorker=new Worker(faultyDb,options);
            await assert.rejects(faultyWorker.terminal(id,'completed'),/injected outbox insert failure/);
            assert.ok(['pending','processing'].includes((await worker.get(id)).status));
            assert.equal((await db.query('SELECT count(*)::int AS n FROM extraction_outbox WHERE job_id=$1',[id])).rows[0].n,0);
            await Promise.all([worker.terminal(id,'completed'),worker.terminal(id,'completed')]);await waitForCallback(id);await sleep(50);
            assert.equal((await db.query('SELECT count(*)::int AS n FROM extraction_outbox WHERE job_id=$1',[id])).rows[0].n,1);
            assert.equal(requests.filter(x=>x.payload.externalJobId===id).length,1);
        });
        await t.test('retries for 429, 5xx, bounded Retry-After, disconnect, timeout and oversized responses',async()=>{
            for(const behavior of ['retry','retry-date','disconnect','timeout','large']){
                mode=behavior;const reg=registration(),created=await post({...reg,delay:0});const id=created.body.jobId;
                await waitForAttempt(reg.clientJobId);
                if(behavior==='timeout'){await sleep(170);mode='accept';}else if(behavior==='disconnect')mode='accept';
                await waitForCallback(id);await sleep(40);
                const state=await worker.outbox.get(id);assert.equal(state.state,'delivered');assert.ok(state.attempts>=2,behavior);
            }
        });
        await t.test('permanent failure, exhausted receiver downtime, explicit redelivery and duplicate correlation',async()=>{
            mode='redirect';const redirected=await post({...registration(),delay:0});await sleep(150);assert.equal((await worker.outbox.get(redirected.body.jobId)).state,'permanent_failure');
            mode='permanent';const created=await post({...registration(),delay:0});const id=created.body.jobId;await sleep(150);
            assert.equal((await worker.outbox.get(id)).state,'permanent_failure');assert.equal((await request(`/extractions/${id}/results`)).status,200);
            assert.equal((await request(`/extractions/${id}/notification`)).status,401);
            mode='accept';assert.equal((await request(`/extractions/${id}/notification/redeliver`,{method:'POST',headers:auth})).status,202);await waitForCallback(id);await sleep(50);
            const beforeCount=received.filter(x=>x.externalJobId===id).length;
            assert.equal((await request(`/extractions/${id}/notification/redeliver`,{method:'POST',headers:auth})).status,202);await sleep(150);
            const deliveries=received.filter(x=>x.externalJobId===id);assert.equal(deliveries.length,beforeCount+1);assert.deepEqual(deliveries[0],deliveries.at(-1));
            assert.equal((await db.query('SELECT count(*)::int AS n FROM fixture_notifications WHERE job_id=$1',[id])).rows[0].n,1);
            await stopReceiver();const unavailable=await post({...registration(),delay:0});await sleep(450);
            assert.equal((await worker.outbox.get(unavailable.body.jobId)).state,'exhausted');assert.equal((await request(`/extractions/${unavailable.body.jobId}/results`)).status,200);
            await startReceiver();await worker.outbox.redeliver(unavailable.body.jobId);await waitForCallback(unavailable.body.jobId);
        });
        await t.test('restart re-arms known pending delivery and interrupted in-flight delivery',async()=>{
            await stopReceiver();const created=await post({...registration(),delay:0});const id=created.body.jobId;await sleep(40);
            await restart();await startReceiver();await waitForCallback(id);await sleep(40);assert.equal((await worker.outbox.get(id)).state,'delivered');
            mode='timeout';const interrupted=await post({...registration(),delay:0});await sleep(40);await restart();mode='accept';await waitForCallback(interrupted.body.jobId);await sleep(40);assert.equal((await worker.outbox.get(interrupted.body.jobId)).state,'delivered');
        });
        await t.test('stored destinations are revalidated; delivery failure does not affect completed results',async()=>{
            const created=await post({...registration(),delay:100});const id=created.body.jobId;
            await db.query('UPDATE extraction_jobs SET callback_url=$2 WHERE job_id=$1',[id,'http://127.0.0.1:1/not-approved']);await sleep(200);
            const state=await worker.outbox.get(id);assert.equal(state.state,'permanent_failure');assert.equal(state.last_error,'CALLBACK_DESTINATION_REJECTED');assert.equal((await request(`/extractions/${id}/results`)).status,200);
        });
        await t.test('startup can defer delivery until the source HTTP listener is ready',async()=>{
            await worker.stop();worker=new Worker(db,options);await worker.start({deferDelivery:true});
            const reg=registration(),created=await worker.create({},0,reg);await sleep(70);
            assert.equal((await worker.get(created.jobId)).status,'completed');assert.equal((await worker.outbox.get(created.jobId)).state,'pending');
            assert.ok(!received.some(x=>x.externalJobId===created.jobId));worker.outbox.resume();await waitForCallback(created.jobId);
        });
        await t.test('actual source process crash and restart delivers a persisted notification',async()=>{
            const apiPort=api.address().port;
            api.closeAllConnections();await new Promise(r=>api.close(r));api=null;await worker.stop();await stopReceiver();
            const sourceUrl=new URL(process.env.TEST_DATABASE_URL||process.env.DATABASE_URL);sourceUrl.searchParams.set('options',`-c search_path=${schema} -c timezone=UTC`);
            let child;
            async function startProcess(){
                child=spawn(process.execPath,['src/server.js'],{cwd:require('node:path').join(__dirname,'..'),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DATABASE_URL:sourceUrl.href,PORT:String(apiPort),NODE_ENV:'test',BSE_WEBHOOK_SECRET:options.secret,BSE_CALLBACK_ALLOWLIST:options.allowlist[0],BSE_WEBHOOK_TIMEOUT_MS:'1000',BSE_WEBHOOK_MAX_ATTEMPTS:'3',BSE_WEBHOOK_RETRY_BASE_MS:'1000',BSE_WEBHOOK_RETRY_MAX_MS:'1000'}});
                await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(Error('Source startup timeout')),5000);child.once('exit',code=>{clearTimeout(deadline);reject(Error('Source exited '+code));});child.stdout.on('data',data=>{if(data.toString().includes('listening')){clearTimeout(deadline);resolve();}});child.stderr.on('data',()=>{});});
                base=`http://127.0.0.1:${apiPort}`;
            }
            async function stopProcess(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
            try{
                await startProcess();assert.equal((await request('/stats')).body.data.total_trades,3);
                const created=await post({...registration(),delay:0});const id=created.body.jobId;await sleep(200);
                const state=await db.query('SELECT state FROM extraction_outbox WHERE job_id=$1',[id]);assert.equal(state.rows[0].state,'retry');
                await stopProcess();await startReceiver();await startProcess();await waitForCallback(id);await sleep(50);
                assert.equal((await db.query('SELECT state FROM extraction_outbox WHERE job_id=$1',[id])).rows[0].state,'delivered');
                assert.equal((await request(`/extractions/${id}/results?limit=1`)).status,200);
            }finally{await stopProcess();worker=new Worker(db,options);await worker.start();api=createApp(db,worker).listen(0);await new Promise(r=>api.once('listening',r));base=`http://127.0.0.1:${api.address().port}`;}
        });
        await t.test('extraction exceeding 30 seconds uses a short receipt and event completion',async()=>{
            const start=Date.now(),created=await post({...registration(),symbol:'TCS',delay:31000});assert.equal(created.status,202);assert.ok(Date.now()-start<1000);
            assert.equal((await request(`/extractions/${created.body.jobId}/results`)).status,409);assert.equal((await request('/health')).status,200);
            await waitForCallback(created.body.jobId,34000);assert.ok(Date.now()-start>=30900);assert.equal((await request(`/extractions/${created.body.jobId}/results?limit=1`)).status,200);
        });
        assert.deepEqual(await fingerprint(db),before,'isolated source trades must remain unchanged');
    } finally {
        if(api){api.closeAllConnections();await new Promise(r=>api.close(r));}
        if(worker)await worker.stop();await stopReceiver();
        if(db)await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();await globalPool.end();
    }
});

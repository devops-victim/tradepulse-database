const { test } = require('node:test');
const assert = require('node:assert/strict');
const createApp = require('../src/app');
test('HTTP errors: database unavailable, malformed JSON/URL, validation and 404', async () => {
 const db = { query: async () => { const e = new Error('private connection details'); e.code='ECONNREFUSED'; throw e; } };
 const server = createApp(db, {active:true}).listen(0);
 await new Promise(resolve => server.once('listening', resolve));
 const url = `http://127.0.0.1:${server.address().port}`;
 try {
  for (const [path,status] of [['/health',503],['/stats',503],['/getTrades?limit=1001',400],['/getTrades?limit=2&limit=3',400],['/getTrades?cursor=bad',400],['/trades/%ZZ',400],['/unknown',404]]) {
   const res=await fetch(url+path), body=await res.json(); assert.equal(res.status,status,path); assert.equal(body.success,false); assert.ok(!JSON.stringify(body).includes('private'));
  }
  const res=await fetch(url+'/extractions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'}); assert.equal(res.status,400);
 } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { destination, registration, idempotencyKey, canonicalTime, authorize } = require('../src/webhook-validation');
const { retryDelay } = require('../src/services/webhook-http');
const options = {secret: 'a'.repeat(40), allowlist:['http://localhost:4000/api/bse/notifications'], production:false, retryBaseMs:1000, retryMaxMs:300000};
test('callback validation requires an approved exact origin/path and a paired client UUID', () => {
    assert.deepEqual(registration({}, options), {});
    const clientJobId='c6f6d735-52be-4e67-ae19-c5b7d968c2f0';
    assert.equal(registration({clientJobId,callbackUrl:options.allowlist[0]},options).clientJobId,clientJobId);
    for(const url of ['http://evil.test/api/bse/notifications','http://localhost:4001/api/bse/notifications','http://localhost:4000/other','http://user:password@localhost:4000/api/bse/notifications','http://localhost:4000/api/bse/notifications#','http://localhost:4000/api/bse/notifications?x=1','http://localhost:4000/api/bse/notifications/','ftp://localhost:4000/api/bse/notifications','http://localhost:4000/api\\bse/notifications']) assert.throws(()=>destination(url,options),url);
    assert.throws(()=>destination(options.allowlist[0],{...options,production:true}));
    assert.throws(()=>destination('http://@localhost:4000/api/bse/notifications',options));
    assert.throws(()=>registration({clientJobId},options));
    assert.throws(()=>registration({callbackUrl:options.allowlist[0]},options));
    assert.throws(()=>registration({clientJobId:'invalid',callbackUrl:options.allowlist[0]},options));
    assert.throws(()=>registration({clientJobId,callbackUrl:options.allowlist[0]},{...options,secret:''}),{code:'WEBHOOK_NOT_CONFIGURED'});
});
test('idempotency timestamp equivalence and key/auth validation', () => {
    assert.equal(canonicalTime('2026-10-13T05:30:00.123456+05:30'),canonicalTime('2026-10-13T00:00:00.123456Z'));
    assert.equal(canonicalTime('2026-10-13T00:00:00Z'),canonicalTime('2026-10-13T00:00:00.000000Z'));
    assert.equal(idempotencyKey('request-1:attempt.2'), 'request-1:attempt.2');
    for(const key of ['', 'a'.repeat(201),'two keys','key1,key2']) assert.throws(()=>idempotencyKey(key));
    assert.doesNotThrow(()=>authorize('Bearer '+options.secret,options));
    assert.throws(()=>authorize('Bearer wrong',options),{status:401});
});
test('retry backoff and Retry-After are bounded', () => {
    assert.equal(retryDelay(1,undefined,options),1000);
    assert.equal(retryDelay(3,undefined,options),4000);
    assert.equal(retryDelay(1,'2',options),2000);
    assert.equal(retryDelay(1,'999999999',options),300000);
    assert.equal(retryDelay(1,'invalid',options),1000);
    assert.equal(retryDelay(1,new Date(120000).toUTCString(),options,100000),20000);
});

const http = require('node:http');
const https = require('node:https');

// No redirects; bounded whole-exchange deadline, response headers and body.
function send(url, payload, options, signal) {
    return new Promise(resolve => {
        let settled = false, request, response, deadline;
        const finish = result => {
            if (settled) return;
            settled = true; clearTimeout(deadline); signal?.removeEventListener('abort', aborted);
            resolve(result);
        };
        const aborted = () => { finish({ retryable: true, error: 'DELIVERY_INTERRUPTED' }); request?.destroy(); response?.destroy(); };
        if (signal?.aborted) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
        const data = JSON.stringify(payload);
        request = (url.protocol === 'https:' ? https : http).request(url, {
            method: 'POST', maxHeaderSize: 16384,
            headers: { Authorization: `Bearer ${options.secret}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, res => {
            response = res;
            const status = res.statusCode;
            const result = status >= 200 && status < 300 ? { acknowledged: true, status } : {
                status, retryable: status === 429 || status >= 500,
                error: `HTTP_${status}`, retryAfter: res.headers['retry-after']
            };
            // The receiver has accepted on 2xx headers; never wait for ingestion/body.
            if (result.acknowledged) { finish(result); res.destroy(); return; }
            let bytes = 0;
            res.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > options.responseLimitBytes) { finish({ ...result, error: `HTTP_${status}_BODY_LIMIT` }); res.destroy(); }
            });
            res.on('end', () => finish(result));
            res.on('error', () => finish({ retryable: true, error: 'RESPONSE_DISCONNECTED', status }));
            res.on('aborted', () => finish({ retryable: true, error: 'RESPONSE_DISCONNECTED', status }));
        });
        request.on('error', () => finish({ retryable: true, error: 'CONNECTION_FAILED' }));
        deadline = setTimeout(() => { finish({ retryable: true, error: 'HTTP_TIMEOUT' }); request.destroy(); response?.destroy(); }, options.timeoutMs);
        request.end(data);
    });
}
function retryDelay(attempt, retryAfter, options, now = Date.now()) {
    const exponential = Math.min(options.retryMaxMs, options.retryBaseMs * 2 ** Math.min(attempt - 1, 20));
    let requested = 0;
    if (typeof retryAfter === 'string' && retryAfter.length <= 128) {
        requested = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
        if (!Number.isFinite(requested)) requested = 0;
    }
    return Math.min(options.retryMaxMs, Math.max(exponential, requested, 0));
}
module.exports = { send, retryDelay };

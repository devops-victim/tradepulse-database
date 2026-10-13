const { timingSafeEqual } = require('node:crypto');
const config = require('./config');
const { ApiError } = require('./errors');
const v = require('./validation');

function destination(value, options = config.webhook) {
    let url;
    try {
        if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value || !/^https?:\/\//.test(value) || value.includes('#') || value.includes('?') || /[\\\s]/.test(value)) throw new Error();
        url = new URL(value);
        if (url.username || url.password || value.slice(value.indexOf('://') + 3).split('/')[0].includes('@') || (options.production && url.protocol !== 'https:')) throw new Error();
        const approved = options.allowlist.some(item => {
            const allowed = new URL(item);
            return url.origin === allowed.origin && url.pathname === allowed.pathname;
        });
        if (!approved) throw new Error();
    } catch { throw new ApiError(400, 'INVALID_CALLBACK_URL', 'callbackUrl must match an approved callback origin and path'); }
    return url.href;
}
function registration(body, options = config.webhook) {
    if (body.callbackUrl === undefined && body.clientJobId === undefined) return {};
    if (body.callbackUrl === undefined || body.clientJobId === undefined) v.bad('callbackUrl and clientJobId must both be supplied');
    if (typeof body.clientJobId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.clientJobId)) v.bad('clientJobId must be a valid UUID');
    const callbackUrl = destination(body.callbackUrl, options);
    if (!options.secret || options.secret.length < 32) throw new ApiError(503, 'WEBHOOK_NOT_CONFIGURED', 'Callback delivery is not configured');
    return { callbackUrl, clientJobId: body.clientJobId.toLowerCase() };
}
function idempotencyKey(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) v.bad('Idempotency-Key must contain 1–200 letters, digits, dots, underscores, colons or hyphens');
    return value;
}
function authorize(value, options = config.webhook) {
    const expected = Buffer.from(`Bearer ${options.secret}`), supplied = Buffer.from(value || '');
    if (!options.secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ApiError(401, 'UNAUTHORIZED', 'Valid webhook bearer authentication is required');
}
// Canonical UTC timestamp retaining all microseconds, including timezone equivalents.
function canonicalTime(value) {
    if (value === undefined) return null;
    const iso = new Date(value).toISOString();
    const fractional = (/\.(\d+)/.exec(value)?.[1] || '').padEnd(6, '0');
    return iso.slice(0, -1) + fractional.slice(3) + 'Z';
}
module.exports = { destination, registration, idempotencyKey, authorize, canonicalTime };

class ApiError extends Error {
 constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function errorHandler(err, req, res, next) {
 if (res.headersSent) return next(err);
 if (err instanceof URIError) return res.status(400).json({ success: false, error: { code: 'INVALID_URL', message: 'URL encoding is invalid' } });
 if (err instanceof ApiError) return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } });
 if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'Body must be valid JSON' } });
 if (err.type === 'entity.too.large') return res.status(413).json({ success: false, error: { code: 'BODY_TOO_LARGE', message: 'Request body exceeds 16 KB' } });
 console.error('Request failed:', err.code || err.name);
 res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' } });
}
module.exports = { ApiError, errorHandler };

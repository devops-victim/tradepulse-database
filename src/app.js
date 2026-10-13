const express = require('express');
const config = require('./config');
const { ApiError, errorHandler } = require('./errors');
module.exports = function createApp(db, extractions) {
 const app = express(); app.disable('x-powered-by');
 app.use((req, res, next) => {
  const origin = req.get('Origin');
  res.vary('Origin');
  if (origin && (config.corsOrigins.includes(origin) || config.corsOrigins.includes('*'))) {
   res.set('Access-Control-Allow-Origin', config.corsOrigins.includes('*') ? '*' : origin);
   res.vary('Origin'); res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
 });
 app.use(express.json({ limit: '16kb' }));
 app.use(require('./routes')(require('./controllers')(db, extractions)));
 app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found')));
 app.use(errorHandler);
 return app;
};

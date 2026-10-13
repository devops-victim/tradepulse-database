const { Router } = require('express');
module.exports = function routes(controllers) {
 const router = Router();
 router.get('/health', controllers.health);
 router.get('/getTrades', controllers.getTrades);
 router.get('/trades/:tradeId', controllers.trade);
 router.get('/symbols', controllers.symbols);
 router.get('/stats', controllers.stats);
 router.post('/extractions', controllers.createExtraction);
 router.get('/extractions/:jobId', controllers.extraction);
 router.get('/extractions/:jobId/results', controllers.extractionResults);
 router.get('/extractions/:jobId/notification', controllers.notification);
 router.post('/extractions/:jobId/notification/redeliver', controllers.redeliver);
 return router;
};

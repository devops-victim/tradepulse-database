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
 return router;
};

'use strict';

const express = require('express');
const { testCompanyMyDataConnection, testConfiguredGuestyConnection } = require('../services/connection-service');
const { runGuestyReconciliation } = require('../services/guesty-reconciliation-service');
const { getReadiness } = require('../services/readiness-service');
const router = express.Router();

router.get('/readiness', async (_req, res, next) => {
  try { res.json(await getReadiness()); } catch (error) { next(error); }
});

router.post('/connections/guesty/test', async (_req, res, next) => {
  try { res.json(await testConfiguredGuestyConnection()); } catch (error) { next(error); }
});

router.post('/connections/guesty/reconcile', async (req, res, next) => {
  try { res.json(await runGuestyReconciliation({ from: req.body?.from, to: req.body?.to })); } catch (error) { next(error); }
});
router.post('/companies/:id/mydata-connection/test', async (req, res, next) => {
  try { res.json(await testCompanyMyDataConnection(Number(req.params.id))); } catch (error) { next(error); }
});

module.exports = router;

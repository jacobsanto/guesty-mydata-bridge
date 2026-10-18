'use strict';

const express = require('express');
const { testCompanyMyDataConnection, testConfiguredGuestyConnection } = require('../services/connection-service');
const { runGuestyReconciliation, retryGuestyUnresolvedReservations } = require('../services/guesty-reconciliation-service');
const { listReconciliationInbox } = require('../repositories/guesty-reconciliation-inbox');
const { getReadiness } = require('../services/readiness-service');
const router = express.Router();

router.get('/readiness', async (req, res, next) => {
  try {
    const queryCompanyId = req.query.companyId ?? req.query.company_id;
    res.json(await getReadiness(queryCompanyId === undefined ? undefined : { companyId: queryCompanyId }));
  } catch (error) { next(error); }
});

router.post('/connections/guesty/test', async (_req, res, next) => {
  try { res.json(await testConfiguredGuestyConnection()); } catch (error) { next(error); }
});

router.post('/connections/guesty/reconcile', async (req, res, next) => {
  try { res.json(await runGuestyReconciliation({ from: req.body?.from, to: req.body?.to })); } catch (error) { next(error); }
});

router.get('/connections/guesty/reconciliation-inbox', async (req, res, next) => {
  try {
    const status = req.query.status === 'all' ? null : String(req.query.status || 'unresolved');
    if (status && !['unresolved', 'resolved'].includes(status)) {
      throw Object.assign(new Error('status must be unresolved, resolved, or all'), { status: 400 });
    }
    const limit = Number(req.query.limit || 500);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw Object.assign(new Error('limit must be an integer from 1 to 1000'), { status: 400 });
    }
    res.json({ data: await listReconciliationInbox({ status, limit }) });
  } catch (error) { next(error); }
});

router.post('/connections/guesty/reconciliation-inbox/retry', async (_req, res, next) => {
  try {
    const result = await retryGuestyUnresolvedReservations();
    res.json({ attempted: result.attempted, staged: result.staged, results: result.results });
  } catch (error) { next(error); }
});

router.post('/companies/:id/mydata-connection/test', async (req, res, next) => {
  try { res.json(await testCompanyMyDataConnection(Number(req.params.id))); } catch (error) { next(error); }
});

module.exports = router;

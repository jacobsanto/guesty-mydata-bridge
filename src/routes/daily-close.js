'use strict';

const express = require('express');
const { executeDailyClose } = require('../services/daily-close-service');
const { listRuns, listRunItems } = require('../repositories/daily-close');

const router = express.Router();

router.get('/daily-close-runs', async (req, res, next) => {
  try {
    res.json({ data: await listRuns({
      companyId: req.query.company_id ? Number(req.query.company_id) : undefined,
      status: req.query.status,
      limit: req.query.limit,
    }) });
  } catch (error) { next(error); }
});

router.get('/daily-close-runs/:id/items', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid run id' });
    return res.json({ data: await listRunItems(id) });
  } catch (error) { return next(error); }
});

router.post('/daily-close', async (req, res, next) => {
  try {
    const companyId = Number(req.body.company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: 'Invalid company_id' });
    const run = await executeDailyClose({
      companyId,
      businessDate: req.body.business_date,
    });
    res.status(run.status === 'completed' ? 200 : 207).json(run);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

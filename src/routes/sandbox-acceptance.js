'use strict';

const express = require('express');
const {
  createAcceptanceRun, getAcceptanceMatrix, listAcceptanceRuns,
} = require('../services/sandbox-acceptance-service');

const router = express.Router();

router.get('/sandbox-acceptance/requirements', async (req, res, next) => {
  try {
    const companyId = Number(req.query.company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ error: 'Valid company_id is required' });
    return res.json({ data: await getAcceptanceMatrix(companyId) });
  } catch (error) { return next(error); }
});

router.get('/sandbox-acceptance/runs', async (req, res, next) => {
  try {
    const companyId = req.query.company_id ? Number(req.query.company_id) : undefined;
    if (companyId !== undefined && (!Number.isInteger(companyId) || companyId <= 0)) return res.status(400).json({ error: 'Invalid company_id' });
    return res.json({ data: await listAcceptanceRuns({ companyId }) });
  } catch (error) { return next(error); }
});

router.post('/sandbox-acceptance/runs', async (req, res, next) => {
  try { return res.status(201).json({ data: await createAcceptanceRun(req.body || {}) }); } catch (error) { return next(error); }
});

module.exports = router;

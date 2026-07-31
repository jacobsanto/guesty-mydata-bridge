'use strict';

const express = require('express');
const { listBillingRules, handleCreateBillingRule, handleUpdateBillingRule } = require('../services/billing-rule-service');
const router = express.Router();

router.get('/billing-rules', async (req, res, next) => {
  try { res.json({ data: await listBillingRules(req.query.listing_id ? Number(req.query.listing_id) : undefined) }); } catch (error) { next(error); }
});
router.post('/billing-rules', async (req, res, next) => {
  try { res.status(201).json({ data: await handleCreateBillingRule(req.body || {}) }); } catch (error) { next(error); }
});
router.patch('/billing-rules/:id', async (req, res, next) => {
  try { res.json({ data: await handleUpdateBillingRule(req.params.id, req.body || {}) }); } catch (error) { next(error); }
});

module.exports = router;

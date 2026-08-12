'use strict';

const express = require('express');
const { getPolicyMatrix } = require('../services/policy-matrix-service');
const {
  createChannelPolicyDraft, createTakkPolicyDraft, captureChannelCalibration, captureTakkCalibration, listPolicyVersions, recordApproval, recordDecision,
} = require('../services/policy-authoring-service');
const { policyAuth, requirePolicyRole } = require('../middleware/policy-auth');

const router = express.Router();

router.use(policyAuth);

router.get('/policy-matrix', requirePolicyRole('admin'), async (_req, res, next) => {
  try { res.json({ data: await getPolicyMatrix() }); } catch (error) { next(error); }
});

router.get('/channel-policies', requirePolicyRole('admin'), async (req, res, next) => {
  try { res.json({ data: await listPolicyVersions('channel', { listingId: req.query.listing_id }) }); } catch (error) { next(error); }
});

router.get('/takk-policies', requirePolicyRole('admin'), async (req, res, next) => {
  try { res.json({ data: await listPolicyVersions('takk', { listingId: req.query.listing_id }) }); } catch (error) { next(error); }
});

router.post('/channel-policies', requirePolicyRole('admin'), async (req, res, next) => {
  try { res.status(201).json({ data: await createChannelPolicyDraft(req.body || {}, req.policyActor.actorId) }); } catch (error) { next(error); }
});

router.post('/takk-policies', requirePolicyRole('admin'), async (req, res, next) => {
  try { res.status(201).json({ data: await createTakkPolicyDraft(req.body || {}, req.policyActor.actorId) }); } catch (error) { next(error); }
});

router.post('/channel-policies/:id/calibration-captures', requirePolicyRole('admin'), async (req, res, next) => {
  try { res.status(201).json({ data: await captureChannelCalibration('channel', req.params.id, req.body || {}, req.policyActor.actorId) }); } catch (error) { next(error); }
});

router.post('/takk-policies/:id/calibration-captures', requirePolicyRole('admin'), async (req, res, next) => {
  try { res.status(201).json({ data: await captureTakkCalibration(req.params.id, req.body || {}, req.policyActor.actorId) }); } catch (error) { next(error); }
});

router.post('/:type-policies/:id/approvals/accounting', requirePolicyRole('accounting'), async (req, res, next) => {
  try { res.status(201).json({ data: await recordApproval(req.params.type, req.params.id, 'accounting', req.body?.notes, req.policyActor.actorId) }); } catch (error) { next(error); }
});

router.post('/:type-policies/:id/approvals/technical', requirePolicyRole('technical'), async (req, res, next) => {
  try { res.status(201).json({ data: await recordApproval(req.params.type, req.params.id, 'technical', req.body?.notes, req.policyActor.actorId) }); } catch (error) { next(error); }
});

router.post('/:type-policies/:id/decisions', requirePolicyRole('admin'), async (req, res, next) => {
  try {
    const key = req.get('Idempotency-Key') || req.body?.idempotency_key;
    const payload = { decision: req.body?.decision, reason: req.body?.reason };
    res.status(201).json({ data: await recordDecision(req.params.type, req.params.id, payload, req.policyActor.actorId, key) });
  } catch (error) { next(error); }
});

module.exports = router;

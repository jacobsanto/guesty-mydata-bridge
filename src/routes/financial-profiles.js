'use strict';

const express = require('express');
const {
  listProfiles, createProfile, updateProfile, calibrateProfile,
  approveProfile, suspendProfile, listObservedChannels,
} = require('../services/financial-profile-service');

const router = express.Router();

router.get('/financial-profiles', async (req, res, next) => {
  try {
    res.json({ data: await listProfiles({
      listingId: req.query.listing_id ? Number(req.query.listing_id) : undefined,
      status: req.query.status || undefined,
    }) });
  } catch (error) { next(error); }
});
router.get('/financial-channels/observed', async (_req, res, next) => {
  try { res.json({ data: await listObservedChannels() }); } catch (error) { next(error); }
});
router.post('/financial-profiles', async (req, res, next) => {
  try { res.status(201).json({ data: await createProfile(req.body || {}) }); } catch (error) { next(error); }
});
router.patch('/financial-profiles/:id', async (req, res, next) => {
  try { res.json({ data: await updateProfile(req.params.id, req.body || {}) }); } catch (error) { next(error); }
});
router.post('/financial-profiles/:id/calibrate', async (req, res, next) => {
  try { res.json({ data: await calibrateProfile(req.params.id, req.body || {}) }); } catch (error) { next(error); }
});
router.post('/financial-profiles/:id/approve', async (req, res, next) => {
  try { res.json({ data: await approveProfile(req.params.id, req.body || {}) }); } catch (error) { next(error); }
});
router.post('/financial-profiles/:id/suspend', async (req, res, next) => {
  try { res.json({ data: await suspendProfile(req.params.id, req.body || {}) }); } catch (error) { next(error); }
});

module.exports = router;

'use strict';

const express = require('express');
const router = express.Router();
const {
  handleListListings,
  handleGetListing,
  handleCreateListing,
  handleUpdateListing,
} = require('../services/listing-service');

router.get('/listings', async (_req, res, next) => {
  try { return res.json({ data: await handleListListings() }); } catch (error) { return next(error); }
});

router.get('/listings/:id', async (req, res, next) => {
  try { return res.json({ data: await handleGetListing(req.params.id) }); } catch (error) { return next(error); }
});

router.post('/listings', async (req, res, next) => {
  try { return res.status(201).json({ data: await handleCreateListing(req.body || {}) }); } catch (error) { return next(error); }
});

router.patch('/listings/:id', async (req, res, next) => {
  try { return res.json({ data: await handleUpdateListing(req.params.id, req.body || {}) }); } catch (error) { return next(error); }
});

module.exports = router;

'use strict';

const express = require('express');
const { createSandboxSignoff, listSandboxSignoffs } = require('../services/sandbox-signoff-service');
const router = express.Router();

router.get('/sandbox-signoffs', async (_req, res, next) => {
  try { res.json({ data: await listSandboxSignoffs() }); } catch (error) { next(error); }
});
router.post('/sandbox-signoffs', async (req, res, next) => {
  try { res.status(201).json({ data: await createSandboxSignoff(req.body || {}) }); } catch (error) { next(error); }
});

module.exports = router;

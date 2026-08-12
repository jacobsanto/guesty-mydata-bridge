'use strict';

const express = require('express');
const { getPolicyMatrix } = require('../services/policy-matrix-service');

const router = express.Router();

router.get('/policy-matrix', async (_req, res, next) => {
  try { res.json({ data: await getPolicyMatrix() }); } catch (error) { next(error); }
});

module.exports = router;

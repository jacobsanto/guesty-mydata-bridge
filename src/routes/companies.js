'use strict';

const express = require('express');
const router = express.Router();

const {
  handleListCompanies,
  handleGetCompany,
  handleCreateCompany,
  handleUpdateCompany,
} = require('../services/company-service');

router.get('/companies', async (_req, res, next) => {
  try {
    const companies = await handleListCompanies();
    return res.status(200).json({ data: companies });
  } catch (err) {
    return next(err);
  }
});

router.get('/companies/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid company id' });
    }

    const company = await handleGetCompany(id);
    return res.status(200).json({ data: company });
  } catch (err) {
    return next(err);
  }
});

router.post('/companies', async (req, res, next) => {
  try {
    const company = await handleCreateCompany(req.body || {});
    return res.status(201).json({ data: company });
  } catch (err) {
    return next(err);
  }
});

router.patch('/companies/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid company id' });
    }

    const company = await handleUpdateCompany(id, req.body || {});
    return res.status(200).json({ data: company });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

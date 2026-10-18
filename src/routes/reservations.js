'use strict';

const express = require('express');
const { listReservationSnapshots } = require('../repositories/reservation-snapshots');
const { applyFiscalOverride, removeFiscalOverride, reopenForReissue, resolveCancellationReview } = require('../services/reservation-service');
const router = express.Router();

router.get('/reservations', async (req, res, next) => {
  try {
    res.json({ data: await listReservationSnapshots({
      companyId: req.query.company_id ? Number(req.query.company_id) : undefined,
      requiresReview: req.query.requires_review === undefined ? undefined : req.query.requires_review === 'true',
      materialized: req.query.materialized === undefined ? undefined : req.query.materialized === 'true',
    }) });
  } catch (error) { next(error); }
});

router.patch('/reservations/:reservationId/fiscal-override', async (req, res, next) => {
  try { res.json({ data: await applyFiscalOverride(req.params.reservationId, req.body || {}) }); } catch (error) { next(error); }
});

router.delete('/reservations/:reservationId/fiscal-override', async (req, res, next) => {
  try { res.json({ data: await removeFiscalOverride(req.params.reservationId) }); } catch (error) { next(error); }
});

router.post('/reservations/:reservationId/reopen-for-reissue', async (req, res, next) => {
  try { res.json({ data: await reopenForReissue(req.params.reservationId, req.body || {}) }); } catch (error) { next(error); }
});

router.post('/reservations/:reservationId/resolve-cancellation', async (req, res, next) => {
  try { res.json({ data: await resolveCancellationReview(req.params.reservationId, req.body || {}) }); } catch (error) { next(error); }
});

module.exports = router;

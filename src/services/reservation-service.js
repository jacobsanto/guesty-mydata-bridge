'use strict';

const { applySnapshotOverride, upsertReservationSnapshot, listDueReservationSnapshots, setFiscalOverride, clearFiscalOverride, reopenSnapshotForReissue, resolveCancelledSnapshot, markSnapshotMaterialized, markSnapshotError } = require('../repositories/reservation-snapshots');
const { cancelPendingReservationDocuments } = require('../repositories/fiscal-documents');
const { getCompanyAndListingByGuestyListingId } = require('../repositories/listings');
const { prepareReservationDocuments } = require('./document-service');
const { fetchReservation } = require('../guesty/client');
const { normalizeGuestyReservation } = require('../guesty/normalizer');
const { normalizeCounterpart, normalizeSeries } = require('../validation/fiscal-fields');
const { applyFinancialProfile } = require('./financial-profile-service');
const { db } = require('../database');

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

async function stageReservation(reservation, billingContext) {
  const snapshot = await upsertReservationSnapshot(reservation, billingContext);
  if (CANCELLED_STATUSES.has(String(reservation.status).toLowerCase())) {
    await cancelPendingReservationDocuments(reservation.reservationId);
  }
  return snapshot;
}

async function applyFiscalOverride(reservationId, payload) {
  const invoiceType = String(payload.invoice_type || '').trim();
  if (!['11.2', '2.1'].includes(invoiceType)) {
    const error = new Error('invoice_type must be 11.2 or 2.1'); error.status = 400; throw error;
  }
  const invoiceSeries = normalizeSeries(payload.series);
  let invoiceCounterpart;
  if (invoiceType === '2.1') {
    invoiceCounterpart = {
      ...normalizeCounterpart({
        vatNumber: payload.counterpart_vat_number,
        country: payload.counterpart_country,
        name: payload.counterpart_name,
        branch: payload.counterpart_branch,
      }, { required: true, label: 'counterpart' }),
    };
  }
  const snapshot = await setFiscalOverride(String(reservationId), { invoiceType, invoiceSeries, invoiceCounterpart });
  if (!snapshot) { const error = new Error('Reservation snapshot not found'); error.status = 404; throw error; }
  return snapshot;
}

async function removeFiscalOverride(reservationId) {
  const snapshot = await clearFiscalOverride(String(reservationId));
  if (!snapshot) { const error = new Error('Reservation snapshot not found'); error.status = 404; throw error; }
  return snapshot;
}

function requireResolution(value) {
  const resolution = String(value || '').trim();
  if (resolution.length < 5) { const error = new Error('resolution must contain at least 5 characters'); error.status = 400; throw error; }
  return resolution;
}

async function reopenForReissue(reservationId, payload) {
  const snapshot = await reopenSnapshotForReissue(String(reservationId), requireResolution(payload.resolution));
  if (!snapshot) { const error = new Error('Reservation snapshot not found'); error.status = 404; throw error; }
  return snapshot;
}

async function resolveCancellationReview(reservationId, payload) {
  const snapshot = await resolveCancelledSnapshot(String(reservationId), requireResolution(payload.resolution));
  if (!snapshot) { const error = new Error('Reservation snapshot not found'); error.status = 404; throw error; }
  return snapshot;
}

async function materializeDueReservations(companyId, businessDate, {
  fetcher = fetchReservation,
  useGuestyRefresh = Boolean(process.env.GUESTY_CLIENT_ID && process.env.GUESTY_CLIENT_SECRET),
} = {}) {
  const snapshots = await listDueReservationSnapshots(companyId, businessDate);
  const results = [];
  for (const snapshot of snapshots) {
    try {
      let reservation = JSON.parse(snapshot.normalized_payload);
      if (useGuestyRefresh) {
        reservation = normalizeGuestyReservation(await fetcher(snapshot.reservation_id));
      }
      reservation = applySnapshotOverride(reservation, snapshot);
      const billingContext = await getCompanyAndListingByGuestyListingId(reservation.listingId);
      if (!billingContext || billingContext.company_id !== companyId) throw new Error('Latest Guesty listing has no matching company configuration');
      if (CANCELLED_STATUSES.has(String(reservation.status).toLowerCase())) {
        await db.transaction(async (trx) => {
          await upsertReservationSnapshot(reservation, billingContext, {
            transaction: trx,
            expectedGeneration: snapshot.generation,
          });
          await cancelPendingReservationDocuments(reservation.reservationId, trx);
        });
        results.push({ reservationId: snapshot.reservation_id, skipped: true, reason: 'cancelled' });
        continue;
      }
      reservation = await applyFinancialProfile(reservation, billingContext);
      const documents = await db.transaction(async (trx) => {
        const current = await upsertReservationSnapshot(reservation, billingContext, {
          transaction: trx,
          expectedGeneration: snapshot.generation,
        });
        const created = await prepareReservationDocuments(reservation, billingContext, { transaction: trx });
        await markSnapshotMaterialized(snapshot.id, current.generation, { transaction: trx });
        return created;
      });
      results.push({ reservationId: snapshot.reservation_id, skipped: false, documentIds: [documents.primary, documents.climate].filter(Boolean).map((item) => item.document.id) });
    } catch (error) {
      if (error.code !== 'RESERVATION_SNAPSHOT_CHANGED') {
        await markSnapshotError(snapshot.id, error.message, snapshot.generation);
      }
      results.push({
        reservationId: snapshot.reservation_id,
        skipped: true,
        ...(error.code === 'RESERVATION_SNAPSHOT_CHANGED' ? { reason: 'changed_during_materialization' } : { error: error.message }),
      });
    }
  }
  return results;
}

module.exports = { stageReservation, applyFiscalOverride, removeFiscalOverride, reopenForReissue, resolveCancellationReview, materializeDueReservations };

'use strict';

const { applySnapshotOverride, upsertReservationSnapshot, listDueReservationSnapshots, setFiscalOverride, clearFiscalOverride, reopenSnapshotForReissue, resolveCancelledSnapshot, markSnapshotMaterialized, markSnapshotError } = require('../repositories/reservation-snapshots');
const { cancelPendingReservationDocuments, queueReservationDocumentCancellations } = require('../repositories/fiscal-documents');
const { getCompanyAndListingByGuestyListingId } = require('../repositories/listings');
const { prepareReservationDocuments } = require('./document-service');
const { fetchReservation } = require('../guesty/client');
const { normalizeGuestyReservation } = require('../guesty/normalizer');
const { normalizeCounterpart, normalizeSeries } = require('../validation/fiscal-fields');
const { applyFinancialProfile } = require('./financial-profile-service');
const { assertApprovedFinancialProfileBinding } = require('../repositories/financial-profiles');
const { applyUnifiedChannelPolicy, assertApprovedUnifiedChannelPolicyBinding } = require('./unified-channel-policy-service');
const { applyTakkPolicy, assertApprovedTakkPolicyBinding } = require('./takk-policy-service');
const { db } = require('../database');

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

async function stageCancellation(reservation, billingContext, options = {}) {
  const execute = async (trx) => {
    const snapshot = await upsertReservationSnapshot(reservation, billingContext, {
      transaction: trx,
      ...(options.expectedGeneration === undefined ? {} : { expectedGeneration: options.expectedGeneration }),
    });
    await cancelPendingReservationDocuments(reservation.reservationId, trx);
    await queueReservationDocumentCancellations(reservation.reservationId, trx);
    const active = await trx('fiscal_documents')
      .where({ reservation_id: reservation.reservationId })
      .whereNot({ status: 'cancelled' })
      .count({ count: '*' })
      .first();
    if (Number(active?.count || 0) > 0) {
      await trx('reservation_snapshots').where({ id: snapshot.id }).update({
        requires_review: true,
        financial_status: 'review',
        last_error: 'Guesty cancellation quarantined: transmitted or in-flight fiscal documents require AADE cancellation review',
        updated_at: trx.fn.now(),
      });
    }
    return trx('reservation_snapshots').where({ id: snapshot.id }).first();
  };
  if (options.transaction) return execute(options.transaction);
  return db.transaction(execute);
}

async function stageReservation(reservation, billingContext) {
  if (CANCELLED_STATUSES.has(String(reservation.status).toLowerCase())) {
    return stageCancellation(reservation, billingContext);
  }
  return upsertReservationSnapshot(reservation, billingContext);
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
  beforeMaterializationTransaction = null,
  enforceUnifiedPolicy = process.env.MYDATA_ENV === 'production',
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
      if (!billingContext.company_active || !billingContext.listing_active) {
        throw new Error('Latest Guesty company/listing mapping is inactive; fiscal materialization is blocked');
      }
      if (CANCELLED_STATUSES.has(String(reservation.status).toLowerCase())) {
        await db.transaction(async (trx) => {
          await stageCancellation(reservation, billingContext, {
            transaction: trx,
            expectedGeneration: snapshot.generation,
          });
        });
        results.push({ reservationId: snapshot.reservation_id, skipped: true, reason: 'cancelled' });
        continue;
      }
      reservation = enforceUnifiedPolicy
        ? await applyUnifiedChannelPolicy(reservation, billingContext)
        : await applyFinancialProfile(reservation, billingContext);
      if (enforceUnifiedPolicy) reservation = await applyTakkPolicy(reservation, billingContext);
      if (beforeMaterializationTransaction) await beforeMaterializationTransaction({ reservation, billingContext, snapshot });
      const documents = await db.transaction(async (trx) => {
        if (enforceUnifiedPolicy) {
          await assertApprovedUnifiedChannelPolicyBinding(reservation.unifiedChannelPolicy, reservation, billingContext, trx);
          await assertApprovedTakkPolicyBinding(reservation.unifiedTakkPolicy, reservation, billingContext, trx);
        } else {
          await assertApprovedFinancialProfileBinding(
            reservation.financialProfile,
            billingContext.listing_id,
            reservation.platformKey,
            reservation.sourceKey,
            trx,
          );
        }
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

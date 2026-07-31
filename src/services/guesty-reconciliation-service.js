'use strict';

const { db } = require('../database');
const { searchUpdatedReservationIds, fetchReservation } = require('../guesty/client');
const { normalizeGuestyReservation } = require('../guesty/normalizer');
const { getCompanyAndListingByGuestyListingId } = require('../repositories/listings');
const { recordIntegrationCheck } = require('../repositories/integration-checks');
const {
  recordUnresolvedReservation,
  updateUnresolvedReservation,
  resolveUnresolvedReservation,
  listReconciliationInbox,
} = require('../repositories/guesty-reconciliation-inbox');
const { stageReservation } = require('./reservation-service');

const RELEVANT = new Set(['confirmed', 'checked_out', 'cancelled', 'canceled']);
const RECONCILIATION_CHECK_KEY = 'guesty:reservation_reconciliation';

function iso(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error(`${label} must be a valid ISO date-time`), { status: 400 });
  return date.toISOString();
}

async function getCursor() {
  return db('sync_cursors').where({ provider: 'guesty', cursor_key: 'reservations_last_updated' }).first();
}

async function saveCursor(value, client = db) {
  const row = { provider: 'guesty', cursor_key: 'reservations_last_updated', cursor_value: value, updated_at: client.fn.now() };
  await client('sync_cursors').insert(row).onConflict(['provider', 'cursor_key']).merge(row);
}

function mappingIssue(mapping) {
  if (!mapping) return 'unmapped_listing';
  if (!mapping.company_active) return 'inactive_company';
  if (!mapping.listing_active) return 'inactive_listing';
  return null;
}

async function retryGuestyUnresolvedReservations({ fetcher = fetchReservation } = {}) {
  const pending = await listReconciliationInbox({ status: 'unresolved' });
  const results = [];
  const fetchedIds = new Set();
  let failures = 0;
  for (const entry of pending) {
    const reservationId = String(entry.reservation_id);
    const configuredMapping = entry.listing_id
      ? await getCompanyAndListingByGuestyListingId(entry.listing_id)
      : null;
    const configuredIssue = mappingIssue(configuredMapping);
    await recordUnresolvedReservation({
      reservationId,
      listingId: entry.listing_id,
      reason: configuredIssue || entry.reason,
    });
    if (configuredIssue) {
      results.push({ reservationId, listingId: entry.listing_id, skipped: true, retry: true, reason: configuredIssue });
      continue;
    }
    try {
      const reservation = normalizeGuestyReservation(await fetcher(reservationId));
      fetchedIds.add(reservationId);
      if (!RELEVANT.has(reservation.status)) {
        await resolveUnresolvedReservation(reservationId, 'irrelevant_status');
        results.push({ reservationId, status: reservation.status, skipped: true, retry: true, reason: 'irrelevant_status', resolved: true });
        continue;
      }
      const mapping = await getCompanyAndListingByGuestyListingId(reservation.listingId);
      const issue = mappingIssue(mapping);
      if (issue) {
        await updateUnresolvedReservation({ reservationId, listingId: reservation.listingId, reason: issue });
        results.push({ reservationId, listingId: reservation.listingId, skipped: true, retry: true, reason: issue });
        continue;
      }
      const snapshot = await stageReservation(reservation, mapping);
      await resolveUnresolvedReservation(reservationId, 'staged');
      results.push({ reservationId, skipped: false, retry: true, resolved: true, snapshotId: snapshot.id });
    } catch (error) {
      failures += 1;
      fetchedIds.add(reservationId);
      await updateUnresolvedReservation({
        reservationId,
        listingId: entry.listing_id,
        reason: 'retry_failed',
        error: error.message,
      });
      results.push({ reservationId, skipped: true, retry: true, error: error.message });
    }
  }
  if (failures > 0) {
    throw Object.assign(new Error(`Guesty unresolved retry failed for ${failures}/${pending.length} reservations`), {
      status: 502,
      results,
      fetchedIds,
    });
  }
  return { attempted: pending.length, staged: results.filter((row) => !row.skipped).length, results, fetchedIds };
}

async function runGuestyReconciliation({
  from, to = new Date().toISOString(), searcher = searchUpdatedReservationIds, fetcher = fetchReservation,
} = {}) {
  const startedAt = new Date().toISOString();
  const cursor = await getCursor();
  const overlapMs = Number(process.env.GUESTY_RECONCILIATION_OVERLAP_MINUTES || 10) * 60 * 1000;
  const initialLookbackMs = Number(process.env.GUESTY_RECONCILIATION_INITIAL_LOOKBACK_DAYS || 7) * 86400000;
  const end = iso(to, 'to');
  const startBase = from || cursor?.cursor_value || new Date(Date.parse(end) - initialLookbackMs).toISOString();
  const start = iso(new Date(Date.parse(startBase) - (cursor && !from ? overlapMs : 0)), 'from');
  let reservationIds = [];
  const results = [];
  try {
    const retried = await retryGuestyUnresolvedReservations({ fetcher });
    results.push(...retried.results);
    reservationIds = await searcher({ from: start, to: end });
    let failures = 0;
    for (const reservationId of reservationIds) {
      if (retried.fetchedIds.has(String(reservationId))) continue;
      try {
        const reservation = normalizeGuestyReservation(await fetcher(reservationId));
        if (!RELEVANT.has(reservation.status)) {
          await resolveUnresolvedReservation(reservationId, 'irrelevant_status');
          results.push({ reservationId, status: reservation.status, skipped: true, reason: 'irrelevant_status' });
          continue;
        }
        const mapping = await getCompanyAndListingByGuestyListingId(reservation.listingId);
        const issue = mappingIssue(mapping);
        if (issue) {
          await recordUnresolvedReservation({ reservationId, listingId: reservation.listingId, reason: issue });
          results.push({ reservationId, listingId: reservation.listingId, skipped: true, reason: issue });
          continue;
        }
        const snapshot = await stageReservation(reservation, mapping);
        await resolveUnresolvedReservation(reservationId, 'staged');
        results.push({ reservationId, skipped: false, snapshotId: snapshot.id });
      } catch (error) {
        failures += 1;
        results.push({ reservationId, skipped: true, error: error.message });
      }
    }
    if (failures > 0) {
      throw Object.assign(new Error(`Guesty reconciliation failed for ${failures}/${reservationIds.length} reservations`), {
        status: 502, results, from: start, to: end,
      });
    }
    const staged = results.filter((row) => !row.skipped).length;
    const evidence = {
      startedAt,
      completedAt: new Date().toISOString(),
      from: start,
      to: end,
      successfulWatermark: end,
      discovered: reservationIds.length,
      retried: retried.attempted,
      unresolved: results.filter((row) => ['unmapped_listing', 'inactive_company', 'inactive_listing'].includes(row.reason)).length,
      staged,
      failures: 0,
    };
    // The success evidence and its cursor advance are one durable fact. A
    // crash cannot publish a watermark without the matching successful run.
    await db.transaction(async (trx) => {
      await saveCursor(end, trx);
      await recordIntegrationCheck(RECONCILIATION_CHECK_KEY, 'success', 'guesty', JSON.stringify(evidence), trx);
    });
    return { from: start, to: end, discovered: reservationIds.length, retried: retried.attempted, staged, results, watermark: end };
  } catch (error) {
    const evidence = {
      startedAt,
      completedAt: new Date().toISOString(),
      from: start,
      to: end,
      priorSuccessfulWatermark: cursor?.cursor_value || null,
      discovered: reservationIds.length,
      staged: results.filter((row) => !row.skipped).length,
      failures: results.filter((row) => row.error).length || 1,
      error: error.message,
    };
    try {
      await recordIntegrationCheck(RECONCILIATION_CHECK_KEY, 'failed', 'guesty', JSON.stringify(evidence));
    } catch (recordError) {
      error.reconciliationEvidenceError = recordError.message;
    }
    throw error;
  }
}

module.exports = { runGuestyReconciliation, retryGuestyUnresolvedReservations, RECONCILIATION_CHECK_KEY };

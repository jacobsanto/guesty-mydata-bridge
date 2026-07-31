'use strict';

const { db } = require('../database');
const { searchUpdatedReservationIds, fetchReservation } = require('../guesty/client');
const { normalizeGuestyReservation } = require('../guesty/normalizer');
const { getCompanyAndListingByGuestyListingId } = require('../repositories/listings');
const { stageReservation } = require('./reservation-service');

const RELEVANT = new Set(['confirmed', 'checked_out', 'cancelled', 'canceled']);

function iso(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error(`${label} must be a valid ISO date-time`), { status: 400 });
  return date.toISOString();
}

async function getCursor() {
  return db('sync_cursors').where({ provider: 'guesty', cursor_key: 'reservations_last_updated' }).first();
}

async function saveCursor(value) {
  const row = { provider: 'guesty', cursor_key: 'reservations_last_updated', cursor_value: value, updated_at: db.fn.now() };
  await db('sync_cursors').insert(row).onConflict(['provider', 'cursor_key']).merge(row);
}

async function runGuestyReconciliation({
  from, to = new Date().toISOString(), searcher = searchUpdatedReservationIds, fetcher = fetchReservation,
} = {}) {
  const cursor = await getCursor();
  const overlapMs = Number(process.env.GUESTY_RECONCILIATION_OVERLAP_MINUTES || 10) * 60 * 1000;
  const initialLookbackMs = Number(process.env.GUESTY_RECONCILIATION_INITIAL_LOOKBACK_DAYS || 7) * 86400000;
  const end = iso(to, 'to');
  const startBase = from || cursor?.cursor_value || new Date(Date.parse(end) - initialLookbackMs).toISOString();
  const start = iso(new Date(Date.parse(startBase) - (cursor && !from ? overlapMs : 0)), 'from');
  const reservationIds = await searcher({ from: start, to: end });
  const results = [];
  let failures = 0;
  for (const reservationId of reservationIds) {
    try {
      const reservation = normalizeGuestyReservation(await fetcher(reservationId));
      if (!RELEVANT.has(reservation.status)) {
        results.push({ reservationId, status: reservation.status, skipped: true, reason: 'irrelevant_status' });
        continue;
      }
      const mapping = await getCompanyAndListingByGuestyListingId(reservation.listingId);
      if (!mapping || !mapping.company_active || !mapping.listing_active) {
        results.push({ reservationId, skipped: true, reason: 'unmapped_or_inactive_listing' });
        continue;
      }
      const snapshot = await stageReservation(reservation, mapping);
      results.push({ reservationId, skipped: false, snapshotId: snapshot.id });
    } catch (error) {
      failures += 1;
      results.push({ reservationId, skipped: true, error: error.message });
    }
  }
  if (failures === 0) await saveCursor(end);
  else throw Object.assign(new Error(`Guesty reconciliation failed for ${failures}/${reservationIds.length} reservations`), {
    status: 502, results, from: start, to: end,
  });
  return { from: start, to: end, discovered: reservationIds.length, staged: results.filter((row) => !row.skipped).length, results };
}

module.exports = { runGuestyReconciliation };

'use strict';

const { db } = require('../database');

const TABLE = 'guesty_reconciliation_inbox';

async function recordUnresolvedReservation({ reservationId, listingId = null, reason, error = null }, client = db) {
  const incrementAttempts = client.client.config.client === 'pg'
    ? client.raw('"guesty_reconciliation_inbox"."attempts" + 1')
    : client.raw('"attempts" + 1');
  const insert = {
    reservation_id: String(reservationId),
    listing_id: listingId ? String(listingId) : null,
    status: 'unresolved',
    reason: String(reason),
    attempts: 1,
    last_error: error ? String(error).slice(0, 4000) : null,
    first_seen_at: client.fn.now(),
    last_seen_at: client.fn.now(),
    resolved_at: null,
    created_at: client.fn.now(),
    updated_at: client.fn.now(),
  };
  await client(TABLE).insert(insert).onConflict('reservation_id').merge({
    listing_id: insert.listing_id,
    status: 'unresolved',
    reason: insert.reason,
    attempts: incrementAttempts,
    last_error: insert.last_error,
    last_seen_at: client.fn.now(),
    resolved_at: null,
    updated_at: client.fn.now(),
  });
  return client(TABLE).where({ reservation_id: insert.reservation_id }).first();
}

async function resolveUnresolvedReservation(reservationId, reason = 'staged', client = db) {
  await client(TABLE).where({ reservation_id: String(reservationId), status: 'unresolved' }).update({
    status: 'resolved',
    reason: String(reason),
    last_error: null,
    resolved_at: client.fn.now(),
    last_seen_at: client.fn.now(),
    updated_at: client.fn.now(),
  });
  return client(TABLE).where({ reservation_id: String(reservationId) }).first();
}

async function updateUnresolvedReservation({ reservationId, listingId = null, reason, error = null }, client = db) {
  await client(TABLE).where({ reservation_id: String(reservationId) }).update({
    listing_id: listingId ? String(listingId) : null,
    status: 'unresolved',
    reason: String(reason),
    last_error: error ? String(error).slice(0, 4000) : null,
    resolved_at: null,
    last_seen_at: client.fn.now(),
    updated_at: client.fn.now(),
  });
  return client(TABLE).where({ reservation_id: String(reservationId) }).first();
}

async function listReconciliationInbox({ status = 'unresolved', limit = 500 } = {}) {
  const query = db(TABLE).select('*').orderBy('first_seen_at').orderBy('id').limit(limit);
  if (status) query.where({ status });
  return query;
}

module.exports = {
  recordUnresolvedReservation,
  updateUnresolvedReservation,
  resolveUnresolvedReservation,
  listReconciliationInbox,
};

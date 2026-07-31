'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { insertedId } = require('../database-utils');

function fiscalHash(reservation) {
  const core = {
    reservationId: reservation.reservationId,
    listingId: reservation.listingId,
    status: reservation.status,
    source: reservation.source,
    platformKey: reservation.platformKey || null,
    sourceKey: reservation.sourceKey || null,
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    nights: reservation.nights,
    totalGross: reservation.financials?.totalGross,
    financialProfile: reservation.financialProfile ? {
      id: reservation.financialProfile.id,
      version: reservation.financialProfile.version,
      configHash: reservation.financialProfile.configHash,
      evidenceHash: reservation.financialProfile.evidenceHash,
    } : null,
    invoiceType: reservation.invoiceType || null,
    invoiceSeries: reservation.invoiceSeries || null,
    invoiceCounterpart: reservation.invoiceCounterpart || null,
    fiscalRevision: Number(reservation.fiscalRevision || 0),
  };
  return crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
}

function applySnapshotOverride(reservation, snapshot) {
  if (!snapshot) return reservation;
  const effective = {
    ...reservation,
    fiscalRevision: Number(snapshot.fiscal_revision || 0),
  };
  if (!snapshot.invoice_type_override) return effective;
  return {
    ...effective,
    invoiceType: snapshot.invoice_type_override,
    invoiceSeries: snapshot.invoice_series_override || undefined,
    invoiceCounterpart: snapshot.invoice_type_override === '2.1'
      ? {
          vatNumber: snapshot.counterpart_vat_override,
          country: snapshot.counterpart_country_override,
          name: snapshot.counterpart_name_override || null,
          branch: 0,
        }
      : undefined,
  };
}

async function upsertReservationSnapshot(reservation, billingContext) {
  const existing = await db('reservation_snapshots').where({ reservation_id: reservation.reservationId }).first();
  let effectiveReservation = applySnapshotOverride(reservation, existing);
  if (existing?.materialized_at && !effectiveReservation.financialProfile && existing.normalized_payload) {
    const previous = JSON.parse(existing.normalized_payload);
    if (previous.financialProfile) {
      effectiveReservation = {
        ...effectiveReservation,
        financialProfile: previous.financialProfile,
        financials: {
          ...effectiveReservation.financials,
          reconciliation: previous.financials?.reconciliation,
        },
      };
    }
  }
  const hash = fiscalHash(effectiveReservation);
  const data = {
    company_id: billingContext.company_id,
    listing_id: billingContext.listing_id,
    listing_id_guesty: effectiveReservation.listingId,
    status: effectiveReservation.status,
    source: effectiveReservation.source || null,
    platform_key: effectiveReservation.platformKey || null,
    source_key: effectiveReservation.sourceKey || null,
    check_in: effectiveReservation.checkIn,
    check_out: effectiveReservation.checkOut,
    payload_hash: hash,
    normalized_payload: JSON.stringify(effectiveReservation),
    financial_status: effectiveReservation.financialProfile?.status || 'pending',
    financial_profile_id: effectiveReservation.financialProfile?.id || null,
    financial_profile_version: effectiveReservation.financialProfile?.version || null,
    financial_profile_hash: effectiveReservation.financialProfile?.configHash || null,
    financial_evidence: effectiveReservation.financialProfile?.evidence
      ? JSON.stringify(effectiveReservation.financialProfile.evidence)
      : null,
    financial_error: effectiveReservation.financialProfile?.error || null,
    last_error: null,
    updated_at: db.fn.now(),
  };
  if (existing) {
    data.requires_review = Boolean(existing.materialized_at && existing.payload_hash !== hash);
    await db('reservation_snapshots').where({ id: existing.id }).update(data);
    return db('reservation_snapshots').where({ id: existing.id }).first();
  }
  const id = insertedId(await db('reservation_snapshots').insert({ reservation_id: reservation.reservationId, ...data }).returning('id'));
  return db('reservation_snapshots').where({ id }).first();
}

async function listDueReservationSnapshots(companyId, businessDate) {
  return db('reservation_snapshots')
    .where({ company_id: companyId })
    .whereIn('status', ['confirmed', 'checked_out'])
    .whereNull('materialized_at')
    .where('check_out', '<=', businessDate)
    .orderBy('check_out')
    .orderBy('id');
}

async function listReservationSnapshots(filters = {}) {
  const query = db('reservation_snapshots').select(
    'id', 'reservation_id', 'company_id', 'listing_id', 'listing_id_guesty',
    'status', 'source', 'platform_key', 'source_key', 'check_in', 'check_out', 'materialized_at',
    'financial_status', 'financial_profile_id', 'financial_profile_version',
    'financial_profile_hash', 'financial_error',
    'invoice_type_override', 'invoice_series_override', 'counterpart_vat_override',
    'counterpart_country_override', 'counterpart_name_override',
    'fiscal_revision', 'review_resolution', 'reviewed_at',
    'requires_review', 'last_error', 'created_at', 'updated_at'
  ).orderBy('updated_at', 'desc');
  if (filters.companyId) query.where({ company_id: filters.companyId });
  if (filters.requiresReview !== undefined) query.where({ requires_review: filters.requiresReview });
  if (filters.materialized === true) query.whereNotNull('materialized_at');
  if (filters.materialized === false) query.whereNull('materialized_at');
  return query;
}

async function setFiscalOverride(reservationId, override) {
  const existing = await db('reservation_snapshots').where({ reservation_id: reservationId }).first();
  if (!existing) return null;
  if (existing.materialized_at) {
    const error = new Error('Fiscal override is locked after documents are materialized');
    error.status = 409;
    throw error;
  }
  const reservation = JSON.parse(existing.normalized_payload);
  reservation.invoiceType = override.invoiceType;
  reservation.invoiceSeries = override.invoiceSeries || undefined;
  reservation.invoiceCounterpart = override.invoiceCounterpart || undefined;
  await db('reservation_snapshots').where({ id: existing.id }).update({
    invoice_type_override: override.invoiceType,
    invoice_series_override: override.invoiceSeries || null,
    counterpart_vat_override: override.invoiceCounterpart?.vatNumber || null,
    counterpart_country_override: override.invoiceCounterpart?.country || null,
    counterpart_name_override: override.invoiceCounterpart?.name || null,
    normalized_payload: JSON.stringify(reservation),
    payload_hash: fiscalHash(reservation),
    requires_review: false,
    last_error: null,
    updated_at: db.fn.now(),
  });
  return db('reservation_snapshots').where({ id: existing.id }).first();
}

async function clearFiscalOverride(reservationId) {
  const existing = await db('reservation_snapshots').where({ reservation_id: reservationId }).first();
  if (!existing) return null;
  if (existing.materialized_at) {
    const error = new Error('Fiscal override is locked after documents are materialized');
    error.status = 409;
    throw error;
  }
  const reservation = JSON.parse(existing.normalized_payload);
  delete reservation.invoiceType;
  delete reservation.invoiceSeries;
  delete reservation.invoiceCounterpart;
  await db('reservation_snapshots').where({ id: existing.id }).update({
    invoice_type_override: null,
    invoice_series_override: null,
    counterpart_vat_override: null,
    counterpart_country_override: null,
    counterpart_name_override: null,
    normalized_payload: JSON.stringify(reservation),
    payload_hash: fiscalHash(reservation),
    updated_at: db.fn.now(),
  });
  return db('reservation_snapshots').where({ id: existing.id }).first();
}

async function reopenSnapshotForReissue(reservationId, resolution) {
  return db.transaction(async (trx) => {
    let snapshotQuery = trx('reservation_snapshots').where({ reservation_id: reservationId });
    if (trx.client.config.client === 'pg') snapshotQuery = snapshotQuery.forUpdate();
    const snapshot = await snapshotQuery.first();
    if (!snapshot) return null;
    if (!snapshot.materialized_at || !snapshot.requires_review) {
      const error = new Error('Reservation is not a materialized review candidate'); error.status = 409; throw error;
    }
    if (['cancelled', 'canceled'].includes(String(snapshot.status).toLowerCase())) {
      const error = new Error('A cancelled reservation cannot be reissued'); error.status = 409; throw error;
    }
    const documents = await trx('fiscal_documents').where({ reservation_id: reservationId });
    if (!documents.length || documents.some((document) => document.status !== 'cancelled')) {
      const error = new Error('All previous reservation documents must be cancelled before reissue'); error.status = 409; throw error;
    }
    const revision = Number(snapshot.fiscal_revision || 0) + 1;
    const reservation = JSON.parse(snapshot.normalized_payload);
    reservation.fiscalRevision = revision;
    await trx('reservation_snapshots').where({ id: snapshot.id }).update({
      fiscal_revision: revision,
      normalized_payload: JSON.stringify(reservation),
      payload_hash: fiscalHash(reservation),
      materialized_at: null,
      requires_review: false,
      review_resolution: String(resolution).slice(0, 1000),
      reviewed_at: trx.fn.now(),
      last_error: null,
      updated_at: trx.fn.now(),
    });
    return trx('reservation_snapshots').where({ id: snapshot.id }).first();
  });
}

async function resolveCancelledSnapshot(reservationId, resolution) {
  return db.transaction(async (trx) => {
    let snapshotQuery = trx('reservation_snapshots').where({ reservation_id: reservationId });
    if (trx.client.config.client === 'pg') snapshotQuery = snapshotQuery.forUpdate();
    const snapshot = await snapshotQuery.first();
    if (!snapshot) return null;
    if (!['cancelled', 'canceled'].includes(String(snapshot.status).toLowerCase()) || !snapshot.requires_review) {
      const error = new Error('Reservation is not a cancelled review candidate'); error.status = 409; throw error;
    }
    const documents = await trx('fiscal_documents').where({ reservation_id: reservationId });
    if (documents.some((document) => document.status !== 'cancelled')) {
      const error = new Error('All reservation documents must be cancelled before resolving the review'); error.status = 409; throw error;
    }
    await trx('reservation_snapshots').where({ id: snapshot.id }).update({
      requires_review: false,
      review_resolution: String(resolution).slice(0, 1000),
      reviewed_at: trx.fn.now(),
      last_error: null,
      updated_at: trx.fn.now(),
    });
    return trx('reservation_snapshots').where({ id: snapshot.id }).first();
  });
}

async function markSnapshotMaterialized(id) {
  await db('reservation_snapshots').where({ id }).update({ materialized_at: db.fn.now(), requires_review: false, last_error: null, updated_at: db.fn.now() });
}

async function markSnapshotError(id, error) {
  await db('reservation_snapshots').where({ id }).update({
    requires_review: true,
    financial_status: 'review',
    financial_error: String(error).slice(0, 4000),
    last_error: String(error).slice(0, 4000),
    updated_at: db.fn.now(),
  });
}

module.exports = { fiscalHash, applySnapshotOverride, upsertReservationSnapshot, listDueReservationSnapshots, listReservationSnapshots, setFiscalOverride, clearFiscalOverride, reopenSnapshotForReissue, resolveCancelledSnapshot, markSnapshotMaterialized, markSnapshotError };

'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { insertedId } = require('../database-utils');

function fiscalHash(reservation) {
  const fiscalLines = (reservation.fiscalInvoiceItems || reservation.financials?.invoiceItems || [])
    .map((line) => ({
      id: String(line.id || ''), normalType: String(line.normalType || ''),
      origin: line.origin || null, title: line.title || null,
      secondIdentifier: line.secondIdentifier || null,
      totalPrice: Number(line.totalPrice), listingId: line.listingId || null,
      stayIndex: line.stayIndex ?? null,
      isDeducted: line.isDeducted ?? null, isDeductedV2: line.isDeductedV2 ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
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
    guestStayStatus: reservation.guestStayStatus || null,
    stayEvidence: reservation.stayEvidence || null,
    fiscalLines,
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
          branch: snapshot.counterpart_branch_override ?? 0,
        }
      : undefined,
  };
}

async function upsertReservationSnapshot(reservation, billingContext, options = {}) {
  const execute = async (trx) => {
  let existing = await trx('reservation_snapshots').where({ reservation_id: reservation.reservationId }).forUpdate().first();
  if (existing && (Number(existing.company_id) !== Number(billingContext.company_id)
      || Number(existing.listing_id) !== Number(billingContext.listing_id)
      || String(existing.listing_id_guesty) !== String(reservation.listingId))) {
    const error = new Error('Guesty reservation id is already bound to a different company or listing');
    error.status = 409;
    error.code = 'RESERVATION_OWNERSHIP_COLLISION';
    throw error;
  }
  if (options.expectedGeneration !== undefined
      && Number(existing?.generation || 0) !== Number(options.expectedGeneration)) {
    const error = new Error('Reservation changed while fiscal materialization was in progress');
    error.status = 409;
    error.code = 'RESERVATION_SNAPSHOT_CHANGED';
    throw error;
  }
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
    generation: Number(existing?.generation || 0) + 1,
    updated_at: trx.fn.now(),
  };
  if (existing) {
    data.requires_review = existing.materialized_at
      ? Boolean(existing.requires_review || existing.payload_hash !== hash)
      : false;
    const changed = await trx('reservation_snapshots')
      .where({ id: existing.id, generation: Number(existing.generation || 1) })
      .update(data);
    if (changed !== 1) {
      const error = new Error('Reservation changed while snapshot update was in progress');
      error.status = 409;
      error.code = 'RESERVATION_SNAPSHOT_CHANGED';
      throw error;
    }
    return trx('reservation_snapshots').where({ id: existing.id }).first();
  }
  const inserted = await trx('reservation_snapshots')
    .insert({ reservation_id: reservation.reservationId, ...data })
    .onConflict('reservation_id')
    .ignore()
    .returning('id');
  const id = insertedId(inserted);
  if (id) return trx('reservation_snapshots').where({ id }).first();
  existing = await trx('reservation_snapshots').where({ reservation_id: reservation.reservationId }).forUpdate().first();
  const error = new Error('Reservation snapshot was created concurrently; retry with the current generation');
  error.status = 409;
  error.code = 'RESERVATION_SNAPSHOT_CHANGED';
  throw error;
  };
  if (options.transaction) return execute(options.transaction);
  return db.transaction(execute);
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
    'counterpart_country_override', 'counterpart_name_override', 'counterpart_branch_override',
    'fiscal_revision', 'review_resolution', 'reviewed_at', 'generation',
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
    counterpart_branch_override: override.invoiceCounterpart?.branch ?? 0,
    normalized_payload: JSON.stringify(reservation),
    payload_hash: fiscalHash(reservation),
    requires_review: false,
    last_error: null,
    updated_at: db.fn.now(),
    generation: db.raw('generation + 1'),
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
    counterpart_branch_override: null,
    normalized_payload: JSON.stringify(reservation),
    payload_hash: fiscalHash(reservation),
    updated_at: db.fn.now(),
    generation: db.raw('generation + 1'),
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
    if (!documents.length || documents.some((document) => document.status !== 'cancelled'
        || (document.mydata_mark && (document.cancellation_verification_status !== 'verified' || !document.cancellation_mark)))) {
      const error = new Error('All previous reservation documents must have verified myDATA cancellation before reissue'); error.status = 409; throw error;
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
      generation: trx.raw('generation + 1'),
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
    if (documents.some((document) => document.status !== 'cancelled'
        || (document.mydata_mark && (document.cancellation_verification_status !== 'verified' || !document.cancellation_mark)))) {
      const error = new Error('All reservation documents must have verified myDATA cancellation before resolving the review'); error.status = 409; throw error;
    }
    await trx('reservation_snapshots').where({ id: snapshot.id }).update({
      requires_review: false,
      review_resolution: String(resolution).slice(0, 1000),
      reviewed_at: trx.fn.now(),
      last_error: null,
      updated_at: trx.fn.now(),
      generation: trx.raw('generation + 1'),
    });
    return trx('reservation_snapshots').where({ id: snapshot.id }).first();
  });
}

async function resolveCancelledSnapshotAutomatically(reservationId, client = db) {
  const execute = async (trx) => {
    let snapshotQuery = trx('reservation_snapshots').where({ reservation_id: reservationId });
    if (trx.client.config.client === 'pg') snapshotQuery = snapshotQuery.forUpdate();
    const snapshot = await snapshotQuery.first();
    if (!snapshot || !['cancelled', 'canceled'].includes(String(snapshot.status).toLowerCase())) return null;
    if (!snapshot.requires_review) return snapshot;
    const documents = await trx('fiscal_documents').where({ reservation_id: reservationId });
    const settled = documents.every((document) => document.status === 'cancelled'
      && (!document.mydata_mark || (document.cancellation_verification_status === 'verified' && document.cancellation_mark)));
    if (!settled) return null;
    await trx('reservation_snapshots').where({ id: snapshot.id, requires_review: true }).update({
      requires_review: false,
      review_resolution: 'Automatic Guesty cancellation completed and verified through myDATA',
      reviewed_at: trx.fn.now(),
      last_error: null,
      updated_at: trx.fn.now(),
      generation: trx.raw('generation + 1'),
    });
    return trx('reservation_snapshots').where({ id: snapshot.id }).first();
  };
  if (client !== db) return execute(client);
  return db.transaction(execute);
}

async function markSnapshotMaterialized(id, expectedGeneration, options = {}) {
  const client = options.transaction || db;
  const changed = await client('reservation_snapshots').where({ id, generation: expectedGeneration }).update({
    materialized_at: client.fn.now(), requires_review: false, last_error: null,
    generation: client.raw('generation + 1'), updated_at: client.fn.now(),
  });
  if (changed !== 1) {
    const error = new Error('Reservation changed before materialization could be committed');
    error.status = 409;
    error.code = 'RESERVATION_SNAPSHOT_CHANGED';
    throw error;
  }
}

async function markSnapshotError(id, error, expectedGeneration) {
  let query = db('reservation_snapshots').where({ id });
  if (expectedGeneration !== undefined) query = query.where({ generation: expectedGeneration });
  await query.update({
    requires_review: true,
    financial_status: 'review',
    financial_error: String(error).slice(0, 4000),
    last_error: String(error).slice(0, 4000),
    generation: db.raw('generation + 1'),
    updated_at: db.fn.now(),
  });
}

module.exports = { fiscalHash, applySnapshotOverride, upsertReservationSnapshot, listDueReservationSnapshots, listReservationSnapshots, setFiscalOverride, clearFiscalOverride, reopenSnapshotForReissue, resolveCancelledSnapshot, resolveCancelledSnapshotAutomatically, markSnapshotMaterialized, markSnapshotError };

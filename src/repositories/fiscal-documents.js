'use strict';

const { db } = require('../database');
const { insertedId } = require('../database-utils');

async function nextDocumentNumber(trx, companyId, documentType, series) {
  await trx('document_sequences').insert({
      company_id: companyId,
      document_type: documentType,
      series,
      last_number: 0,
    }).onConflict(['company_id', 'document_type', 'series']).ignore();
  let sequenceQuery = trx('document_sequences')
    .where({ company_id: companyId, document_type: documentType, series });
  if (trx.client.config.client === 'pg') sequenceQuery = sequenceQuery.forUpdate();
  const sequence = await sequenceQuery.first();

  const next = Number(sequence.last_number) + 1;
  await trx('document_sequences').where({ id: sequence.id }).update({
    last_number: next,
    updated_at: trx.fn.now(),
  });
  return next;
}

async function insertDocument(trx, { documentKey, companyId, listingId, reservationId, documentKind, documentType, series, issueDate, amounts, sourcePayload, relatedDocumentId = null, correlatedMark = null, buildXml }) {
  const existing = await trx('fiscal_documents').where({ document_key: documentKey }).first();
  if (existing) return { document: existing, created: false };

  const aa = await nextDocumentNumber(trx, companyId, documentType, series);
  const xmlPayload = buildXml(aa);
  const result = await trx('fiscal_documents').insert({
    document_key: documentKey,
    company_id: companyId,
    listing_id: listingId,
    reservation_id: reservationId,
    document_kind: documentKind,
    document_type: documentType,
    series,
    aa,
    issue_date: issueDate,
    related_document_id: relatedDocumentId,
    correlated_mark: correlatedMark,
    net_value: amounts.netValue || 0,
    vat_amount: amounts.vatAmount || 0,
    other_taxes_amount: amounts.otherTaxesAmount || 0,
    gross_value: amounts.grossValue || 0,
    status: 'pending',
    xml_payload: xmlPayload,
    source_payload: JSON.stringify(sourcePayload || {}),
  }).returning('id');
  const id = insertedId(result);
  return { document: await trx('fiscal_documents').where({ id }).first(), created: true };
}

async function createDocumentOnce(input) {
  try {
    if (input.transaction) return await insertDocument(input.transaction, input);
    return await db.transaction((trx) => insertDocument(trx, input));
  } catch (error) {
    const duplicate = error.code === '23505' || String(error.code || '').startsWith('SQLITE_CONSTRAINT');
    if (duplicate && !input.transaction) {
      const existing = await findDocumentByKey(input.documentKey);
      if (existing) return { document: existing, created: false };
    }
    throw error;
  }
}

async function findDocumentByKey(documentKey) {
  return db('fiscal_documents').where({ document_key: documentKey }).first();
}

async function sumActiveRelatedCredits(originalDocumentId, client = db) {
  const row = await client('fiscal_documents')
    .where({ related_document_id: originalDocumentId })
    .whereIn('document_type', ['5.1', '11.4'])
    .whereNot({ status: 'cancelled' })
    .sum({ total: 'gross_value' })
    .first();
  return Number(row?.total || 0);
}

async function listDocuments(filters = {}) {
  const query = db('fiscal_documents as d')
    .join('companies as c', 'd.company_id', 'c.id')
    .join('listings as l', 'd.listing_id', 'l.id')
    .select(
      'd.id', 'd.document_key', 'd.company_id', 'd.listing_id', 'd.reservation_id',
      'd.document_kind', 'd.document_type', 'd.series', 'd.aa', 'd.issue_date',
      'd.related_document_id', 'd.correlated_mark', 'd.net_value', 'd.vat_amount',
      'd.other_taxes_amount', 'd.gross_value', 'd.status', 'd.mydata_mark',
      'd.mydata_uid', 'd.mydata_qr_url', 'd.cancellation_mark', 'd.cancelled_at',
      'd.mydata_environment',
      'd.cancellation_status', 'd.cancellation_error', 'd.cancellation_attempt_at',
      'd.cancellation_retryable', 'd.cancellation_uncertain',
      'd.verification_status', 'd.verified_at', 'd.verification_error',
      'd.error_message', 'd.attempt_count', 'd.retryable', 'd.transmission_uncertain',
      'd.last_attempt_at', 'd.sent_at',
      'd.created_at', 'd.updated_at', 'c.company_name', 'c.vat_number',
      'l.listing_id_guesty',
    )
    .orderBy('d.issue_date', 'desc')
    .orderBy('d.id', 'desc');
  if (filters.companyId) query.where('d.company_id', filters.companyId);
  if (filters.status) query.where('d.status', filters.status);
  if (filters.businessDate) query.where('d.issue_date', '<=', filters.businessDate);
  return query;
}

async function getDocumentById(id) {
  return db('fiscal_documents').where({ id }).first();
}

async function listTransmittableDocuments(companyId, businessDate, maxAttempts = 5) {
  return db('fiscal_documents as d')
    .where({ 'd.company_id': companyId })
    .whereIn('d.status', ['pending', 'failed'])
    .where({ 'd.retryable': true, 'd.transmission_uncertain': false })
    .where('d.issue_date', '<=', businessDate)
    .where('d.attempt_count', '<', maxAttempts)
    .whereNotExists(db('reservation_snapshots as review')
      .select(db.raw('1')).whereRaw('review.reservation_id = d.reservation_id').where({ 'review.requires_review': true }))
    .where((eligible) => eligible
      .whereNotIn('d.document_kind', ['service_invoice', 'service_receipt', 'climate_fee_receipt'])
      .orWhereExists(db('reservation_snapshots as ready')
        .select(db.raw('1')).whereRaw('ready.reservation_id = d.reservation_id').whereNotNull('ready.materialized_at')))
    .select('d.*')
    .orderBy('d.issue_date', 'asc')
    .orderBy('d.id', 'asc');
}

async function claimDocument(id) {
  const changed = await db('fiscal_documents')
    .where({ id })
    .whereIn('status', ['pending', 'failed'])
    .where({ retryable: true, transmission_uncertain: false })
    .whereNotExists(db('reservation_snapshots as review')
      .select(db.raw('1')).whereRaw('review.reservation_id = fiscal_documents.reservation_id').where({ 'review.requires_review': true }))
    .where((eligible) => eligible
      .whereNotIn('document_kind', ['service_invoice', 'service_receipt', 'climate_fee_receipt'])
      .orWhereExists(db('reservation_snapshots as ready')
        .select(db.raw('1')).whereRaw('ready.reservation_id = fiscal_documents.reservation_id').whereNotNull('ready.materialized_at')))
    .where({ transmission_uncertain: false })
    .update({
      status: 'transmitting',
      attempt_count: db.raw('attempt_count + 1'),
      last_attempt_at: db.fn.now(),
      error_message: null,
      updated_at: db.fn.now(),
    });
  return changed === 1;
}

async function listBlockedDueDocuments(companyId, businessDate, maxAttempts = 5) {
  return db('fiscal_documents as d')
    .where({ 'd.company_id': companyId })
    .where('d.issue_date', '<=', businessDate)
    .where((blocked) => blocked
      .where((failed) => failed.where({ 'd.status': 'failed' }).andWhere((reason) => reason
        .where({ 'd.retryable': false })
        .orWhere({ 'd.transmission_uncertain': true })
        .orWhere('d.attempt_count', '>=', maxAttempts)))
      .orWhereExists(db('reservation_snapshots as review')
        .select(db.raw('1')).whereRaw('review.reservation_id = d.reservation_id').where({ 'review.requires_review': true })))
    .select('d.*')
    .orderBy('d.issue_date').orderBy('d.id');
}

async function listInFlightDocuments(companyId, businessDate) {
  return db('fiscal_documents')
    .where({ company_id: companyId, status: 'transmitting' })
    .where('issue_date', '<=', businessDate)
    .orderBy('issue_date', 'asc')
    .orderBy('id', 'asc');
}

async function markDocumentSent(id, response) {
  await db('fiscal_documents').where({ id }).update({
    status: 'sent',
    mydata_mark: response.mark,
    mydata_uid: response.uid || null,
    mydata_qr_url: response.qrUrl || null,
    mydata_response: JSON.stringify(response.raw || response),
    mydata_environment: process.env.MYDATA_ENV || 'sandbox',
    sent_at: db.fn.now(),
    verification_status: 'pending',
    verification_error: null,
    retryable: false,
    transmission_uncertain: false,
    updated_at: db.fn.now(),
  });
}

async function listUnverifiedDocuments(companyId, businessDate) {
  return db('fiscal_documents')
    .where({ company_id: companyId, status: 'sent' })
    .whereNot({ verification_status: 'verified' })
    .where('issue_date', '<=', businessDate)
    .whereNotNull('mydata_mark')
    .orderBy('issue_date', 'asc')
    .orderBy('id', 'asc');
}

async function markDocumentVerified(id) {
  await db('fiscal_documents').where({ id }).update({
    verification_status: 'verified',
    verification_error: null,
    verified_at: db.fn.now(),
    updated_at: db.fn.now(),
  });
}

async function markVerificationFailed(id, message) {
  await db('fiscal_documents').where({ id }).update({
    verification_status: 'failed',
    verification_error: String(message).slice(0, 4000),
    updated_at: db.fn.now(),
  });
}

async function markDocumentFailed(id, errorMessage, { retryable = false, transmissionUncertain = false } = {}) {
  await db('fiscal_documents').where({ id }).update({
    status: 'failed',
    retryable: Boolean(retryable),
    transmission_uncertain: Boolean(transmissionUncertain),
    error_message: String(errorMessage).slice(0, 4000),
    updated_at: db.fn.now(),
  });
}

async function quarantineStaleTransmissions(companyId, staleMinutes = 60) {
  const minutes = Number(staleMinutes);
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error('staleMinutes must be a positive integer');
  const staleBefore = new Date(Date.now() - minutes * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return db('fiscal_documents')
    .where({ company_id: companyId, status: 'transmitting' })
    .where('last_attempt_at', '<', staleBefore)
    .update({
      status: 'failed',
      retryable: false,
      transmission_uncertain: true,
      error_message: 'Transmission outcome is uncertain after an interrupted myDATA request; reconcile with a confirmed MARK before any resend',
      updated_at: db.fn.now(),
    });
}

async function claimDocumentCancellation(id) {
  return db.transaction(async (trx) => {
    let documentQuery = trx('fiscal_documents').where({ id });
    if (trx.client.config.client === 'pg') documentQuery = documentQuery.forUpdate();
    const document = await documentQuery.first();
    if (!document || document.status !== 'sent' || !document.mydata_mark) return false;
    const activeCredits = await trx('fiscal_documents')
      .where({ related_document_id: document.id })
      .whereIn('document_type', ['5.1', '11.4'])
      .whereNot({ status: 'cancelled' })
      .first('id');
    if (activeCredits) {
      const error = new Error('Cancel all active credit documents before cancelling the original');
      error.status = 409;
      throw error;
    }
    const eligible = ['none', null].includes(document.cancellation_status)
      || (document.cancellation_status === 'failed' && document.cancellation_retryable && !document.cancellation_uncertain);
    if (!eligible) return false;
    await trx('fiscal_documents').where({ id: document.id }).update({
      cancellation_status: 'transmitting', cancellation_error: null,
      cancellation_uncertain: false,
      cancellation_attempt_at: trx.fn.now(), updated_at: trx.fn.now(),
    });
    return true;
  });
}

async function quarantineStaleCancellations(staleMinutes = 60) {
  const staleBefore = new Date(Date.now() - Number(staleMinutes) * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return db('fiscal_documents').where({ status: 'sent', cancellation_status: 'transmitting' })
    .where('cancellation_attempt_at', '<', staleBefore)
    .update({
      cancellation_status: 'failed', cancellation_retryable: false, cancellation_uncertain: true,
      cancellation_error: 'Cancellation outcome is uncertain after an interrupted myDATA request; reconcile before retry',
      updated_at: db.fn.now(),
    });
}

async function markCancellationFailed(id, errorMessage, { retryable = false, uncertain = false } = {}) {
  await db('fiscal_documents').where({ id, status: 'sent', cancellation_status: 'transmitting' }).update({
    cancellation_status: 'failed',
    cancellation_retryable: Boolean(retryable),
    cancellation_uncertain: Boolean(uncertain),
    cancellation_error: String(errorMessage).slice(0, 4000),
    updated_at: db.fn.now(),
  });
}

async function cancelUnsentDocument(id) {
  const changed = await db('fiscal_documents')
    .where({ id })
    .whereIn('status', ['pending', 'failed'])
    .whereNull('mydata_mark')
    .update({
      status: 'cancelled',
      cancellation_status: 'cancelled',
      cancelled_at: db.fn.now(),
      cancellation_error: null,
      error_message: null,
      updated_at: db.fn.now(),
    });
  return changed === 1;
}

async function markDocumentCancelled(id, cancellationMark = null) {
  await db('fiscal_documents').where({ id }).update({
    status: 'cancelled',
    cancellation_status: 'cancelled',
    cancellation_mark: cancellationMark,
    cancelled_at: db.fn.now(),
    cancellation_error: null,
    cancellation_retryable: false,
    cancellation_uncertain: false,
    error_message: null,
    updated_at: db.fn.now(),
  });
  return getDocumentById(id);
}

async function cancelPendingReservationDocuments(reservationId) {
  return db('fiscal_documents')
    .where({ reservation_id: reservationId })
    .whereIn('status', ['pending', 'failed'])
    .where({ transmission_uncertain: false })
    .update({ status: 'cancelled', cancellation_status: 'cancelled', cancelled_at: db.fn.now(), updated_at: db.fn.now() });
}

module.exports = {
  createDocumentOnce,
  findDocumentByKey,
  sumActiveRelatedCredits,
  listDocuments,
  getDocumentById,
  listTransmittableDocuments,
  listBlockedDueDocuments,
  listInFlightDocuments,
  claimDocument,
  markDocumentSent,
  markDocumentFailed,
  quarantineStaleTransmissions,
  claimDocumentCancellation,
  quarantineStaleCancellations,
  markCancellationFailed,
  cancelUnsentDocument,
  markDocumentCancelled,
  cancelPendingReservationDocuments,
  listUnverifiedDocuments,
  markDocumentVerified,
  markVerificationFailed,
};

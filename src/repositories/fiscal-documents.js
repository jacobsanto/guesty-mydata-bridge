'use strict';

const crypto = require('crypto');
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
  const targetEnvironment = process.env.MYDATA_ENV || 'sandbox';
  if (!['sandbox', 'production'].includes(targetEnvironment)) throw new Error('MYDATA_ENV must be sandbox or production');
  const existing = await trx('fiscal_documents').where({ document_key: documentKey }).first();
  if (existing) {
    if (existing.target_environment !== targetEnvironment) {
      const error = new Error(`Fiscal document key already belongs to ${existing.target_environment || 'legacy/unknown'} environment`);
      error.status = 409;
      throw error;
    }
    return { document: existing, created: false };
  }

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
    target_environment: targetEnvironment,
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
      if (existing) {
        const targetEnvironment = process.env.MYDATA_ENV || 'sandbox';
        if (existing.target_environment !== targetEnvironment) {
          throw Object.assign(new Error(`Fiscal document key already belongs to ${existing.target_environment || 'legacy/unknown'} environment`), { status: 409 });
        }
        return { document: existing, created: false };
      }
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
      'd.mydata_environment', 'd.target_environment',
      'd.cancellation_status', 'd.cancellation_error', 'd.cancellation_attempt_at',
      'd.cancellation_retryable', 'd.cancellation_uncertain',
      'd.cancellation_verification_status', 'd.cancellation_verified_at',
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
  const targetEnvironment = process.env.MYDATA_ENV || 'sandbox';
  return db('fiscal_documents as d')
    .where({ 'd.company_id': companyId })
    .whereIn('d.status', ['pending', 'failed'])
    .where({ 'd.retryable': true, 'd.transmission_uncertain': false })
    .where({ 'd.target_environment': targetEnvironment })
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
  const transmissionToken = crypto.randomUUID();
  const targetEnvironment = process.env.MYDATA_ENV || 'sandbox';
  const changed = await db('fiscal_documents')
    .where({ id })
    .whereIn('status', ['pending', 'failed'])
    .where({ retryable: true, transmission_uncertain: false, target_environment: targetEnvironment })
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
      transmission_token: transmissionToken,
      updated_at: db.fn.now(),
    });
  return changed === 1 ? transmissionToken : null;
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

async function hasDueFiscalWork(companyId, businessDate, client = db) {
  const row = await client('fiscal_documents as d')
    .leftJoin('reservation_snapshots as review', 'review.reservation_id', 'd.reservation_id')
    .where({ 'd.company_id': companyId })
    .where('d.issue_date', '<=', businessDate)
    .where((due) => due
      .whereIn('d.status', ['pending', 'failed', 'transmitting'])
      .orWhere((sent) => sent.where({ 'd.status': 'sent' }).andWhere((verification) => verification
        .whereNot({ 'd.verification_status': 'verified' })
        .orWhereNull('d.verification_status')))
      .orWhere({ 'review.requires_review': true }))
    .first('d.id');
  if (row) return true;
  const snapshot = await client('reservation_snapshots')
    .where({ company_id: companyId, requires_review: false })
    .whereNull('materialized_at')
    .where('check_out', '<=', businessDate)
    .first('id');
  return Boolean(snapshot);
}

async function markDocumentSent(id, response, { attemptToken = null, reconciled = false } = {}) {
  if (!response?.mark) throw new Error('myDATA response MARK is required');
  return db.transaction(async (trx) => {
    const document = await trx('fiscal_documents').where({ id }).forUpdate().first();
    if (!document) throw new Error('Fiscal document not found');
    const incomingMark = String(response.mark);
    const currentEnvironment = process.env.MYDATA_ENV || 'sandbox';
    if (document.target_environment !== currentEnvironment) {
      const error = new Error('Fiscal document target environment no longer matches runtime');
      error.status = 409;
      throw error;
    }
    const existingMark = document.mydata_mark == null ? null : String(document.mydata_mark);

    // An identical late response is useful evidence, but it must never reset a
    // verified or cancelled lifecycle back to sent/pending.
    if (existingMark) {
      if (existingMark !== incomingMark) {
        const error = new Error(`Conflicting myDATA MARK for fiscal document ${id}`);
        error.status = 409;
        throw error;
      }
      if (document.status === 'sent' || document.status === 'cancelled') {
        await trx('fiscal_documents').where({ id }).update({
          mydata_uid: document.mydata_uid || response.uid || null,
          mydata_qr_url: document.mydata_qr_url || response.qrUrl || null,
          updated_at: trx.fn.now(),
        });
        return trx('fiscal_documents').where({ id }).first();
      }
    }

    const ownsAttempt = attemptToken && document.transmission_token === attemptToken
      && (document.status === 'transmitting'
        || (document.status === 'failed' && Boolean(document.transmission_uncertain)));
    const canReconcile = reconciled && Boolean(document.transmission_uncertain)
      && ['failed', 'transmitting'].includes(document.status);
    if (!ownsAttempt && !canReconcile) {
      const error = new Error('Transmission attempt no longer owns this fiscal document');
      error.status = 409;
      throw error;
    }
    await trx('fiscal_documents').where({ id }).update({
      status: 'sent',
      mydata_mark: incomingMark,
      mydata_uid: response.uid || null,
      mydata_qr_url: response.qrUrl || null,
      mydata_response: JSON.stringify(response.raw || response),
      mydata_environment: currentEnvironment,
      sent_at: trx.fn.now(),
      verification_status: 'pending',
      verification_error: null,
      retryable: false,
      transmission_uncertain: false,
      transmission_token: null,
      updated_at: trx.fn.now(),
    });
    return trx('fiscal_documents').where({ id }).first();
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

async function markDocumentFailed(id, errorMessage, { retryable = false, transmissionUncertain = false, attemptToken } = {}) {
  if (!attemptToken) throw new Error('Transmission attempt token is required to record failure');
  const changed = await db('fiscal_documents').where({ id, status: 'transmitting', transmission_token: attemptToken }).update({
    status: 'failed',
    retryable: Boolean(retryable),
    transmission_uncertain: Boolean(transmissionUncertain),
    error_message: String(errorMessage).slice(0, 4000),
    updated_at: db.fn.now(),
  });
  if (changed !== 1) {
    const error = new Error('Transmission attempt no longer owns this fiscal document');
    error.status = 409;
    throw error;
  }
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

async function claimDocumentCancellation(id, expectedEnvironment = process.env.MYDATA_ENV || 'sandbox') {
  const cancellationToken = crypto.randomUUID();
  return db.transaction(async (trx) => {
    let documentQuery = trx('fiscal_documents').where({ id });
    if (trx.client.config.client === 'pg') documentQuery = documentQuery.forUpdate();
    const document = await documentQuery.first();
    if (!document || document.status !== 'sent' || !document.mydata_mark) return null;
    if (document.mydata_environment !== expectedEnvironment || document.target_environment !== expectedEnvironment) {
      const error = new Error('Fiscal document myDATA environment changed or does not match runtime');
      error.status = 409;
      throw error;
    }
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
    if (!eligible) return null;
    await trx('fiscal_documents').where({ id: document.id }).update({
      cancellation_status: 'transmitting', cancellation_error: null,
      cancellation_uncertain: false,
      cancellation_token: cancellationToken,
      cancellation_attempt_at: trx.fn.now(), updated_at: trx.fn.now(),
    });
    return cancellationToken;
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

async function markCancellationFailed(id, errorMessage, { retryable = false, uncertain = false, attemptToken } = {}) {
  if (!attemptToken) throw new Error('Cancellation attempt token is required to record failure');
  const changed = await db('fiscal_documents').where({
    id, status: 'sent', cancellation_status: 'transmitting', cancellation_token: attemptToken,
  }).update({
    cancellation_status: 'failed',
    cancellation_retryable: Boolean(retryable),
    cancellation_uncertain: Boolean(uncertain),
    cancellation_error: String(errorMessage).slice(0, 4000),
    updated_at: db.fn.now(),
  });
  if (changed !== 1) throw Object.assign(new Error('Cancellation attempt no longer owns this fiscal document'), { status: 409 });
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

async function markDocumentCancelled(id, cancellationMark = null, {
  attemptToken = null, reconciled = false, response = null, verificationResponse = null,
  expectedEnvironment = process.env.MYDATA_ENV || 'sandbox',
} = {}) {
  if (!cancellationMark) throw new Error('Cancellation MARK is required');
  return db.transaction(async (trx) => {
    const document = await trx('fiscal_documents').where({ id }).forUpdate().first();
    if (!document) throw Object.assign(new Error('Fiscal document not found'), { status: 404 });
    if (document.mydata_environment !== expectedEnvironment || document.target_environment !== expectedEnvironment) {
      throw Object.assign(new Error('Fiscal document myDATA environment changed or does not match runtime'), { status: 409 });
    }
    if (document.status === 'cancelled') {
      if (String(document.cancellation_mark) !== String(cancellationMark)) {
        throw Object.assign(new Error('Conflicting cancellation MARK'), { status: 409 });
      }
      if (reconciled && verificationResponse && document.cancellation_verification_status !== 'verified') {
        await trx('fiscal_documents').where({ id, cancellation_mark: String(cancellationMark) }).update({
          cancellation_verification_status: 'verified',
          cancellation_verification_response: JSON.stringify(verificationResponse),
          cancellation_verified_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        });
        return trx('fiscal_documents').where({ id }).first();
      }
      return document;
    }
    const ownsAttempt = attemptToken && document.cancellation_token === attemptToken
      && (document.cancellation_status === 'transmitting'
        || (document.cancellation_status === 'failed' && Boolean(document.cancellation_uncertain)));
    const canReconcile = reconciled && document.status === 'sent'
      && document.cancellation_status === 'failed' && !document.cancellation_mark;
    if (!ownsAttempt && !canReconcile) {
      throw Object.assign(new Error('Cancellation attempt no longer owns this fiscal document'), { status: 409 });
    }
    await trx('fiscal_documents').where({ id }).update({
      status: 'cancelled',
      cancellation_status: 'cancelled',
      cancellation_mark: String(cancellationMark),
      cancellation_response: response ? JSON.stringify(response) : document.cancellation_response,
      cancellation_verification_response: verificationResponse ? JSON.stringify(verificationResponse) : document.cancellation_verification_response,
      cancellation_verification_status: verificationResponse ? 'verified' : 'pending',
      cancellation_verified_at: verificationResponse ? trx.fn.now() : document.cancellation_verified_at,
      cancellation_token: null,
      cancelled_at: trx.fn.now(),
      cancellation_error: null,
      cancellation_retryable: false,
      cancellation_uncertain: false,
      error_message: null,
      updated_at: trx.fn.now(),
    });
    return trx('fiscal_documents').where({ id }).first();
  });
}

async function markCancellationVerified(id, cancellationMark, verificationResponse, {
  expectedEnvironment = process.env.MYDATA_ENV || 'sandbox',
} = {}) {
  return db.transaction(async (trx) => {
    const document = await trx('fiscal_documents').where({ id }).forUpdate().first();
    if (!document) throw Object.assign(new Error('Fiscal document not found'), { status: 404 });
    if (document.mydata_environment !== expectedEnvironment || document.target_environment !== expectedEnvironment) {
      throw Object.assign(new Error('Fiscal document myDATA environment changed or does not match runtime'), { status: 409 });
    }
    if (document.status !== 'cancelled' || document.cancellation_status !== 'cancelled'
        || String(document.cancellation_mark) !== String(cancellationMark)) {
      throw Object.assign(new Error('Cancelled document changed before verification'), { status: 409 });
    }
    if (document.cancellation_verification_status === 'verified') return document;
    await trx('fiscal_documents').where({ id }).update({
      cancellation_verification_status: 'verified',
      cancellation_verification_response: JSON.stringify(verificationResponse),
      cancellation_verified_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
    return trx('fiscal_documents').where({ id }).first();
  });
}

async function getCancellationResolutionEvent(idempotencyKey) {
  return db('cancellation_resolution_events').where({ idempotency_key: idempotencyKey }).first();
}

async function listCancellationResolutionEvents(documentId) {
  return db('cancellation_resolution_events')
    .where({ document_id: documentId })
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc');
}

function timestampsEquivalent(actual, expected) {
  if (String(actual) === String(expected)) return true;
  const actualMs = Date.parse(actual instanceof Date ? actual.toISOString() : String(actual));
  const expectedMs = Date.parse(String(expected));
  return Number.isFinite(actualMs) && Number.isFinite(expectedMs) && actualMs === expectedMs;
}

async function resolveDefinitiveCancellationFailure({
  documentId, decision, reason, resolvedBy, expectedUpdatedAt, idempotencyKey, adminKeyFingerprint, payloadHash,
  expectedEnvironment = process.env.MYDATA_ENV || 'sandbox', foundCancellation = null,
}) {
  const execute = () => db.transaction(async (trx) => {
    const document = await trx('fiscal_documents').where({ id: documentId }).forUpdate().first();
    if (!document) throw Object.assign(new Error('Fiscal document not found'), { status: 404 });
    // Recheck after the document lock: a concurrent same-key request may have
    // committed while this transaction was waiting.
    const existingEvent = await trx('cancellation_resolution_events').where({ idempotency_key: idempotencyKey }).first();
    if (existingEvent) {
      if (existingEvent.payload_hash !== payloadHash) throw Object.assign(new Error('Idempotency key already belongs to a different resolution'), { status: 409 });
      return { event: existingEvent, document, idempotent: true, reconciled: existingEvent.to_status === 'cancelled' };
    }
    if (!timestampsEquivalent(document.updated_at, expectedUpdatedAt)) throw Object.assign(new Error('Fiscal document changed; reload before resolving'), { status: 409 });
    if (document.mydata_environment !== expectedEnvironment || document.target_environment !== expectedEnvironment) {
      throw Object.assign(new Error('Fiscal document myDATA environment changed or does not match runtime'), { status: 409 });
    }
    if (document.status !== 'sent' || !/^\d+$/.test(String(document.mydata_mark || ''))
        || document.cancellation_status !== 'failed' || Boolean(document.cancellation_uncertain)
        || Boolean(document.cancellation_retryable) || document.cancellation_mark) {
      throw Object.assign(new Error('Only a definitive non-retryable CancelInvoice failure can be resolved'), { status: 409 });
    }
    const reconciled = Boolean(foundCancellation);
    if (reconciled && String(foundCancellation.invoiceMark) !== String(document.mydata_mark)) {
      throw Object.assign(new Error('Verified cancellation belongs to a different invoice MARK'), { status: 409 });
    }
    const toStatus = reconciled ? 'cancelled' : (decision === 'authorize_retry' ? 'failed' : 'none');
    await trx('fiscal_documents').where({ id: document.id }).update(reconciled ? {
      status: 'cancelled', cancellation_status: 'cancelled',
      cancellation_mark: String(foundCancellation.cancellationMark),
      cancellation_verification_status: 'verified',
      cancellation_verification_response: JSON.stringify(foundCancellation.raw || foundCancellation),
      cancellation_verified_at: trx.fn.now(), cancelled_at: trx.fn.now(),
      cancellation_retryable: false, cancellation_uncertain: false, cancellation_token: null,
      cancellation_error: null, error_message: null, updated_at: trx.fn.now(),
    } : {
      cancellation_status: toStatus,
      cancellation_retryable: decision === 'authorize_retry',
      cancellation_uncertain: false,
      cancellation_token: null,
      ...(decision === 'retain_active' ? { cancellation_error: null } : {}),
      updated_at: trx.fn.now(),
    });
    const inserted = await trx('cancellation_resolution_events').insert({
      idempotency_key: idempotencyKey, document_id: document.id, company_id: document.company_id,
      decision: reconciled ? 'reconciled_cancelled' : decision,
      from_status: 'failed', to_status: toStatus, invoice_mark: String(document.mydata_mark),
      prior_cancellation_error: document.cancellation_error,
      prior_retryable: Boolean(document.cancellation_retryable), prior_uncertain: Boolean(document.cancellation_uncertain),
      prior_attempt_at: document.cancellation_attempt_at, reason, resolved_by: resolvedBy,
      admin_key_fingerprint: adminKeyFingerprint, payload_hash: payloadHash,
    }).returning('id');
    const eventId = insertedId(inserted);
    return {
      event: await trx('cancellation_resolution_events').where({ id: eventId }).first(),
      document: await trx('fiscal_documents').where({ id: document.id }).first(),
      idempotent: false,
      reconciled,
    };
  });
  try {
    return await execute();
  } catch (error) {
    const duplicate = error.code === '23505' || String(error.code || '').startsWith('SQLITE_CONSTRAINT');
    if (!duplicate) throw error;
    const existingEvent = await getCancellationResolutionEvent(idempotencyKey);
    if (!existingEvent || existingEvent.payload_hash !== payloadHash) {
      throw Object.assign(new Error('Idempotency key already belongs to a different resolution'), { status: 409 });
    }
    return {
      event: existingEvent,
      document: await getDocumentById(existingEvent.document_id),
      idempotent: true,
      reconciled: existingEvent.to_status === 'cancelled',
    };
  }
}

async function cancelPendingReservationDocuments(reservationId, client = db) {
  return client('fiscal_documents')
    .where({ reservation_id: reservationId })
    .whereIn('status', ['pending', 'failed'])
    .where({ transmission_uncertain: false })
    .update({ status: 'cancelled', cancellation_status: 'cancelled', cancelled_at: client.fn.now(), updated_at: client.fn.now() });
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
  hasDueFiscalWork,
  claimDocument,
  markDocumentSent,
  markDocumentFailed,
  quarantineStaleTransmissions,
  claimDocumentCancellation,
  quarantineStaleCancellations,
  markCancellationFailed,
  cancelUnsentDocument,
  markDocumentCancelled,
  markCancellationVerified,
  getCancellationResolutionEvent,
  listCancellationResolutionEvents,
  resolveDefinitiveCancellationFailure,
  cancelPendingReservationDocuments,
  listUnverifiedDocuments,
  markDocumentVerified,
  markVerificationFailed,
};

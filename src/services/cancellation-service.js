'use strict';

const crypto = require('crypto');

const { getCompanyById } = require('../repositories/companies');
const {
  getDocumentById, claimDocumentCancellation, quarantineStaleCancellations, markCancellationFailed,
  cancelUnsentDocument, markDocumentCancelled, markCancellationVerified,
  getCancellationResolutionEvent, resolveDefinitiveCancellationFailure,
} = require('../repositories/fiscal-documents');
const { decryptCompanySecret } = require('../security/credentials');
const { cancelMyDataInvoice, verifyCancelledInvoice } = require('../mydata-client');
const { assertProductionTransmissionEnabled } = require('../security/production-guard');

async function cancelFiscalDocument({ documentId, canceller = cancelMyDataInvoice }) {
  let document = await getDocumentById(documentId);
  if (!document) {
    const error = new Error('Fiscal document not found');
    error.status = 404;
    throw error;
  }
  await quarantineStaleCancellations(document.company_id, Number(process.env.MYDATA_STALE_CANCELLATION_MINUTES || 60));
  document = await getDocumentById(documentId);
  if (document.status === 'cancelled') return document;
  const currentEnvironment = process.env.MYDATA_ENV || 'sandbox';
  if (document.mydata_mark && (document.mydata_environment !== currentEnvironment
      || document.target_environment !== currentEnvironment)) {
    const error = new Error(`Document belongs to myDATA ${document.mydata_environment || 'unknown'} and cannot be cancelled from ${currentEnvironment}`);
    error.status = 409;
    throw error;
  }
  if (document.cancellation_uncertain) {
    const error = new Error('Cancellation outcome is uncertain; reconcile it from myDATA before retry');
    error.status = 409;
    throw error;
  }
  if (document.transmission_uncertain && !document.mydata_mark) {
    const error = new Error('Transmission outcome is uncertain; reconcile the myDATA MARK before cancellation');
    error.status = 409;
    throw error;
  }

  // Δεν έχει φύγει στην ΑΑΔΕ: ακυρώνεται μόνο το τοπικό queued παραστατικό.
  if (!document.mydata_mark) {
    if (!['pending', 'failed'].includes(document.status)) {
      const error = new Error(`Document in status ${document.status} cannot be cancelled`);
      error.status = 409;
      throw error;
    }
    if (!await cancelUnsentDocument(document.id)) {
      const current = await getDocumentById(document.id);
      if (current?.status === 'cancelled') return current;
      const error = new Error('Document cancellation state changed; reload and retry'); error.status = 409; throw error;
    }
    return getDocumentById(document.id);
  }

  await assertProductionTransmissionEnabled('cancellations');
  const attemptToken = await claimDocumentCancellation(document.id, currentEnvironment);
  if (!attemptToken) {
    const current = await getDocumentById(document.id);
    if (current?.status === 'cancelled') return current;
    const error = new Error('Document cancellation is already in progress'); error.status = 409; throw error;
  }
  const company = await getCompanyById(document.company_id);
  if (!company) {
    await markCancellationFailed(document.id, 'Company not found', { attemptToken });
    const error = new Error('Company not found');
    error.status = 404;
    throw error;
  }
  try {
    const result = await canceller(document.mydata_mark, {
      ...company,
      aade_user_id: decryptCompanySecret(company, 'aade_user_id'),
      aade_subscription_key: decryptCompanySecret(company, 'aade_subscription_key'),
    });
    return markDocumentCancelled(document.id, result.cancellationMark, { attemptToken, response: result.raw || result });
  } catch (error) {
    await markCancellationFailed(document.id, error.message, {
      retryable: error.retryable === true,
      uncertain: error.transmissionUncertain === true,
      attemptToken,
    });
    throw error;
  }
}

async function reconcileFiscalDocumentCancellation({ documentId, verifier = verifyCancelledInvoice }) {
  const document = await getDocumentById(documentId);
  if (!document) throw Object.assign(new Error('Fiscal document not found'), { status: 404 });
  const currentEnvironment = process.env.MYDATA_ENV || 'sandbox';
  if (document.mydata_environment !== currentEnvironment || document.target_environment !== currentEnvironment) {
    throw Object.assign(new Error('Fiscal document myDATA environment does not match runtime'), { status: 409 });
  }
  if (document.status === 'cancelled' && document.cancellation_status === 'cancelled'
      && document.cancellation_verification_status === 'verified' && document.cancellation_mark) {
    return document;
  }
  const uncertain = document.status === 'sent' && document.mydata_mark && document.cancellation_uncertain;
  const awaitingVerification = document.status === 'cancelled' && document.mydata_mark && document.cancellation_mark
    && document.cancellation_verification_status !== 'verified';
  if (!uncertain && !awaitingVerification) {
    throw Object.assign(new Error('Only an uncertain cancellation or unverified cancellation MARK can be reconciled'), { status: 409 });
  }
  const company = await getCompanyById(document.company_id);
  if (!company) throw Object.assign(new Error('Company not found'), { status: 404 });
  const result = await verifier(document.mydata_mark, {
    ...company,
    aade_user_id: decryptCompanySecret(company, 'aade_user_id'),
    aade_subscription_key: decryptCompanySecret(company, 'aade_subscription_key'),
  }, {
    cancellationMark: document.cancellation_mark || undefined,
  });
  if (!result?.verified || String(result.invoiceMark) !== String(document.mydata_mark) || !result.cancellationMark) {
    throw Object.assign(new Error('RequestTransmittedDocs did not verify the cancellation'), { status: 409 });
  }
  if (awaitingVerification) {
    if (String(result.cancellationMark) !== String(document.cancellation_mark)) {
      throw Object.assign(new Error('RequestTransmittedDocs returned a different cancellation MARK'), { status: 409 });
    }
    return markCancellationVerified(document.id, result.cancellationMark, result.raw || result, {
      expectedEnvironment: currentEnvironment,
    });
  }
  return markDocumentCancelled(document.id, result.cancellationMark, {
    reconciled: true, verificationResponse: result.raw || result,
    expectedEnvironment: currentEnvironment,
  });
}

function requiredText(value, field, min, max) {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max) throw Object.assign(new Error(`${field} must contain ${min}-${max} characters`), { status: 400 });
  return text;
}

async function resolveCancellationFailure({
  documentId, decision, reason, resolvedBy, expectedUpdatedAt, idempotencyKey,
  adminKeyFingerprint, verifier = verifyCancelledInvoice,
}) {
  if (!['authorize_retry', 'retain_active'].includes(decision)) throw Object.assign(new Error('decision must be authorize_retry or retain_active'), { status: 400 });
  const normalizedReason = requiredText(reason, 'reason', 10, 4000);
  const normalizedActor = requiredText(resolvedBy, 'resolved_by', 1, 200);
  const normalizedKey = requiredText(idempotencyKey, 'idempotency_key', 8, 100);
  const expected = requiredText(expectedUpdatedAt, 'expected_updated_at', 1, 100);
  const fingerprint = requiredText(adminKeyFingerprint, 'admin_key_fingerprint', 16, 64);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({
    documentId: Number(documentId), decision, reason: normalizedReason, resolvedBy: normalizedActor, expectedUpdatedAt: expected,
  })).digest('hex');
  const prior = await getCancellationResolutionEvent(normalizedKey);
  if (prior) {
    if (prior.payload_hash !== payloadHash) throw Object.assign(new Error('Idempotency key already belongs to a different resolution'), { status: 409 });
    return {
      event: prior,
      document: await getDocumentById(prior.document_id),
      idempotent: true,
      reconciled: prior.to_status === 'cancelled',
    };
  }
  const document = await getDocumentById(documentId);
  if (!document) throw Object.assign(new Error('Fiscal document not found'), { status: 404 });
  const currentEnvironment = process.env.MYDATA_ENV || 'sandbox';
  if (document.mydata_environment !== currentEnvironment || document.target_environment !== currentEnvironment) {
    throw Object.assign(new Error('Fiscal document myDATA environment does not match runtime'), { status: 409 });
  }
  if (document.status !== 'sent' || document.cancellation_status !== 'failed'
      || document.cancellation_retryable || document.cancellation_uncertain || !document.mydata_mark) {
    throw Object.assign(new Error('Only a definitive non-retryable CancelInvoice failure can be resolved'), { status: 409 });
  }
  const company = await getCompanyById(document.company_id);
  if (!company) throw Object.assign(new Error('Company not found'), { status: 404 });
  const check = await verifier(document.mydata_mark, {
    ...company,
    aade_user_id: decryptCompanySecret(company, 'aade_user_id'),
    aade_subscription_key: decryptCompanySecret(company, 'aade_subscription_key'),
  }, {
    cancellationMark: document.cancellation_mark || undefined,
  });
  const foundCancellation = check?.verified && check.cancellationMark ? {
    invoiceMark: check.invoiceMark,
    cancellationMark: check.cancellationMark,
    raw: check.raw || check,
  } : null;
  if (!foundCancellation && (!check?.notFound || String(check.invoiceMark) !== String(document.mydata_mark))) {
    throw Object.assign(new Error('myDATA did not authoritatively confirm that no cancellation exists'), { status: 409 });
  }
  return resolveDefinitiveCancellationFailure({
    documentId: Number(documentId), decision, reason: normalizedReason, resolvedBy: normalizedActor,
    expectedUpdatedAt: expected, idempotencyKey: normalizedKey,
    adminKeyFingerprint: fingerprint, payloadHash,
    expectedEnvironment: currentEnvironment, foundCancellation,
  });
}

module.exports = { cancelFiscalDocument, reconcileFiscalDocumentCancellation, resolveCancellationFailure };

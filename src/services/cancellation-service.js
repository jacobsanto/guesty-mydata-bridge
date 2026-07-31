'use strict';

const { getCompanyById } = require('../repositories/companies');
const { getDocumentById, claimDocumentCancellation, quarantineStaleCancellations, markCancellationFailed, cancelUnsentDocument, markDocumentCancelled } = require('../repositories/fiscal-documents');
const { decryptCompanySecret } = require('../security/credentials');
const { cancelMyDataInvoice, verifyCancelledInvoice } = require('../mydata-client');
const { assertProductionTransmissionEnabled } = require('../security/production-guard');

async function cancelFiscalDocument({ documentId, canceller = cancelMyDataInvoice }) {
  await quarantineStaleCancellations(Number(process.env.MYDATA_STALE_CANCELLATION_MINUTES || 60));
  const document = await getDocumentById(documentId);
  if (!document) {
    const error = new Error('Fiscal document not found');
    error.status = 404;
    throw error;
  }
  if (document.status === 'cancelled') return document;
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
  if (!await claimDocumentCancellation(document.id)) {
    const current = await getDocumentById(document.id);
    if (current?.status === 'cancelled') return current;
    const error = new Error('Document cancellation is already in progress'); error.status = 409; throw error;
  }
  const company = await getCompanyById(document.company_id);
  if (!company) {
    await markCancellationFailed(document.id, 'Company not found');
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
    return markDocumentCancelled(document.id, result.cancellationMark);
  } catch (error) {
    await markCancellationFailed(document.id, error.message, {
      retryable: error.retryable === true,
      uncertain: error.transmissionUncertain === true,
    });
    throw error;
  }
}

async function reconcileFiscalDocumentCancellation({ documentId, verifier = verifyCancelledInvoice }) {
  const document = await getDocumentById(documentId);
  if (!document) throw Object.assign(new Error('Fiscal document not found'), { status: 404 });
  if (document.status !== 'sent' || !document.mydata_mark || !document.cancellation_uncertain) {
    throw Object.assign(new Error('Only an uncertain myDATA cancellation can be reconciled'), { status: 409 });
  }
  const company = await getCompanyById(document.company_id);
  if (!company) throw Object.assign(new Error('Company not found'), { status: 404 });
  const result = await verifier(document.mydata_mark, {
    ...company,
    aade_user_id: decryptCompanySecret(company, 'aade_user_id'),
    aade_subscription_key: decryptCompanySecret(company, 'aade_subscription_key'),
  });
  if (!result?.verified || String(result.invoiceMark) !== String(document.mydata_mark) || !result.cancellationMark) {
    throw Object.assign(new Error('RequestTransmittedDocs did not verify the cancellation'), { status: 409 });
  }
  return markDocumentCancelled(document.id, result.cancellationMark);
}

module.exports = { cancelFiscalDocument, reconcileFiscalDocumentCancellation };

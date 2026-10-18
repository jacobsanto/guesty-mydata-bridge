'use strict';

const AUTOMATIC_TYPES = new Set(['11.2', '2.1', '8.2']);

function automaticCancellationState(document) {
  if (!AUTOMATIC_TYPES.has(String(document?.document_type || ''))) return 'irrelevant';
  if (document.status === 'cancelled' && document.cancellation_status === 'cancelled') {
    return document.mydata_mark && document.cancellation_verification_status !== 'verified'
      ? 'awaiting_verification'
      : 'settled';
  }
  if (document.cancellation_uncertain || (document.transmission_uncertain && !document.mydata_mark)) return 'ambiguous';
  const retryableFailure = document.cancellation_status === 'failed'
    && Boolean(document.cancellation_retryable) && !document.cancellation_uncertain;
  if (document.status === 'sent' && document.mydata_mark
      && (document.cancellation_status === 'requested' || retryableFailure)) return 'ready';
  if (document.cancellation_status === 'requested'
      && (document.status === 'transmitting' || !document.mydata_mark)) return 'awaiting_mark';
  return 'not_requested';
}

async function processAutomaticCancellationWork(documents, { cancel, verify, resolve }) {
  const results = [];
  for (const document of documents) {
    const state = automaticCancellationState(document);
    if (state !== 'ready') {
      throw Object.assign(new Error(`Automatic cancellation document ${document.id} is ${state}`), { status: 409 });
    }
    await cancel(document);
    await verify(document);
    await resolve(document);
    results.push({ documentId: document.id, reservationId: document.reservation_id, status: 'verified' });
  }
  return results;
}

module.exports = { automaticCancellationState, processAutomaticCancellationWork };

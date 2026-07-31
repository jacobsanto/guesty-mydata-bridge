'use strict';

const { getCompanyById } = require('../repositories/companies');
const {
  listTransmittableDocuments,
  claimDocument,
  markDocumentSent,
  markDocumentFailed,
  listUnverifiedDocuments,
  quarantineStaleTransmissions,
  listBlockedDueDocuments,
  listInFlightDocuments,
} = require('../repositories/fiscal-documents');
const { beginRun, heartbeatRun, recordRunItem, recordVerificationResult, finishRun } = require('../repositories/daily-close');
const { decryptCompanySecret } = require('../security/credentials');
const { sendToMyData, verifyTransmittedDocument } = require('../mydata-client');
const { materializeDueReservations } = require('./reservation-service');
const { assertProductionTransmissionEnabled } = require('../security/production-guard');

function validateBusinessDate(value) {
  const text = String(value || '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    const error = new Error('business_date must use a real calendar date in YYYY-MM-DD');
    error.status = 400;
    throw error;
  }
}

async function verifyOne(document, companyContext, verifier, run, counts, ensureLease) {
  try {
    const result = await verifier(document.mydata_mark, companyContext, document);
    if (!result || result.verified !== true || String(result.mark) !== String(document.mydata_mark)) {
      throw new Error(`Verification result did not confirm MARK ${document.mydata_mark}`);
    }
    await ensureLease();
    await recordVerificationResult(run.id, document.id, document.mydata_mark, { verified: true }, run.lease_token);
    counts.sent += 1;
  } catch (error) {
    if (error.status === 409) throw error;
    await ensureLease();
    await recordVerificationResult(run.id, document.id, document.mydata_mark, { verified: false, error: error.message }, run.lease_token);
    counts.failed += 1;
  }
}

async function executeDailyClose({ companyId, businessDate, sender = sendToMyData, verifier = verifyTransmittedDocument, materializer = materializeDueReservations, maxAttempts = 5 }) {
  validateBusinessDate(businessDate);
  await assertProductionTransmissionEnabled('submissions');
  const company = await getCompanyById(companyId);
  if (!company || !company.active) {
    const error = new Error('Active company not found');
    error.status = 404;
    throw error;
  }

  const companyContext = {
    ...company,
    aade_user_id: decryptCompanySecret(company, 'aade_user_id'),
    aade_subscription_key: decryptCompanySecret(company, 'aade_subscription_key'),
  };
  const leaseSeconds = Math.min(Math.max(Number(process.env.DAILY_CLOSE_LEASE_SECONDS || 300), 30), 3600);
  const run = await beginRun(company.id, businessDate, { leaseSeconds });
  let leaseFailure = null;
  const leaseTimer = setInterval(() => {
    void heartbeatRun(run.id, run.lease_token, leaseSeconds).catch((error) => { leaseFailure = error; });
  }, Math.max(10000, Math.min(30000, Math.floor(leaseSeconds * 1000 / 3))));
  leaseTimer.unref();
  const ensureLease = async () => {
    if (leaseFailure) throw leaseFailure;
    await heartbeatRun(run.id, run.lease_token, leaseSeconds);
  };
  try {
    await ensureLease();
    await quarantineStaleTransmissions(company.id, Number(process.env.MYDATA_STALE_TRANSMISSION_MINUTES || 60));
    const materializationResults = await materializer(company.id, businessDate);
    await ensureLease();
    const materializationFailures = materializationResults.filter((result) => result.error).length;
    const documents = await listTransmittableDocuments(company.id, businessDate, maxAttempts);
    const awaitingVerification = await listUnverifiedDocuments(company.id, businessDate);
    const blockedDocuments = await listBlockedDueDocuments(company.id, businessDate, maxAttempts);
    const inFlightDocuments = await listInFlightDocuments(company.id, businessDate);
    const counts = {
      total: documents.length + awaitingVerification.length + blockedDocuments.length + inFlightDocuments.length + materializationFailures,
      sent: 0,
      failed: materializationFailures + blockedDocuments.length,
      inFlight: inFlightDocuments.length,
    };

    for (const document of inFlightDocuments) {
      await ensureLease();
      await recordRunItem(run.id, document.id, 'in_flight', 'Transmission is still in progress; awaiting MARK or stale reconciliation', run.lease_token);
    }

    for (const document of blockedDocuments) {
      await ensureLease();
      await recordRunItem(run.id, document.id, 'blocked', document.error_message || 'Document requires operator review', run.lease_token);
    }

    for (const document of awaitingVerification) {
      await ensureLease();
      await verifyOne(document, companyContext, verifier, run, counts, ensureLease);
    }

    for (const document of documents) {
      await ensureLease();
      if (!await claimDocument(document.id)) continue;
      let markPersisted = false;
      try {
        const response = await sender(document.xml_payload, companyContext);
        // Persist a returned MARK even if the scheduler lease expired during
        // the network call; losing that response would create a duplicate risk.
        await markDocumentSent(document.id, response);
        markPersisted = true;
        await ensureLease();
        await verifyOne({ ...document, mydata_mark: response.mark, mydata_uid: response.uid || null }, companyContext, verifier, run, counts, ensureLease);
      } catch (error) {
        // Once AADE returned a MARK, never downgrade the document to failed.
        // A replacement worker will safely verify the persisted MARK.
        if (markPersisted || error.status === 409) throw error;
        await markDocumentFailed(document.id, error.message, {
          retryable: error.retryable === true,
          transmissionUncertain: error.transmissionUncertain === true,
        });
        await recordRunItem(run.id, document.id, 'failed', error.message, run.lease_token);
        counts.failed += 1;
      }
    }

    await ensureLease();
    return finishRun(run.id, counts, run.lease_token);
  } finally {
    clearInterval(leaseTimer);
  }
}

module.exports = { executeDailyClose };

'use strict';

const { getDocumentById, createDocumentOnce, findDocumentByKey, sumActiveRelatedCredits } = require('../repositories/fiscal-documents');
const { getCompanyAndListingByGuestyListingId } = require('../repositories/listings');
const { generateCreditXML } = require('../mydata-xml');
const { db } = require('../database');
const { normalizeSeries } = require('../validation/fiscal-fields');
const { getCompanyById } = require('../repositories/companies');
const { assertVerifiedAadeCredentials } = require('../security/aade-credential-guard');

function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

async function createCreditDocument({ documentId, grossValue, issueDate, reference = 'default' }) {
  const original = await getDocumentById(documentId);
  if (!original) {
    const error = new Error('Original fiscal document not found'); error.status = 404; throw error;
  }
  const company = await getCompanyById(original.company_id);
  assertVerifiedAadeCredentials(company);
  if (original.status !== 'sent' || !original.mydata_mark || original.verification_status !== 'verified'
      || !['none', null].includes(original.cancellation_status)) {
    const error = new Error('Only a verified sent document with no cancellation in progress can receive a credit'); error.status = 409; throw error;
  }
  if (!['2.1', '11.2'].includes(original.document_type)) {
    const error = new Error('Credits are supported for original 2.1 or 11.2 documents'); error.status = 409; throw error;
  }
  const currentEnvironment = process.env.MYDATA_ENV || 'sandbox';
  if (original.mydata_environment !== currentEnvironment || original.target_environment !== currentEnvironment) {
    const error = new Error(`Original document belongs to myDATA ${original.mydata_environment || original.target_environment || 'unknown'} and cannot receive a ${currentEnvironment} credit`);
    error.status = 409;
    throw error;
  }
  const amount = Number(grossValue);
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number(original.gross_value) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8) {
    const error = new Error('gross_value must have up to 2 decimals, be positive and not exceed the original gross value'); error.status = 400; throw error;
  }
  if (!validDate(issueDate)) {
    const error = new Error('issue_date must use a real calendar date in YYYY-MM-DD'); error.status = 400; throw error;
  }
  if (issueDate < String(original.issue_date).slice(0, 10)) {
    const error = new Error('issue_date cannot be before the original document date'); error.status = 400; throw error;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (issueDate > today) {
    const error = new Error('issue_date cannot be in the future'); error.status = 400; throw error;
  }
  const normalizedReference = String(reference || '').trim();
  if (!normalizedReference || normalizedReference.length > 80 || /[\u0000-\u001F\u007F]/.test(normalizedReference)) {
    const error = new Error('reference must be 1-80 printable characters'); error.status = 400; throw error;
  }
  const source = JSON.parse(original.source_payload || '{}');
  if (currentEnvironment === 'production' && !source?.billingSnapshot?.unified_channel_policy?.policy_hash) {
    const error = new Error('Production credit requires an original document frozen with a unified channel policy'); error.status = 409; throw error;
  }
  const currentBillingContext = await getCompanyAndListingByGuestyListingId(source.listingId);
  const billingContext = source.billingSnapshot
    ? { ...currentBillingContext, ...source.billingSnapshot }
    : currentBillingContext;
  if (!billingContext) throw new Error('Billing context for original document was not found');
  const invoiceType = original.document_type === '2.1' ? '5.1' : '11.4';
  const suffix = invoiceType === '5.1' ? '-CR' : '-RL';
  const series = normalizeSeries(`${String(original.series).slice(0, 50 - suffix.length)}${suffix}`, { required: true });
  const netValue = Number((amount / 1.13).toFixed(2));
  const documentKey = `${original.company_id}:${original.reservation_id}:credit:${normalizedReference}`;
  try {
    return await db.transaction(async (trx) => {
      let lockedQuery = trx('fiscal_documents').where({ id: original.id });
      if (trx.client.config.client === 'pg') lockedQuery = lockedQuery.forUpdate();
      const lockedOriginal = await lockedQuery.first();
      if (!lockedOriginal || lockedOriginal.status !== 'sent' || !lockedOriginal.mydata_mark
          || lockedOriginal.verification_status !== 'verified'
          || !['none', null].includes(lockedOriginal.cancellation_status)
          || lockedOriginal.mydata_environment !== currentEnvironment
          || lockedOriginal.target_environment !== currentEnvironment) {
        const error = new Error('Original document is no longer eligible for a credit'); error.status = 409; throw error;
      }
      const existing = await trx('fiscal_documents').where({ document_key: documentKey }).first();
      if (existing) {
        if (Number(existing.gross_value) !== amount || String(existing.issue_date).slice(0, 10) !== issueDate
            || Number(existing.related_document_id) !== Number(lockedOriginal.id)
            || existing.target_environment !== currentEnvironment) {
          const error = new Error('Credit reference already exists with a different amount, date, or original document'); error.status = 409; throw error;
        }
        return { document: existing, created: false };
      }
      const alreadyCredited = await sumActiveRelatedCredits(lockedOriginal.id, trx);
      if (Number((alreadyCredited + amount).toFixed(2)) > Number(lockedOriginal.gross_value)) {
        const error = new Error('Cumulative active credits cannot exceed the original gross value'); error.status = 409; throw error;
      }
      return createDocumentOnce({
        transaction: trx,
        documentKey,
        companyId: lockedOriginal.company_id,
        listingId: lockedOriginal.listing_id,
        reservationId: lockedOriginal.reservation_id,
        documentKind: invoiceType === '5.1' ? 'service_invoice_credit' : 'service_receipt_credit',
        documentType: invoiceType,
        series,
        issueDate,
        relatedDocumentId: lockedOriginal.id,
        correlatedMark: lockedOriginal.mydata_mark,
        amounts: { netValue, vatAmount: Number((amount - netValue).toFixed(2)), otherTaxesAmount: 0, grossValue: amount },
        sourcePayload: {
          ...source,
          credit: { originalDocumentId: lockedOriginal.id, reference: normalizedReference, grossValue: amount },
        },
        buildXml: (aa) => generateCreditXML({ invoiceType, grossValue: amount, issueDate, series, correlatedMark: lockedOriginal.mydata_mark }, billingContext, aa),
      });
    });
  } catch (error) {
    const duplicate = error.code === '23505' || String(error.code || '').startsWith('SQLITE_CONSTRAINT');
    if (duplicate) {
      const existing = await findDocumentByKey(documentKey);
      if (existing && Number(existing.gross_value) === amount && String(existing.issue_date).slice(0, 10) === issueDate
          && Number(existing.related_document_id) === Number(original.id)
          && existing.target_environment === currentEnvironment) return { document: existing, created: false };
      if (existing) throw Object.assign(new Error('Credit reference already exists with different fiscal data'), { status: 409 });
    }
    throw error;
  }
}

module.exports = { createCreditDocument };

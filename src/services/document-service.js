'use strict';

const { createDocumentOnce } = require('../repositories/fiscal-documents');
const { generateMyDataXML, generateClimateFeeXML, calculateClimateFeePerNight } = require('../mydata-xml');
const { getBillingRule } = require('../repositories/billing-rules');
const { normalizeAndValidateGreekVat, normalizeCounterpart, normalizeSeries } = require('../validation/fiscal-fields');
const { db } = require('../database');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function primaryAmounts(reservation) {
  const grossValue = money(reservation.financials?.totalGross);
  if (grossValue <= 0) throw new Error('financials.totalGross must be a positive number');
  const netValue = money(grossValue / 1.13);
  return { netValue, vatAmount: money(grossValue - netValue), otherTaxesAmount: 0, grossValue };
}

function climateAmounts(reservation, billingContext) {
  if (Array.isArray(reservation.climateFeeLines)) {
    const cents = reservation.climateFeeLines.reduce((sum, line) => sum + Number(line.cents), 0);
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Frozen TAKK policy fee lines must have a positive integer cents total');
    return { netValue: 0, vatAmount: 0, otherTaxesAmount: money(cents / 100), grossValue: money(cents / 100) };
  }
  const nights = Number(reservation.nights);
  if (!Number.isInteger(nights) || nights <= 0) throw new Error('nights must be a positive integer');
  const start = new Date(`${reservation.checkIn.slice(0, 10)}T12:00:00Z`);
  let total = 0;
  for (let index = 0; index < nights; index += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    total += calculateClimateFeePerNight(date.toISOString().slice(0, 10), billingContext);
  }
  const grossValue = money(total);
  return { netValue: 0, vatAmount: 0, otherTaxesAmount: grossValue, grossValue };
}

function documentBase(reservation, billingContext) {
  if (!reservation?.reservationId || !reservation?.listingId || !reservation?.checkOut) {
    throw new Error('reservationId, listingId and checkOut are required');
  }
  return {
    companyId: billingContext.company_id,
    listingId: billingContext.listing_id,
    reservationId: reservation.reservationId,
    issueDate: reservation.checkOut.slice(0, 10),
    sourcePayload: reservation,
  };
}

async function prepareReservationDocuments(reservation, billingContext, options = {}) {
  const unifiedPolicy = reservation.unifiedChannelPolicy;
  if (!unifiedPolicy && (reservation.financialProfile?.status !== 'matched'
      || !reservation.financialProfile?.id
      || !reservation.financialProfile?.version
      || !reservation.financialProfile?.configHash)) {
    throw new Error('An approved and calibrated channel financial profile is required before fiscal document creation');
  }
  const base = documentBase(reservation, billingContext);
  const revisionSuffix = Number(reservation.fiscalRevision || 0) > 0 ? `:r${Number(reservation.fiscalRevision)}` : '';
  const sourceRule = unifiedPolicy ? null : await getBillingRule(
    billingContext.listing_id,
    reservation.platformKey || reservation.platform,
    reservation.sourceKey || reservation.source,
    options.transaction || db,
  );
  const invoiceType = unifiedPolicy?.documentType || reservation.invoiceType || sourceRule?.invoice_type || billingContext.default_invoice_type;
  let effectiveContext = sourceRule ? {
    ...billingContext,
    default_invoice_type: sourceRule.invoice_type,
    invoice_counterpart_vat_number: sourceRule.counterpart_vat_number,
    invoice_counterpart_country: sourceRule.counterpart_country,
    invoice_counterpart_name: sourceRule.counterpart_name,
    invoice_counterpart_branch: sourceRule.counterpart_branch,
  } : billingContext;
  if (reservation.invoiceCounterpart) {
    effectiveContext = {
      ...effectiveContext,
      invoice_counterpart_vat_number: reservation.invoiceCounterpart.vatNumber,
      invoice_counterpart_country: reservation.invoiceCounterpart.country,
      invoice_counterpart_name: reservation.invoiceCounterpart.name,
      invoice_counterpart_branch: reservation.invoiceCounterpart.branch,
    };
  }
  effectiveContext = { ...effectiveContext, vat_number: normalizeAndValidateGreekVat(effectiveContext.vat_number) };
  const counterpart = normalizeCounterpart({
    vatNumber: effectiveContext.invoice_counterpart_vat_number,
    country: effectiveContext.invoice_counterpart_country,
    name: effectiveContext.invoice_counterpart_name,
    branch: effectiveContext.invoice_counterpart_branch,
  }, { required: invoiceType === '2.1', label: 'invoice_counterpart' });
  effectiveContext = {
    ...effectiveContext,
    invoice_counterpart_vat_number: counterpart.vatNumber,
    invoice_counterpart_country: counterpart.country,
    invoice_counterpart_name: counterpart.name,
    invoice_counterpart_branch: counterpart.branch,
  };
  const series = normalizeSeries(unifiedPolicy?.series || reservation.invoiceSeries || sourceRule?.series || billingContext.invoice_series || 'A', { required: true });
  const sourcePayload = {
    ...reservation,
    billingSnapshot: {
      unified_channel_policy: unifiedPolicy ? {
        id: unifiedPolicy.id, version: unifiedPolicy.version, policy_hash: unifiedPolicy.policyHash,
        guesty_account_id: unifiedPolicy.guestyAccountId, platform_key: unifiedPolicy.platformKey, source_key: unifiedPolicy.sourceKey,
        document_type: unifiedPolicy.documentType, vat_category: unifiedPolicy.vatCategory,
        classification_type: unifiedPolicy.classificationType, classification_category: unifiedPolicy.classificationCategory,
      } : null,
      vat_number: effectiveContext.vat_number,
      invoice_series: series,
      invoice_counterpart_vat_number: effectiveContext.invoice_counterpart_vat_number || null,
      invoice_counterpart_country: effectiveContext.invoice_counterpart_country || null,
      invoice_counterpart_name: effectiveContext.invoice_counterpart_name || null,
      invoice_counterpart_branch: effectiveContext.invoice_counterpart_branch ?? 0,
      payment_method_type: effectiveContext.payment_method_type || 1,
      payment_method_info: effectiveContext.payment_method_info || null,
    },
    climateSnapshot: {
      unified_takk_policy: reservation.unifiedTakkPolicy ? {
        id: reservation.unifiedTakkPolicy.id, version: reservation.unifiedTakkPolicy.version,
        policy_hash: reservation.unifiedTakkPolicy.policyHash, licensed_category: reservation.unifiedTakkPolicy.licensedCategory,
        fee_lines: reservation.unifiedTakkPolicy.feeLines,
      } : null,
      property_type: billingContext.property_type,
      climate_fee_high: billingContext.climate_fee_high,
      climate_fee_low: billingContext.climate_fee_low,
      climate_fee_high_category: billingContext.climate_fee_high_category,
      climate_fee_low_category: billingContext.climate_fee_low_category,
    },
  };
  const climate = climateAmounts(reservation, billingContext);
  const climateSeries = climate.grossValue > 0
    ? normalizeSeries(reservation.unifiedTakkPolicy?.series || billingContext.climate_fee_series || 'TAKK', { fieldName: 'climate_fee_series', required: true })
    : null;

  // Primary and TAKK are one fiscal materialization unit. If either XML or DB
  // insert fails, the transaction rolls back both documents and both sequence
  // increments, preventing a half-created stay from reaching daily close.
  const materialize = async (trx) => {
    if (trx.client.config.client === 'pg') {
      // Serialize every fiscal revision of one reservation across all app
      // instances. This turns concurrent webhook/backfill materialization into
      // an idempotent read-after-first-write instead of duplicate-key failures.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `fiscal-materialization:${base.companyId}:${base.reservationId}:${revisionSuffix || 'r0'}`,
      ]);
    }
    const primary = await createDocumentOnce({
      transaction: trx,
      ...base,
      documentKey: `${base.companyId}:${base.reservationId}:primary${revisionSuffix}`,
      documentKind: invoiceType === '2.1' ? 'service_invoice' : 'service_receipt',
      documentType: invoiceType,
      series,
      amounts: primaryAmounts(reservation),
      sourcePayload,
      buildXml: (aa) => generateMyDataXML({ ...reservation, invoiceType }, { ...effectiveContext, invoice_series: series }, aa),
    });

    let climateDocument = null;
    if (climate.grossValue > 0) climateDocument = await createDocumentOnce({
      transaction: trx,
      ...base,
      documentKey: `${base.companyId}:${base.reservationId}:climate${revisionSuffix}`,
      documentKind: 'climate_fee_receipt',
      documentType: '8.2',
      series: climateSeries,
      amounts: climate,
      sourcePayload,
      buildXml: (aa) => generateClimateFeeXML(reservation, { ...billingContext, climate_fee_series: climateSeries }, aa),
    });
    return { primary, climate: climateDocument };
  };
  if (options.transaction) return materialize(options.transaction);
  return db.transaction(materialize);
}

module.exports = { prepareReservationDocuments, primaryAmounts, climateAmounts };

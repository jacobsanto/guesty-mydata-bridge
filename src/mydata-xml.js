'use strict';

const { create } = require('xmlbuilder2');
const { normalizeAndValidateGreekVat, normalizeCounterpart, normalizeSeries, validateAccommodationClimatePair } = require('./validation/fiscal-fields');

// -------------------------------------------------------------------
// Κλιματικό Τέλος Ανθεκτικότητας (2025)
// Μάρτιος–Οκτώβριος = High Season
// -------------------------------------------------------------------
function calculateClimateFeePerNight(checkInDate, listingConfig) {
  if (!checkInDate) throw new Error('checkInDate είναι απαραίτητο');

  const month = new Date(checkInDate).getMonth() + 1;
  const isHighSeason = month >= 3 && month <= 10;

  if (listingConfig && typeof listingConfig === 'object') {
    const configuredFee = isHighSeason ? listingConfig.climate_fee_high : listingConfig.climate_fee_low;
    if (configuredFee !== undefined && configuredFee !== null && configuredFee !== '') {
      return Number(configuredFee);
    }
    throw new Error(`Explicit ${isHighSeason ? 'high' : 'low'}-season climate fee is required for this listing`);
  }

  const propertyType = typeof listingConfig === 'string' ? listingConfig : listingConfig?.property_type;
  if (propertyType === 'villa' || propertyType === 'monokatoikia') {
    return isHighSeason ? 15.00 : 4.00;
  }
  // apartment (default)
  return isHighSeason ? 10.00 : 1.50;
}

// -------------------------------------------------------------------
// Κύρια συνάρτηση — παράγει myDATA-compliant XML (v2.0.1 schema namespace remains v1.0)
// Managed properties issue accommodation services with VAT 13%. The actual
// contractual recipient—not the OTA/payment collector—determines 11.2 vs 2.1.
// billingContext = joined company + listing object
// -------------------------------------------------------------------
function generateMyDataXML(reservation, billingContext, invoiceAA) {
  const {
    checkIn,
    checkOut,
    nights,
    financials,
  } = reservation;

  if (!checkOut) throw new Error('checkOut είναι απαραίτητο');
  if (!financials?.totalGross) throw new Error('financials.totalGross είναι απαραίτητο');

  const grossValue = parseFloat(financials.totalGross);
  if (!Number.isFinite(grossValue) || grossValue <= 0) {
    throw new Error('financials.totalGross must be a positive number');
  }
  const vatRate = 0.13;
  const netValue = parseFloat((grossValue / (1 + vatRate)).toFixed(2));
  const vatAmount = parseFloat((grossValue - netValue).toFixed(2));
  // The climate-crisis resilience fee is a separate myDATA document (type 8.2),
  // not a fee line on the accommodation receipt. Its fiscal treatment is therefore
  // intentionally not guessed in this document generator.
  void checkIn;
  void nights;
  const totalGross = grossValue;
  const invoiceType = reservation.invoiceType || billingContext.default_invoice_type;
  const counterpart = invoiceType === '2.1' ? (reservation.invoiceCounterpart || (
    billingContext.invoice_counterpart_vat_number
      ? {
          vatNumber: billingContext.invoice_counterpart_vat_number,
          country: billingContext.invoice_counterpart_country,
          name: billingContext.invoice_counterpart_name,
          branch: billingContext.invoice_counterpart_branch,
        }
      : null
  )) : null;
  const classificationType = invoiceType === '11.2' ? 'E3_561_003' : 'E3_561_007';

  if (!['11.2', '2.1'].includes(invoiceType)) {
    throw new Error('A listing default_invoice_type or reservation.invoiceType of 11.2 or 2.1 is required');
  }

  if (invoiceType === '2.1' && (!counterpart?.vatNumber || !counterpart?.country)) {
    throw new Error('invoiceCounterpart.vatNumber and invoiceCounterpart.country are required for invoice type 2.1');
  }
  const normalizedCounterpart = counterpart
    ? normalizeCounterpart(counterpart, { required: invoiceType === '2.1', label: 'invoiceCounterpart' })
    : null;
  const series = normalizeSeries(billingContext.invoice_series || 'A', { required: true });

  // Ημερομηνία έκδοσης = ημέρα check-out (ISO: YYYY-MM-DD)
  const invoiceDate = checkOut.substring(0, 10);

  // -------------------------------------------------------------------
  // XML build με xmlbuilder2 — strict typing, no string concat
  // -------------------------------------------------------------------
  const invoice = create({ version: '1.0', encoding: 'utf-8' })
    .ele('InvoicesDoc', {
      xmlns: 'http://www.aade.gr/myDATA/invoice/v1.0',
      'xmlns:icls': 'https://www.aade.gr/myDATA/incomeClassificaton/v1.0',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    })
    .ele('invoice');

  // ── Issuer ──────────────────────────────────────────────────────
  addIssuer(invoice, billingContext);

  // ── Counterpart — required for approved B2B service invoices (2.1) ──
  if (normalizedCounterpart) {
    const counterpartNode = invoice.ele('counterpart')
      .ele('vatNumber').txt(normalizedCounterpart.vatNumber).up()
      .ele('country').txt(normalizedCounterpart.country).up()
      .ele('branch').txt(String(normalizedCounterpart.branch)).up();
    if (normalizedCounterpart.name) counterpartNode.ele('name').txt(normalizedCounterpart.name).up();
    counterpartNode.up();
  }

  // ── Invoice Header ──────────────────────────────────────────────
  invoice.ele('invoiceHeader')
        .ele('series').txt(series).up()
        .ele('aa').txt(String(invoiceAA)).up()
        .ele('issueDate').txt(invoiceDate).up()
        .ele('invoiceType').txt(invoiceType).up()
        .ele('currency').txt('EUR').up()
      .up();

  addPaymentMethod(invoice, billingContext, totalGross);

  // ── Invoice Details — Γραμμή 1: Αξία Διαμονής ──────────────────
  invoice.ele('invoiceDetails')
        .ele('lineNumber').txt('1').up()
        .ele('netValue').txt(netValue.toFixed(2)).up()
        .ele('vatCategory').txt('2').up()          // 2 = 13% ΦΠΑ
        .ele('vatAmount').txt(vatAmount.toFixed(2)).up()
        .ele('discountOption').txt('false').up()
        // Retail/private: E3_561_003. Approved B2B route: E3_561_007.
        .ele('incomeClassification')
          .ele('icls:classificationType').txt(classificationType).up()
          .ele('icls:classificationCategory').txt('category1_3').up()
          .ele('icls:amount').txt(netValue.toFixed(2)).up()
        .up()
      .up();

  // ── Invoice Summary (υποχρεωτικό από ΑΑΔΕ) ─────────────────────
  invoice.ele('invoiceSummary')
        .ele('totalNetValue').txt(netValue.toFixed(2)).up()
        .ele('totalVatAmount').txt(vatAmount.toFixed(2)).up()
        .ele('totalWithheldAmount').txt('0.00').up()
        .ele('totalFeesAmount').txt('0.00').up()
        .ele('totalStampDutyAmount').txt('0.00').up()
        .ele('totalOtherTaxesAmount').txt('0.00').up()
        .ele('totalDeductionsAmount').txt('0.00').up()
        .ele('totalGrossValue').txt(totalGross.toFixed(2)).up()
        // Summary income classification
        .ele('incomeClassification')
          .ele('icls:classificationType').txt(classificationType).up()
          .ele('icls:classificationCategory').txt('category1_3').up()
          .ele('icls:amount').txt(netValue.toFixed(2)).up()
        .up()
      .up();

  return invoice.doc().end({ prettyPrint: true });
}

function addIssuer(invoice, billingContext) {
  invoice.ele('issuer')
    .ele('vatNumber').txt(normalizeAndValidateGreekVat(billingContext.vat_number)).up()
    .ele('country').txt('GR').up()
    .ele('branch').txt('0').up()
  .up();
}

function addPaymentMethod(invoice, billingContext, amount) {
  const type = Number(billingContext.payment_method_type || 1);
  const details = invoice.ele('paymentMethods').ele('paymentMethodDetails')
    .ele('type').txt(String(type)).up()
    .ele('amount').txt(Number(amount).toFixed(2)).up();
  if (billingContext.payment_method_info) details.ele('paymentMethodInfo').txt(billingContext.payment_method_info).up();
  details.up().up();
}

function climateFeeCategory(checkInDate, listingConfig) {
  const month = new Date(checkInDate).getMonth() + 1;
  const highSeason = month >= 3 && month <= 10;
  validateAccommodationClimatePair(listingConfig.property_type, listingConfig.climate_fee_high_category, listingConfig.climate_fee_low_category);
  const category = highSeason ? listingConfig.climate_fee_high_category : listingConfig.climate_fee_low_category;
  if (!Number.isInteger(Number(category))) {
    throw new Error('A climate-fee AADE other-tax category is required for this listing and season');
  }
  return Number(category);
}

function stayDates(checkIn, nights) {
  const start = new Date(`${checkIn}T12:00:00Z`);
  return Array.from({ length: Number(nights) }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

/**
 * Generates the separate AADE 8.2 climate-crisis resilience-fee document.
 * Each stay night is preserved as its own XML row for a faithful customer PDF.
 */
function generateClimateFeeXML(reservation, billingContext, invoiceAA) {
  if (!reservation?.checkIn || !reservation?.checkOut || !Number(reservation.nights)) {
    throw new Error('checkIn, checkOut and nights are required for an 8.2 document');
  }

  const dates = stayDates(reservation.checkIn, reservation.nights);
  const feeLines = Array.isArray(reservation.climateFeeLines)
    ? reservation.climateFeeLines.map((line) => ({
      date: String(line.date), amount: Number(line.amount ?? (Number(line.cents) / 100)), category: Number(line.category),
    }))
    : dates.map((date) => ({
      date,
      amount: Number(calculateClimateFeePerNight(date, billingContext).toFixed(2)),
      category: climateFeeCategory(date, billingContext),
    }));
  if (feeLines.length !== dates.length || feeLines.some((line, index) => line.date !== dates[index]
      || !Number.isFinite(line.amount) || line.amount <= 0 || !Number.isInteger(line.category) || line.category <= 0)) {
    throw new Error('Frozen TAKK fee lines must exactly cover each stay night with valid amount and AADE category');
  }
  const totalFee = feeLines.reduce((sum, line) => sum + line.amount, 0);
  const invoiceDate = reservation.checkOut.slice(0, 10);
  const series = normalizeSeries(billingContext.climate_fee_series || billingContext.invoice_series || 'A', { fieldName: 'climate_fee_series', required: true });
  const invoice = create({ version: '1.0', encoding: 'utf-8' })
    .ele('InvoicesDoc', {
      xmlns: 'http://www.aade.gr/myDATA/invoice/v1.0',
      'xmlns:icls': 'https://www.aade.gr/myDATA/incomeClassificaton/v1.0',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    })
    .ele('invoice');

  addIssuer(invoice, billingContext);
  invoice.ele('invoiceHeader')
    .ele('series').txt(series).up()
    .ele('aa').txt(String(invoiceAA)).up()
    .ele('issueDate').txt(invoiceDate).up()
    .ele('invoiceType').txt('8.2').up()
    .ele('currency').txt('EUR').up()
  .up();

  addPaymentMethod(invoice, billingContext, totalFee);

  feeLines.forEach((line, index) => {
    invoice.ele('invoiceDetails')
      .ele('lineNumber').txt(String(index + 1)).up()
      .ele('netValue').txt('0.00').up()
      .ele('vatCategory').txt('8').up()
      .ele('vatAmount').txt('0.00').up()
      .ele('discountOption').txt('false').up()
      .ele('otherTaxesPercentCategory').txt(String(line.category)).up()
      .ele('otherTaxesAmount').txt(line.amount.toFixed(2)).up()
      .ele('incomeClassification')
        .ele('icls:classificationCategory').txt('category1_95').up()
        .ele('icls:amount').txt('0.00').up()
      .up()
    .up();
  });

  invoice.ele('invoiceSummary')
    .ele('totalNetValue').txt('0.00').up()
    .ele('totalVatAmount').txt('0.00').up()
    .ele('totalWithheldAmount').txt('0.00').up()
    .ele('totalFeesAmount').txt('0.00').up()
    .ele('totalStampDutyAmount').txt('0.00').up()
    .ele('totalOtherTaxesAmount').txt(totalFee.toFixed(2)).up()
    .ele('totalDeductionsAmount').txt('0.00').up()
    .ele('totalGrossValue').txt(totalFee.toFixed(2)).up()
    .ele('incomeClassification')
      .ele('icls:classificationCategory').txt('category1_95').up()
      .ele('icls:amount').txt('0.00').up()
    .up()
  .up();

  return invoice.doc().end({ prettyPrint: true });
}

function generateCreditXML(credit, billingContext, invoiceAA) {
  const invoiceType = credit.invoiceType;
  if (!['5.1', '11.4'].includes(invoiceType)) throw new Error('Credit invoice type must be 5.1 or 11.4');
  if (invoiceType === '5.1' && !credit.correlatedMark) throw new Error('A correlated original MARK is required for 5.1');
  const grossValue = Number(credit.grossValue);
  if (!Number.isFinite(grossValue) || grossValue <= 0) throw new Error('Credit grossValue must be positive');
  const netValue = Number((grossValue / 1.13).toFixed(2));
  const vatAmount = Number((grossValue - netValue).toFixed(2));
  const classificationType = invoiceType === '11.4' ? 'E3_561_003' : 'E3_561_007';
  const series = normalizeSeries(credit.series, { required: true });
  const invoice = create({ version: '1.0', encoding: 'utf-8' })
    .ele('InvoicesDoc', {
      xmlns: 'http://www.aade.gr/myDATA/invoice/v1.0',
      'xmlns:icls': 'https://www.aade.gr/myDATA/incomeClassificaton/v1.0',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    }).ele('invoice');
  addIssuer(invoice, billingContext);
  if (invoiceType === '5.1') {
    const counterpart = normalizeCounterpart({
      vatNumber: billingContext.invoice_counterpart_vat_number,
      country: billingContext.invoice_counterpart_country,
      name: billingContext.invoice_counterpart_name,
      branch: billingContext.invoice_counterpart_branch,
    }, { required: true, label: 'invoice_counterpart' });
    invoice.ele('counterpart')
      .ele('vatNumber').txt(counterpart.vatNumber).up()
      .ele('country').txt(counterpart.country).up()
      .ele('branch').txt(String(counterpart.branch)).up()
      .ele('name').txt(counterpart.name || '').up()
    .up();
  }
  const header = invoice.ele('invoiceHeader')
    .ele('series').txt(series).up()
    .ele('aa').txt(String(invoiceAA)).up()
    .ele('issueDate').txt(credit.issueDate).up()
    .ele('invoiceType').txt(invoiceType).up()
    .ele('currency').txt('EUR').up();
  if (credit.correlatedMark) header.ele('correlatedInvoices').txt(String(credit.correlatedMark)).up();
  header.up();
  invoice.ele('invoiceDetails')
    .ele('lineNumber').txt('1').up()
    .ele('netValue').txt(netValue.toFixed(2)).up()
    .ele('vatCategory').txt('2').up()
    .ele('vatAmount').txt(vatAmount.toFixed(2)).up()
    .ele('discountOption').txt('false').up()
    .ele('incomeClassification')
      .ele('icls:classificationType').txt(classificationType).up()
      .ele('icls:classificationCategory').txt('category1_3').up()
      .ele('icls:amount').txt(netValue.toFixed(2)).up()
    .up().up();
  invoice.ele('invoiceSummary')
    .ele('totalNetValue').txt(netValue.toFixed(2)).up()
    .ele('totalVatAmount').txt(vatAmount.toFixed(2)).up()
    .ele('totalWithheldAmount').txt('0.00').up()
    .ele('totalFeesAmount').txt('0.00').up()
    .ele('totalStampDutyAmount').txt('0.00').up()
    .ele('totalOtherTaxesAmount').txt('0.00').up()
    .ele('totalDeductionsAmount').txt('0.00').up()
    .ele('totalGrossValue').txt(grossValue.toFixed(2)).up()
    .ele('incomeClassification')
      .ele('icls:classificationType').txt(classificationType).up()
      .ele('icls:classificationCategory').txt('category1_3').up()
      .ele('icls:amount').txt(netValue.toFixed(2)).up()
    .up().up();
  return invoice.doc().end({ prettyPrint: true });
}

module.exports = { generateMyDataXML, generateClimateFeeXML, generateCreditXML, calculateClimateFeePerNight };

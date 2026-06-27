'use strict';

const { create } = require('xmlbuilder2');

// -------------------------------------------------------------------
// Κλιματικό Τέλος Ανθεκτικότητας (2025)
// Μάρτιος–Οκτώβριος = High Season
// -------------------------------------------------------------------
function calculateClimateFeePerNight(checkInDate, propertyType) {
  if (!checkInDate) throw new Error('checkInDate είναι απαραίτητο');

  const month = new Date(checkInDate).getMonth() + 1;
  const isHighSeason = month >= 3 && month <= 10;

  if (propertyType === 'villa' || propertyType === 'monokatoikia') {
    return isHighSeason ? 15.00 : 4.00;
  }
  // apartment (default)
  return isHighSeason ? 10.00 : 1.50;
}

// -------------------------------------------------------------------
// Κύρια συνάρτηση — παράγει myDATA-compliant XML (v1.0.9)
// invoiceType 11.1 = Απόδειξη Λιανικής Βραχυχρόνιας Μίσθωσης
// -------------------------------------------------------------------
function generateMyDataXML(reservation, tenant, invoiceAA) {
  const {
    reservationId,
    checkIn,
    checkOut,
    nights,
    financials,
  } = reservation;

  if (!checkOut) throw new Error('checkOut είναι απαραίτητο');
  if (!financials?.totalGross) throw new Error('financials.totalGross είναι απαραίτητο');

  const netValue = parseFloat(financials.totalGross);
  const feePerNight = calculateClimateFeePerNight(checkIn, tenant.property_type);
  const totalNights = parseInt(nights || 1);
  const climateFee = parseFloat((feePerNight * totalNights).toFixed(2));
  const totalGross = parseFloat((netValue + climateFee).toFixed(2));

  // Ημερομηνία έκδοσης = ημέρα check-out (ISO: YYYY-MM-DD)
  const invoiceDate = checkOut.substring(0, 10);

  // -------------------------------------------------------------------
  // XML build με xmlbuilder2 — strict typing, no string concat
  // -------------------------------------------------------------------
  const doc = create({ version: '1.0', encoding: 'utf-8' })
    .ele('InvoicesDoc', {
      xmlns: 'http://www.aade.gr/myDATA/invoice/v1.0',
      'xmlns:icls': 'https://www.aade.gr/myDATA/incomeClassificaton/v1.0',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    })
    .ele('invoice')

      // ── Issuer ────────────────────────────────────────────────────
      .ele('issuer')
        .ele('vatNumber').txt(tenant.vat_number).up()
        .ele('country').txt('GR').up()
        .ele('branch').txt('0').up()       // 0 = έδρα
      .up()

      // ── Invoice Header ────────────────────────────────────────────
      .ele('invoiceHeader')
        .ele('series').txt(tenant.invoice_series || 'A').up()
        .ele('aa').txt(String(invoiceAA)).up()
        .ele('issueDate').txt(invoiceDate).up()
        .ele('invoiceType').txt('11.1').up()  // Απόδειξη Λιανικής
        .ele('currency').txt('EUR').up()
        .ele('correlatedInvoices').txt(reservationId || '').up()
      .up()

      // ── Invoice Details — Γραμμή 1: Αξία Διαμονής ────────────────
      .ele('invoiceDetails')
        .ele('lineNumber').txt('1').up()
        .ele('netValue').txt(netValue.toFixed(2)).up()
        .ele('vatCategory').txt('7').up()          // 7 = 0% ΦΠΑ
        .ele('vatExemptionCategory').txt('28').up() // 28 = Βραχυχρόνια μίσθωση
        .ele('vatAmount').txt('0.00').up()
        .ele('discountOption').txt('false').up()
        // Κατηγορία εσόδων E3_561_007 = Πωλήσεις αγαθών/υπηρεσιών βραχυχρόνιας μίσθωσης
        .ele('icls:incomeClassification')
          .ele('icls:classificationType').txt('E3_561_007').up()
          .ele('icls:classificationCategory').txt('category1_1').up()
          .ele('icls:amount').txt(netValue.toFixed(2)).up()
        .up()
      .up()

      // ── Invoice Details — Γραμμή 2: Κλιματικό Τέλος ─────────────
      .ele('invoiceDetails')
        .ele('lineNumber').txt('2').up()
        .ele('netValue').txt(climateFee.toFixed(2)).up()
        .ele('vatCategory').txt('7').up()
        .ele('vatExemptionCategory').txt('28').up()
        .ele('vatAmount').txt('0.00').up()
        .ele('discountOption').txt('false').up()
        .ele('feesPercentCategory').txt('9').up() // Κωδικός ΑΑΔΕ: Κλιματική Κρίση
        .ele('icls:incomeClassification')
          .ele('icls:classificationType').txt('E3_561_007').up()
          .ele('icls:classificationCategory').txt('category1_1').up()
          .ele('icls:amount').txt(climateFee.toFixed(2)).up()
        .up()
      .up()

      // ── Invoice Summary (υποχρεωτικό από ΑΑΔΕ) ───────────────────
      .ele('invoiceSummary')
        .ele('totalNetValue').txt(totalGross.toFixed(2)).up()
        .ele('totalVatAmount').txt('0.00').up()
        .ele('totalWithheldAmount').txt('0.00').up()
        .ele('totalFeesAmount').txt(climateFee.toFixed(2)).up()
        .ele('totalStampDutyAmount').txt('0.00').up()
        .ele('totalOtherTaxesAmount').txt('0.00').up()
        .ele('totalDeductionsAmount').txt('0.00').up()
        .ele('totalGrossValue').txt(totalGross.toFixed(2)).up()
        // Summary income classification
        .ele('icls:incomeClassification')
          .ele('icls:classificationType').txt('E3_561_007').up()
          .ele('icls:classificationCategory').txt('category1_1').up()
          .ele('icls:amount').txt(totalGross.toFixed(2)).up()
        .up()
      .up()

    .up() // invoice
  .up(); // InvoicesDoc

  return doc.end({ prettyPrint: true });
}

module.exports = { generateMyDataXML, calculateClimateFeePerNight };

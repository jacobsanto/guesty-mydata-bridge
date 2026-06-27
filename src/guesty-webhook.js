'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const {
  findInvoiceByReservationId,
  createInvoiceRecord,
  updateInvoiceRecord,
} = require('./database');
const { incrementCompanyInvoiceCounter } = require('./repositories/companies');
const { getCompanyAndListingByGuestyListingId } = require('./repositories/listings');
const { generateMyDataXML, calculateClimateFeePerNight } = require('./mydata-xml');
const { sendToMyData } = require('./mydata-client');

// -------------------------------------------------------------------
// Κατάσταση κράτησης που οδηγεί σε τιμολόγηση
// -------------------------------------------------------------------
const BILLABLE_STATUSES = new Set(['confirmed', 'checked_out']);

// -------------------------------------------------------------------
// HMAC-SHA256 Signature Validation (Guesty Pro)
// Guesty στέλνει: x-guesty-signature: sha256=<hex>
// Docs: https://open-api-docs.guesty.com/docs/webhooks
// -------------------------------------------------------------------
function verifyGuestySignature(req) {
  const secret = process.env.GUESTY_WEBHOOK_SECRET;

  // Αν δεν έχει οριστεί secret, skip validation μόνο σε development
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('GUESTY_WEBHOOK_SECRET δεν έχει οριστεί σε production');
    }
    console.warn('⚠️  GUESTY_WEBHOOK_SECRET δεν έχει οριστεί — παράλειψη signature validation (dev only)');
    return true;
  }

  const signature = req.headers['x-guesty-signature'];
  if (!signature) return false;

  // Χρειαζόμαστε raw body για το HMAC — βλ. server.js setup
  const rawBody = req.rawBody;
  if (!rawBody) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time σύγκριση για αποφυγή timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// -------------------------------------------------------------------
// POST /webhook/guesty-reservation
// -------------------------------------------------------------------
router.post('/webhook/guesty-reservation', async (req, res) => {
  // 1. Signature validation
  try {
    if (!verifyGuestySignature(req)) {
      console.warn('🚫 Μη έγκυρη signature — απόρριψη webhook');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const reservation = req.body;

  // 2. Βασική επικύρωση payload
  if (!reservation?.reservationId || !reservation?.listingId) {
    return res.status(400).json({ error: 'Missing reservationId or listingId' });
  }

  // 3. Έλεγχος status
  if (!BILLABLE_STATUSES.has(reservation.status)) {
    return res.status(200).json({
      message: `Ignored: status "${reservation.status}" is not billable`,
    });
  }

  // 4. Idempotency check — αν έχει ήδη τιμολογηθεί, επιστρέφουμε το υπάρχον MARK
  const existing = await findInvoiceByReservationId(reservation.reservationId);
  if (existing) {
    console.log(`ℹ️  Duplicate webhook για κράτηση ${reservation.reservationId} — επιστροφή υπάρχοντος MARK`);
    return res.status(200).json({
      message: 'Already processed',
      mark: existing.mydata_mark,
      status: existing.status,
    });
  }

  // 5. Εύρεση company + listing βάσει Guesty listing_id
  const companyListing = await getCompanyAndListingByGuestyListingId(reservation.listingId);
  if (!companyListing) {
    console.error(`💥 Δεν βρέθηκε company/listing mapping για listing: ${reservation.listingId}`);
    return res.status(404).json({
      error: `No company/listing mapping configured for listingId: ${reservation.listingId}`,
    });
  }

  if (!companyListing.company_active || !companyListing.listing_active) {
    return res.status(409).json({
      error: `Inactive mapping for listingId: ${reservation.listingId}`,
    });
  }

  // 6. Αύξηση invoice counter στο company επίπεδο
  const invoiceAA = await incrementCompanyInvoiceCounter(companyListing.company_id);

  // 7. Δημιουργία XML
  let xmlPayload;
  try {
    xmlPayload = generateMyDataXML(reservation, companyListing, invoiceAA);
  } catch (err) {
    console.error('❌ Αποτυχία δημιουργίας XML:', err.message);
    return res.status(422).json({ error: 'XML generation failed: ' + err.message });
  }

  // 8. Αποθήκευση εγγραφής με status=pending (πριν την αποστολή)
  const netValue = parseFloat(reservation.financials?.totalGross || 0);
  const nights = reservation.nights || 0;
  const climateFee = parseFloat(
    calculateClimateFeePerNight(reservation.checkIn, companyListing.property_type) * nights
  );

  const invoiceId = await createInvoiceRecord({
    company_id: companyListing.company_id,
    listing_id: companyListing.listing_id,
    reservation_id: reservation.reservationId,
    listing_id_guesty: reservation.listingId,
    vat_number: companyListing.vat_number,
    invoice_series: companyListing.invoice_series,
    invoice_aa: invoiceAA,
    net_value: netValue,
    climate_fee: climateFee,
    total_gross: netValue + climateFee,
    status: 'pending',
    xml_payload: xmlPayload,
  });

  // 9. Αποστολή στην ΑΑΔΕ
  try {
    const myDataResponse = await sendToMyData(xmlPayload, companyListing);

    await updateInvoiceRecord(invoiceId, {
      status: 'sent',
      mydata_mark: myDataResponse.mark,
      mydata_uid: myDataResponse.uid || null,
      sent_at: new Date().toISOString(),
    });

    console.log(`✅ ΑΦΜ: ${companyListing.vat_number} | Κράτηση: ${reservation.reservationId} | MARK: ${myDataResponse.mark}`);

    return res.status(200).json({
      message: 'Invoice processed successfully',
      mark: myDataResponse.mark,
      invoice_aa: invoiceAA,
      series: companyListing.invoice_series,
      company_id: companyListing.company_id,
      listing_id: companyListing.listing_id,
    });

  } catch (err) {
    await updateInvoiceRecord(invoiceId, {
      status: 'failed',
      error_message: err.message,
    });

    console.error(`❌ myDATA αποτυχία για κράτηση ${reservation.reservationId}:`, err.message);
    return res.status(502).json({
      error: 'myDATA submission failed',
      detail: err.message,
    });
  }
});

module.exports = router;

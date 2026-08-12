'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { getCompanyAndListingByGuestyListingId } = require('./repositories/listings');
const { stageReservation } = require('./services/reservation-service');
const { normalizeGuestyReservation } = require('./guesty/normalizer');
const { fetchReservation } = require('./guesty/client');
const {
  claimGuestyWebhookEvent,
  completeGuestyWebhookEvent,
  releaseGuestyWebhookEvent,
} = require('./repositories/integration-checks');

// -------------------------------------------------------------------
// Κατάσταση κράτησης που οδηγεί σε τιμολόγηση
// -------------------------------------------------------------------
const RELEVANT_STATUSES = new Set(['confirmed', 'checked_out', 'cancelled', 'canceled']);

// -------------------------------------------------------------------
// HMAC-SHA256 Signature Validation (Guesty Pro)
// Guesty στέλνει: x-guesty-signature: sha256=<hex>
// Docs: https://open-api-docs.guesty.com/docs/webhooks
// -------------------------------------------------------------------
function verifyGuestySignature(req) {
  const secret = process.env.GUESTY_WEBHOOK_SECRET;

  // Αν δεν έχει οριστεί secret, skip validation μόνο σε development
  if (!secret) {
    const explicitlyInsecureDevelopment = process.env.NODE_ENV !== 'production'
      && process.env.ALLOW_INSECURE_DEV === 'true';
    if (explicitlyInsecureDevelopment) {
      console.warn('⚠️  Guesty signature validation disabled by ALLOW_INSECURE_DEV (dev only)');
      return true;
    }
    throw new Error('GUESTY_WEBHOOK_SECRET δεν έχει οριστεί');
  }

  // Χρειαζόμαστε raw body για το HMAC — βλ. server.js setup.
  const rawBody = req.rawBody;
  if (!rawBody) return false;

  // Current Guesty webhooks use Svix signing.
  const svixId = req.headers['svix-id'];
  const svixTimestamp = req.headers['svix-timestamp'];
  const svixSignature = req.headers['svix-signature'];
  if (svixId && svixTimestamp && svixSignature) {
    if (!/^\d+$/.test(String(svixTimestamp))) return false;
    const timestampSeconds = Number(svixTimestamp);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;
    const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
    const expected = crypto.createHmac('sha256', key)
      .update(`${svixId}.${svixTimestamp}.${rawBody}`)
      .digest('base64');
    const candidates = String(svixSignature).split(' ').map((entry) => entry.split(',')[1]).filter(Boolean);
    return candidates.some((candidate) => {
      const actual = Buffer.from(candidate);
      const wanted = Buffer.from(expected);
      return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
    });
  }

  // Backward compatibility for legacy Guesty webhook subscriptions.
  const signature = req.headers['x-guesty-signature'];
  if (!signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time σύγκριση για αποφυγή timing attacks
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
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

  let reservation;
  try {
    reservation = normalizeGuestyReservation(req.body);
    const cancellationRequiresAuthoritativeRefresh = ['cancelled', 'canceled'].includes(reservation.status);
    const incompleteFiscalPayload = !reservation.financials?.totalGross || !reservation.status;
    if (cancellationRequiresAuthoritativeRefresh || incompleteFiscalPayload) {
      if (!process.env.GUESTY_CLIENT_ID || !process.env.GUESTY_CLIENT_SECRET) {
        throw new Error('Guesty credentials are required for authoritative reservation enrichment');
      }
      const full = await fetchReservation(reservation.reservationId);
      reservation = normalizeGuestyReservation(full);
    }
  } catch (error) {
    const reservationId = req.body?.reservation?._id
      || req.body?.reservation?.reservationId
      || req.body?.reservation?.id
      || req.body?._id
      || req.body?.reservationId
      || req.body?.id;
    if (!reservationId || !process.env.GUESTY_CLIENT_ID || !process.env.GUESTY_CLIENT_SECRET) {
      return res.status(422).json({ error: `Invalid Guesty reservation payload: ${error.message}` });
    }
    try {
      reservation = normalizeGuestyReservation(await fetchReservation(reservationId));
    } catch (fetchError) {
      return res.status(502).json({ error: `Guesty reservation enrichment failed: ${fetchError.message}` });
    }
  }

  // 2. Βασική επικύρωση payload
  // 3. Έλεγχος status
  if (!RELEVANT_STATUSES.has(reservation.status)) {
    return res.status(200).json({
      message: `Ignored: status "${reservation.status}" is not billable`,
    });
  }

  // 4. Εύρεση company + listing βάσει Guesty listing_id
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

  // Claim only after payload/mapping validation. This prevents concurrent or
  // repeated delivery from staging the same signed event more than once while
  // still allowing Guesty to retry configuration/enrichment failures.
  const eventIdentity = req.headers['svix-id']
    ? `svix:${req.headers['svix-id']}`
    : `legacy:${crypto.createHash('sha256').update(req.rawBody || '').digest('hex')}`;
  if (!await claimGuestyWebhookEvent(eventIdentity)) {
    return res.status(200).json({ message: 'Duplicate webhook ignored' });
  }

  // 5. Αποθήκευση του τελευταίου snapshot. Τα παραστατικά δημιουργούνται στο
  // ημερήσιο κλείσιμο από τα πιο πρόσφατα οικονομικά στοιχεία της Guesty.
  try {
    const snapshot = await stageReservation(reservation, companyListing);
    await completeGuestyWebhookEvent(eventIdentity);
    return res.status(202).json({
      message: 'Reservation staged for daily close',
      company_id: companyListing.company_id,
      listing_id: companyListing.listing_id,
      reservation_id: snapshot.reservation_id,
      status: snapshot.status,
      materialized: Boolean(snapshot.materialized_at),
      requires_review: Boolean(snapshot.requires_review),
    });
  } catch (err) {
    await releaseGuestyWebhookEvent(eventIdentity);
    console.error('❌ Αποτυχία προετοιμασίας παραστατικών:', err.message);
    return res.status(422).json({ error: 'Fiscal document preparation failed: ' + err.message });
  }
});

module.exports = router;
module.exports.verifyGuestySignature = verifyGuestySignature;

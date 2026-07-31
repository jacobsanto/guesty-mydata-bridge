'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { getListingById } = require('../repositories/listings');
const {
  listFinancialProfiles,
  getFinancialProfileById,
  getApprovedFinancialProfile,
  createNextFinancialProfileVersion,
  updateDraftFinancialProfile,
  recordCalibrationSample,
  listCalibrationSamples,
  approveFinancialProfile,
  suspendFinancialProfile,
} = require('../repositories/financial-profiles');
const { evaluateFolio, normalizeChannelKey, validateLineRules } = require('./financial-rule-engine');
const { fetchReservation } = require('../guesty/client');
const { normalizeGuestyReservation } = require('../guesty/normalizer');

function serviceError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function rulesFrom(payload) {
  const value = payload.line_rules ?? payload.lineRules;
  let rules = value;
  if (typeof value === 'string') {
    try { rules = JSON.parse(value); } catch { throw serviceError('line_rules must be valid JSON'); }
  }
  try { return validateLineRules(rules); } catch (error) { throw serviceError(`${error.code}: ${error.message}`); }
}

function profilePayload(payload, existing = {}) {
  const strategy = String(payload.strategy ?? existing.strategy ?? 'folio_rules');
  if (strategy !== 'folio_rules') {
    throw serviceError('Only the fail-closed folio_rules strategy is supported for fiscal issuance');
  }
  return {
    ...existing,
    ...payload,
    strategy,
    platform_key: normalizeChannelKey(payload.platform_key ?? existing.platform_key),
    source_key: normalizeChannelKey(payload.source_key ?? existing.source_key),
    line_rules: rulesFrom({ line_rules: payload.line_rules ?? existing.line_rules }),
  };
}

async function listProfiles(filters = {}) {
  const profiles = await listFinancialProfiles(filters);
  return Promise.all(profiles.map(async (profile) => ({
    ...profile,
    calibration_samples: await listCalibrationSamples(profile.id),
  })));
}

async function createProfile(payload) {
  const listingId = Number(payload.listing_id);
  if (!Number.isInteger(listingId) || !await getListingById(listingId)) throw serviceError('Listing not found', 404);
  return createNextFinancialProfileVersion({ ...profilePayload(payload), listing_id: listingId });
}

async function updateProfile(id, payload) {
  const existing = await getFinancialProfileById(id);
  if (!existing) throw serviceError('Financial profile not found', 404);
  const requestedPlatform = normalizeChannelKey(payload.platform_key ?? existing.platform_key);
  const requestedSource = normalizeChannelKey(payload.source_key ?? existing.source_key);
  if (requestedPlatform !== existing.platform_key || requestedSource !== existing.source_key) {
    throw serviceError('Profile listing/platform/source keys are immutable; create a new exact profile instead', 409);
  }
  return updateDraftFinancialProfile(existing.id, profilePayload(payload, existing));
}

function evaluationError(result) {
  return (result.errors || []).map((item) => item.code).join(', ') || 'financial profile evaluation failed';
}

function evidenceHash(evidence) {
  return crypto.createHash('sha256').update(JSON.stringify(evidence || [])).digest('hex');
}

function assertSingleStayFiscalFolio(reservation) {
  if (reservation.guestStayStatus === 'no_show') {
    throw serviceError('Guesty guest stay is marked no_show and requires explicit fiscal review', 409);
  }
  const invoiceItems = reservation.fiscalInvoiceItems || reservation.financials?.invoiceItems;
  const itemListingIds = new Set((invoiceItems || []).map((item) => item.listingId).filter(Boolean).map(String));
  const stayIndexes = new Set((invoiceItems || []).map((item) => item.stayIndex).filter((value) => value !== null && value !== undefined).map(Number));
  const stayEvidence = reservation.stayEvidence;
  const affirmativeSingleStay = stayEvidence?.singleStayConfirmed === true
    && String(stayEvidence.reservationListingId) === String(reservation.listingId)
    && String(stayEvidence.folioListingId) === String(reservation.listingId);
  if (!affirmativeSingleStay || itemListingIds.size > 1
      || [...itemListingIds].some((id) => id !== String(reservation.listingId)) || stayIndexes.size > 1) {
    throw serviceError('Split, relocated, or multi-listing Guesty folio requires explicit per-stay allocation', 409);
  }
  return invoiceItems;
}

async function applyFinancialProfile(reservation, billingContext) {
  const platformKey = normalizeChannelKey(reservation.platformKey || reservation.platform);
  const sourceKey = normalizeChannelKey(reservation.sourceKey || reservation.source);
  if (!platformKey || !sourceKey) throw serviceError('Guesty platform/source are required for financial profile resolution', 409);
  const profile = await getApprovedFinancialProfile(billingContext.listing_id, platformKey, sourceKey);
  if (!profile) throw serviceError(`No approved financial profile for ${platformKey} / ${sourceKey}`, 409);
  const invoiceItems = assertSingleStayFiscalFolio(reservation);
  const result = evaluateFolio({
    invoiceItems,
    profile,
  });
  if (!result.ok) throw serviceError(`Financial profile blocked issuance: ${evaluationError(result)}`, 409);
  return {
    ...reservation,
    platformKey,
    sourceKey,
    financials: {
      ...reservation.financials,
      totalGross: result.totalGross,
      amountSource: 'approved_channel_financial_profile',
      invoiceItems,
      reconciliation: result.reconciliation,
    },
    financialProfile: {
      status: 'matched',
      id: profile.id,
      version: profile.version,
      configHash: profile.config_hash,
      evidenceHash: evidenceHash(result.evidence),
      evidence: result.evidence,
    },
  };
}

async function calibrateProfile(id, payload, { fetcher = fetchReservation } = {}) {
  const profile = await getFinancialProfileById(id);
  if (!profile) throw serviceError('Financial profile not found', 404);
  if (profile.status !== 'draft') throw serviceError('Only draft profiles can be calibrated', 409);
  const reservationId = String(payload.reservation_id || '').trim();
  const expectedAmount = Number(payload.expected_amount ?? payload.expected_gross);
  if (!reservationId) throw serviceError('reservation_id is required');
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) throw serviceError('expected_amount must be positive');
  const reservation = normalizeGuestyReservation(await fetcher(reservationId));
  const listing = await getListingById(profile.listing_id);
  if (!listing || String(listing.listing_id_guesty) !== reservation.listingId) {
    throw serviceError('Calibration reservation belongs to a different listing', 409);
  }
  if (reservation.platformKey !== profile.platform_key || reservation.sourceKey !== profile.source_key) {
    throw serviceError('Calibration reservation platform/source do not match the profile', 409);
  }
  assertSingleStayFiscalFolio(reservation);
  const result = evaluateFolio({
    invoiceItems: reservation.fiscalInvoiceItems,
    profile: { ...profile, approved: true },
  });
  if (!result.ok) throw serviceError(`Calibration blocked: ${evaluationError(result)}`, 409);
  return recordCalibrationSample(profile.id, {
    reservation_id: reservation.reservationId,
    expected_amount: expectedAmount,
    computed_amount: result.totalGross,
    channel_key: profile.platform_key,
    currency: 'EUR',
    line_evidence: result.evidence,
  });
}

async function approveProfile(id, payload) {
  return approveFinancialProfile(id, {
    approvedBy: payload.approved_by,
    notes: payload.notes ?? payload.approval_notes,
  });
}

async function suspendProfile(id, payload) {
  return suspendFinancialProfile(id, payload.notes ?? payload.approval_notes);
}

async function listObservedChannels() {
  const channels = await db('reservation_snapshots as r')
    .leftJoin('financial_profiles as p', function joinProfile() {
      this.on('p.listing_id', '=', 'r.listing_id')
        .andOn('p.platform_key', '=', 'r.platform_key')
        .andOn('p.source_key', '=', 'r.source_key')
        .andOnVal('p.status', '=', 'approved');
    })
    .select('r.listing_id', 'r.listing_id_guesty', 'r.platform_key', 'r.source_key')
    .max({ last_seen_at: 'r.updated_at' })
    .max({ approved_profile_id: 'p.id' })
    .groupBy('r.listing_id', 'r.listing_id_guesty', 'r.platform_key', 'r.source_key')
    .orderBy('r.listing_id').orderBy('r.platform_key').orderBy('r.source_key');
  return Promise.all(channels.map(async (channel) => {
    const samples = await db('reservation_snapshots').where({
      listing_id: channel.listing_id,
      platform_key: channel.platform_key,
      source_key: channel.source_key,
    }).whereNotNull('normalized_payload').orderBy('updated_at', 'desc').limit(100).select('normalized_payload', 'reservation_id');
    const signatures = new Map();
    for (const sample of samples) {
      try {
        const reservation = JSON.parse(sample.normalized_payload || '{}');
        for (const line of reservation.fiscalInvoiceItems || reservation.financials?.invoiceItems || []) {
          const observed = {
            normalType: line.normalType || null,
            origin: line.origin || null,
            title: line.title || null,
            secondIdentifier: line.secondIdentifier || null,
            isDeducted: typeof line.isDeducted === 'boolean' ? line.isDeducted : null,
            isDeductedV2: typeof line.isDeductedV2 === 'boolean' ? line.isDeductedV2 : null,
            sampleTotalPrice: Number.isFinite(Number(line.totalPrice)) ? Number(line.totalPrice) : null,
          };
          const signature = JSON.stringify(Object.fromEntries(Object.entries(observed).filter(([key]) => key !== 'sampleTotalPrice')));
          if (!signatures.has(signature)) signatures.set(signature, observed);
        }
      } catch {
        // A corrupt historical snapshot is ignored here and remains visible in
        // the reservation review queue; it cannot create an approved profile.
      }
    }
    return { ...channel, sample_reservation_id: samples[0]?.reservation_id || null, observed_lines: [...signatures.values()] };
  }));
}

module.exports = {
  listProfiles,
  createProfile,
  updateProfile,
  applyFinancialProfile,
  calibrateProfile,
  approveProfile,
  suspendProfile,
  listObservedChannels,
};

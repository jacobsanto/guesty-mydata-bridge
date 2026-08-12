'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../database');
const { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken } = require('../repositories/integration-tokens');

const TOKEN_URL = 'https://open-api.guesty.com/oauth2/token';
const API_URL = 'https://open-api.guesty.com/v1';
const FOLIO_INVOICE_ITEM_FIELDS = [
  'normalType',
  'origin',
  'title',
  'secondIdentifier',
  'totalPrice',
  'nightsSubtotal',
  'isDeducted',
  'isDeductedV2',
  'listingId',
  'stayIndex',
  'adjustments.amount',
  'adjustments.creationMethod',
  'adjustments.type',
  'adjustments.createdAt',
  'adjustments.nightsBreakdown.date',
  'adjustments.nightsBreakdown.basePrice',
];
const FOLIO_OVERVIEW_FIELDS = [
  'listingId',
  'platform',
  'source',
  'currency',
  'updatedAt',
  'canceledAt',
  'rawAccommodationFare',
  'accommodationFareNet',
  'accommodationFareIncTax',
  'totalBundledFees',
  'rawCleaningFee',
  'cleaningFeeIncTax',
  'totalFees',
  'totalFeesIncTax',
  'totalTaxes',
  'guestFeeBase',
  'guestFeeVat',
  'channelCommission',
  'channelCommissionTax',
  'channelCommissionIncTax',
  'subTotalPrice',
  'hostPayout',
  'hostOriginalPayout',
  'bundledFees.title',
  'bundledFees.type',
  'bundledFees.appliedAmount',
  'bundledFees.originalAmount',
  'bundledFees.multiplier',
  'bundledFees.targetFee',
  'bundledFees.isPercentage',
  'deductedFees.title',
  'deductedFees.type',
  'deductedFees.appliedAmount',
];
let tokenCache = null;
let tokenRefreshPromise = null;

function credentialFingerprint(clientId) {
  return crypto.createHash('sha256').update(String(clientId)).digest('hex');
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 300000) return tokenCache.value;
  if (tokenRefreshPromise) return tokenRefreshPromise;
  tokenRefreshPromise = loadOrRefreshAccessToken();
  try {
    return await tokenRefreshPromise;
  } finally {
    tokenRefreshPromise = null;
  }
}

async function loadOrRefreshAccessToken() {
  const clientId = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GUESTY_CLIENT_ID and GUESTY_CLIENT_SECRET are required');
  const fingerprint = credentialFingerprint(clientId);
  const stored = await getIntegrationToken('guesty', fingerprint, 300000);
  if (stored) {
    tokenCache = stored;
    return stored.value;
  }

  // PostgreSQL production instances share this advisory transaction lock, so
  // simultaneous restarts consume only one of Guesty's five daily token slots.
  return db.transaction(async (trx) => {
    if (db.client.config.client === 'pg') await trx.raw('SELECT pg_advisory_xact_lock(?)', [1732584193]);
    const rechecked = await getIntegrationToken('guesty', fingerprint, 300000, trx);
    if (rechecked) {
      tokenCache = rechecked;
      return rechecked.value;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials', scope: 'open-api', client_id: clientId, client_secret: clientSecret,
    });
    const response = await axios.post(TOKEN_URL, body.toString(), {
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    if (!response.data?.access_token) throw new Error('Guesty OAuth did not return an access token');
    tokenCache = {
      value: String(response.data.access_token),
      expiresAt: Date.now() + Number(response.data.expires_in || 86400) * 1000,
    };
    await saveIntegrationToken('guesty', fingerprint, tokenCache.value, tokenCache.expiresAt, trx);
    return tokenCache.value;
  });
}

async function invalidateAccessToken() {
  tokenCache = null;
  await deleteIntegrationToken('guesty');
}

async function fetchReservation(reservationId) {
  return withGuestyAuthentication((token) => fetchReservationWithToken(reservationId, token));
}

async function searchUpdatedReservationIds({ from, to, pageSize = 100, maxPages = 100 } = {}) {
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) {
    throw new Error('Guesty reconciliation requires a valid increasing ISO from/to range');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Guesty pageSize must be 1-100');
  return withGuestyAuthentication(async (token) => {
    const ids = [];
    const seen = new Set();
    const config = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 30000 };
    const filters = JSON.stringify([{ operator: '$between', field: 'lastUpdatedAt', from, to }]);
    for (let page = 0; page < maxPages; page += 1) {
      const response = await axios.get(`${API_URL}/reservations`, {
        ...config,
        params: { fields: '_id lastUpdatedAt status listingId', filters, sort: '_id', limit: pageSize, skip: page * pageSize },
      });
      const rows = Array.isArray(response.data) ? response.data : response.data?.results;
      if (!Array.isArray(rows)) throw new Error('Guesty reservation search response is malformed');
      for (const row of rows) {
        const id = String(row?._id || row?.id || '').trim();
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
      if (rows.length < pageSize) return ids;
    }
    throw new Error(`Guesty reconciliation exceeded ${maxPages * pageSize} reservations; narrow the time range`);
  });
}

async function withGuestyAuthentication(operation) {
  const token = await getAccessToken();
  try {
    return await operation(token);
  } catch (error) {
    if (![401, 403].includes(error.response?.status)) throw error;
    await invalidateAccessToken();
    return operation(await getAccessToken());
  }
}

async function fetchReservationWithToken(reservationId, token) {
  const config = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 20000 };
  const snapshot = await fetchConsistentReservationSnapshot(reservationId, {
    get: (url, requestConfig) => axios.get(url, requestConfig),
    config,
  });
  // Reservations v3 deliberately returns guest references only. Fetch the
  // smallest legacy reservation projection needed for the PDF display name,
  // and use it as an independent cross-check of the fiscal stay identity.
  const detailsResponse = await axios.get(`${API_URL}/reservations/${encodeURIComponent(reservationId)}`, {
    ...config,
    params: {
      fields: '_id listingId checkInDateLocalized checkOutDateLocalized guest.fullName status lastUpdatedAt',
    },
  });
  return mergeReservationDetails(snapshot, detailsResponse.data, reservationId);
}

function externalListingId(value) {
  if (value && typeof value === 'object') return value._id || value.id || null;
  return value || null;
}

function normalizeV3ReservationCore(row, reservationId) {
  if (!row || typeof row !== 'object') return row;
  // Live reservations-v3 responses represent the stay as an array. A fiscal
  // document must never guess how to allocate a split or relocated stay.
  if (Array.isArray(row.stay)) {
    if (row.stay.length !== 1) {
      throw new Error(`Guesty reservation ${reservationId} contains ${row.stay.length} stays and requires manual allocation`);
    }
    const stay = row.stay[0] || {};
    const listingId = externalListingId(stay.unitTypeId || stay.listingId || stay.unitId);
    const checkInDateLocalized = stay.checkInDateLocalized || stay.checkInDate || stay.checkIn;
    const checkOutDateLocalized = stay.checkOutDateLocalized || stay.checkOutDate || stay.checkOut;
    if (!listingId || !checkInDateLocalized || !checkOutDateLocalized) {
      throw new Error(`Guesty reservation ${reservationId} has an incomplete authoritative stay`);
    }
    return {
      ...row,
      listingId: String(listingId),
      checkInDateLocalized,
      checkOutDateLocalized,
      authoritativeSingleStay: true,
    };
  }
  return row;
}

function mergeReservationDetails(snapshot, details, reservationId) {
  if (!details || typeof details !== 'object') {
    throw new Error(`Guesty reservation ${reservationId} detail response is malformed`);
  }
  const detailsId = details._id || details.id || details.reservationId;
  const detailsListingId = externalListingId(details.listingId || details.listing);
  const snapshotId = snapshot._id || snapshot.id || snapshot.reservationId;
  const comparisons = [
    [String(detailsId || ''), String(snapshotId || ''), 'reservation id'],
    [String(detailsListingId || ''), String(snapshot.listingId || ''), 'listing id'],
    [String(details.checkInDateLocalized || ''), String(snapshot.checkInDateLocalized || ''), 'check-in date'],
    [String(details.checkOutDateLocalized || ''), String(snapshot.checkOutDateLocalized || ''), 'check-out date'],
    [String(details.status || '').toLowerCase(), String(snapshot.status || '').toLowerCase(), 'status'],
  ];
  for (const [actual, expected, label] of comparisons) {
    if (!actual || actual !== expected) {
      throw new Error(`Guesty reservation ${reservationId} ${label} differs between v3 and reservation detail`);
    }
  }
  return {
    ...snapshot,
    guest: details.guest ? { fullName: details.guest.fullName || null } : null,
    lastUpdatedAt: details.lastUpdatedAt || snapshot.lastUpdatedAt || null,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function fiscalVersion(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function reservationRow(payload, reservationId) {
  const rows = Array.isArray(payload) ? payload : payload?.results;
  if (!Array.isArray(rows) || !rows[0]) throw new Error(`Guesty reservation ${reservationId} was not found`);
  return normalizeV3ReservationCore(rows[0], reservationId);
}

function isCancelledReservation(reservation) {
  return ['cancelled', 'canceled'].includes(String(reservation?.status || '').trim().toLowerCase());
}

async function fetchConsistentReservationSnapshot(reservationId, { get, config = {}, maxAttempts = 3 } = {}) {
  if (typeof get !== 'function') throw new Error('Guesty HTTP getter is required');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('Guesty snapshot maxAttempts must be 1-5');
  const reservationRequest = () => get(`${API_URL}/reservations-v3`, {
    ...config,
    // Guesty's live v3 endpoint validates this as an array and expects Axios'
    // bracket serialization (`reservationIds[]=...`) even for a single ID.
    // Passing a scalar currently returns HTTP 400 and blocks every fiscal
    // refresh/calibration. Keep price components itemized so the explicit
    // financial profile, rather than Guesty-side merging, decides what enters
    // the taxable gross.
    params: { reservationIds: [reservationId], mergeAccommodationFarePriceComponents: false },
  });
  const overviewRequest = () => get(`${API_URL}/guest-folio/overview`, {
    ...config,
    params: { reservationIds: reservationId, fields: FOLIO_OVERVIEW_FIELDS.join(',') },
  });
  const invoiceItemsRequest = () => get(`${API_URL}/guest-folio/invoice-items`, {
    ...config,
    params: { reservationIds: reservationId, fields: FOLIO_INVOICE_ITEM_FIELDS.join(',') },
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Cancellation is authoritative reservation lifecycle state and remains
    // available after Guesty removes or withholds Guest Folio resources. Read
    // the core reservation twice first, so a stable cancellation can be
    // ingested without ever depending on a folio endpoint.
    const reservationBefore = reservationRow((await reservationRequest()).data, reservationId);
    const reservationCandidate = reservationRow((await reservationRequest()).data, reservationId);
    if (fiscalVersion(reservationBefore) !== fiscalVersion(reservationCandidate)) continue;
    if (isCancelledReservation(reservationCandidate)) {
      return { ...reservationCandidate, authoritativeCancellation: true };
    }

    // Read the folio twice as well as bracketing it with reservation/overview.
    // Guesty can change invoice items without exposing the mutation in either
    // surrounding payload, so all three fiscal views must remain identical.
    const overviewBeforeResponse = await overviewRequest();
    const invoiceItemsBeforeResponse = await invoiceItemsRequest();
    const invoiceItemsAfterResponse = await invoiceItemsRequest();
    const [reservationAfterResponse, overviewAfterResponse] = await Promise.all([reservationRequest(), overviewRequest()]);
    const reservationAfter = reservationRow(reservationAfterResponse.data, reservationId);
    const overviewBefore = requireFolioResult(overviewBeforeResponse.data, reservationId, 'overview');
    const overviewAfter = requireFolioResult(overviewAfterResponse.data, reservationId, 'overview');
    const invoiceFolioBefore = requireFolioResult(invoiceItemsBeforeResponse.data, reservationId, 'invoice items');
    const invoiceFolio = requireFolioResult(invoiceItemsAfterResponse.data, reservationId, 'invoice items');
    if (fiscalVersion(reservationCandidate) !== fiscalVersion(reservationAfter)
        || fiscalVersion(overviewBefore) !== fiscalVersion(overviewAfter)
        || fiscalVersion(invoiceFolioBefore) !== fiscalVersion(invoiceFolio)) {
      continue;
    }
    if (!Array.isArray(invoiceFolio.invoiceItems)) {
      throw new Error(`Guesty authoritative Guest Folio invoice items for reservation ${reservationId} are malformed`);
    }
    if (!invoiceFolio.currency || !overviewAfter.currency) {
      throw new Error(`Guesty authoritative Guest Folio currency for reservation ${reservationId} is missing`);
    }
    if (String(invoiceFolio.currency) !== String(overviewAfter.currency)) {
      throw new Error(`Guesty Guest Folio currency mismatch for reservation ${reservationId}`);
    }
    return {
      ...reservationAfter,
      fiscalInvoiceItems: invoiceFolio.invoiceItems,
      fiscalCurrency: String(invoiceFolio.currency),
      fiscalFolioOverview: overviewAfter,
    };
  }
  throw new Error(`Guesty reservation ${reservationId} changed while its fiscal folio was being read; retry later`);
}

function requireFolioResult(payload, reservationId, label) {
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error(`Guesty authoritative Guest Folio ${label} response is malformed`);
  }
  const expectedId = String(reservationId);
  const result = payload.results.find((item) => String(item?.reservationId || '') === expectedId);
  if (!result) {
    throw new Error(`Guesty authoritative Guest Folio ${label} for reservation ${expectedId} was not found`);
  }
  return result;
}

async function testGuestyConnection() {
  // A cached token can be revoked before its nominal expiry, so the connection
  // check must exercise an authenticated read and not only inspect the cache.
  await withGuestyAuthentication((token) => axios.get(`${API_URL}/listings`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    params: { limit: 1, fields: '_id' },
    timeout: 15000,
  }));
  return { success: true, checkedAt: new Date().toISOString() };
}

module.exports = {
  getAccessToken,
  fetchReservation,
  searchUpdatedReservationIds,
  testGuestyConnection,
  credentialFingerprint,
  FOLIO_INVOICE_ITEM_FIELDS,
  FOLIO_OVERVIEW_FIELDS,
  fetchConsistentReservationSnapshot,
  normalizeV3ReservationCore,
  mergeReservationDetails,
};

'use strict';

const VAT_TITLES = new Set(['VAT', 'ΦΠΑ']);
const GUESTY_TAX_TYPES = new Set(['TAXD', 'LT', 'CT', 'TT', 'GST', 'VAT', 'TTH', 'LGT', 'HT', 'TAF', 'TRT', 'RT', 'ST', 'COT', 'OCT', 'TOT', 'HSHAT', 'HST', 'MAT', 'SDC', 'TAX']);

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

function nightsBetween(checkIn, checkOut) {
  const start = Date.parse(`${checkIn}T12:00:00Z`);
  const end = Date.parse(`${checkOut}T12:00:00Z`);
  const nights = Math.round((end - start) / 86400000);
  if (!Number.isInteger(nights) || nights <= 0) throw new Error('Guesty stay dates do not form a positive night count');
  return nights;
}

function normalizedIdentifierKey(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized || null;
}

function finiteNumber(value, fieldName, { optional = false } = {}) {
  if (value === null || value === undefined) {
    if (optional) return null;
    throw new Error(`Guesty authoritative invoice item is missing ${fieldName}`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Guesty authoritative invoice item has invalid ${fieldName}`);
  }
  return value;
}

function optionalBoolean(value, fieldName) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') throw new Error(`Guesty authoritative invoice item has invalid ${fieldName}`);
  return value;
}

function normalizeAdjustment(adjustment) {
  if (!adjustment || typeof adjustment !== 'object') {
    throw new Error('Guesty authoritative invoice item contains a malformed adjustment');
  }
  return {
    amount: finiteNumber(adjustment.amount, 'adjustments.amount'),
    creationMethod: adjustment.creationMethod || null,
    type: adjustment.type || null,
    createdAt: adjustment.createdAt || null,
    nightsBreakdown: adjustment.nightsBreakdown === undefined
      ? []
      : requireArray(adjustment.nightsBreakdown, 'adjustments.nightsBreakdown').map((night) => ({
        date: night?.date || null,
        basePrice: finiteNumber(night?.basePrice, 'adjustments.nightsBreakdown.basePrice'),
      })),
  };
}

function requireArray(value, fieldName) {
  if (!Array.isArray(value)) throw new Error(`Guesty authoritative invoice item has invalid ${fieldName}`);
  return value;
}

function normalizeFiscalInvoiceItem(item, index) {
  if (!item || typeof item !== 'object') {
    throw new Error(`Guesty authoritative invoice item ${index} is malformed`);
  }
  const id = item.id || item._id;
  const normalType = String(item.normalType || '').trim().toUpperCase();
  if (!id || !normalType) {
    throw new Error(`Guesty authoritative invoice item ${index} is missing id or normalType`);
  }
  const totalPrice = finiteNumber(item.totalPrice, 'totalPrice');
  const stayIndex = finiteNumber(item.stayIndex, 'stayIndex', { optional: true });
  if (stayIndex !== null && !Number.isInteger(stayIndex)) {
    throw new Error('Guesty authoritative invoice item has invalid stayIndex');
  }
  return {
    id: String(id),
    normalType,
    origin: item.origin || null,
    title: item.title || null,
    secondIdentifier: item.secondIdentifier || null,
    totalPrice,
    nightsSubtotal: finiteNumber(item.nightsSubtotal, 'nightsSubtotal', { optional: true }),
    isDeducted: optionalBoolean(item.isDeducted, 'isDeducted'),
    isDeductedV2: optionalBoolean(item.isDeductedV2, 'isDeductedV2'),
    listingId: item.listingId ? String(item.listingId) : null,
    stayIndex,
    adjustments: item.adjustments === undefined
      ? []
      : requireArray(item.adjustments, 'adjustments').map(normalizeAdjustment),
  };
}

function isTaxableGuestCharge(item) {
  const normalType = String(item.normalType || '').toUpperCase();
  if (normalType) return !GUESTY_TAX_TYPES.has(normalType) || normalType === 'VAT';
  return !item.isTax || VAT_TITLES.has(String(item.title || '').toUpperCase());
}

function summarizeLine(item) {
  const normalized = normalizeFiscalInvoiceItem(item);
  return {
    ...normalized,
    // Kept as a compatibility alias for the existing document builder.
    amount: normalized.totalPrice,
    included: isTaxableGuestCharge(item),
  };
}

function guestyFinancials(reservation) {
  if (!Object.prototype.hasOwnProperty.call(reservation, 'fiscalInvoiceItems')) {
    throw new Error('Guesty authoritative Guest Folio invoice items are required');
  }
  const items = reservation.fiscalInvoiceItems;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Guesty authoritative invoice items are empty');
  }
  const lines = items.map(summarizeLine);
  const total = lines.filter((line) => line.included).reduce((sum, line) => sum + line.totalPrice, 0);
  if (total <= 0) throw new Error('Guesty invoice items have no positive taxable guest charge');
  return { totalGross: Number(total.toFixed(2)), amountSource: 'guest_folio_invoice_items', invoiceItems: lines };
}

function guestyGross(reservation) {
  return guestyFinancials(reservation).totalGross;
}

function fiscalGuest(guest) {
  if (!guest || typeof guest !== 'object') return null;
  const fullName = guest.fullName || guest.name || [guest.firstName, guest.lastName].filter(Boolean).join(' ');
  return fullName ? { fullName: String(fullName).slice(0, 200) } : null;
}

function normalizeAuthoritativeCancellation(raw) {
  const checkIn = dateOnly(raw.checkInDateLocalized || raw.checkIn);
  const checkOut = dateOnly(raw.checkOutDateLocalized || raw.checkOut);
  const reservationId = raw._id || raw.reservationId || raw.id;
  const listingId = typeof raw.listingId === 'object'
    ? (raw.listingId?._id || raw.listingId?.id)
    : raw.listingId;
  const status = String(raw.status || '').trim().toLowerCase();
  if (!['cancelled', 'canceled'].includes(status)) {
    throw new Error('Guesty authoritative cancellation has a non-cancelled status');
  }
  if (!reservationId || !listingId || !checkIn || !checkOut) {
    throw new Error('Guesty cancellation is missing reservation id, listing id, or localized stay dates');
  }
  const derivedNights = nightsBetween(checkIn, checkOut);
  return {
    reservationId: String(reservationId),
    listingId: String(listingId),
    status,
    checkIn,
    checkOut,
    nights: derivedNights,
    financials: { amountSource: 'authoritative_cancellation' },
    fiscalInvoiceItems: [],
    guest: fiscalGuest(raw.guest),
    platform: null,
    source: null,
    platformKey: null,
    sourceKey: null,
    guestStayStatus: raw.guestStay?.status ? String(raw.guestStay.status).trim().toLowerCase() : null,
    stayEvidence: null,
    folioOverview: null,
    authoritativeCancellation: true,
  };
}

function normalizeGuestyReservation(payload) {
  const raw = payload?.reservation || payload;
  if (!raw || typeof raw !== 'object') throw new Error('Guesty reservation payload is missing');
  if (raw.authoritativeCancellation === true) return normalizeAuthoritativeCancellation(raw);
  if (!Object.prototype.hasOwnProperty.call(raw, 'fiscalFolioOverview')) {
    throw new Error('Guesty authoritative Guest Folio overview is required');
  }
  if (!raw.fiscalFolioOverview || typeof raw.fiscalFolioOverview !== 'object') {
    throw new Error('Guesty authoritative Guest Folio overview is malformed');
  }
  const checkIn = dateOnly(raw.checkInDateLocalized || raw.checkIn);
  const checkOut = dateOnly(raw.checkOutDateLocalized || raw.checkOut);
  const reservationId = raw._id || raw.reservationId || raw.id;
  const listingId = typeof raw.listingId === 'object' ? (raw.listingId?._id || raw.listingId?.id) : raw.listingId;
  if (!reservationId || !listingId || !checkIn || !checkOut) {
    throw new Error('Guesty payload is missing reservation id, listing id, or localized stay dates');
  }
  const currency = raw.fiscalCurrency;
  if (!currency || !raw.fiscalFolioOverview.currency) {
    throw new Error('Guesty authoritative Guest Folio currency is required');
  }
  if (String(currency) !== String(raw.fiscalFolioOverview.currency)) {
    throw new Error('Guesty authoritative Guest Folio currencies do not match');
  }
  if (currency !== 'EUR') throw new Error(`Guesty reservation currency ${currency} is not supported for myDATA issuance`);
  const rawPlatform = raw.fiscalFolioOverview.platform ?? raw.integration?.platform ?? raw.platform ?? null;
  const rawSource = raw.fiscalFolioOverview.source ?? raw.source ?? null;
  if (typeof rawPlatform !== 'string' || typeof rawSource !== 'string') {
    throw new Error('Guesty authoritative Guest Folio platform and source must be strings');
  }
  if (normalizedIdentifierKey(rawPlatform) === null || normalizedIdentifierKey(rawSource) === null) {
    throw new Error('Guesty authoritative Guest Folio platform and source are required');
  }
  if (!raw.fiscalFolioOverview.reservationId || !raw.fiscalFolioOverview.listingId) {
    throw new Error('Guesty authoritative Guest Folio reservation and listing ids are required');
  }
  if (String(raw.fiscalFolioOverview.reservationId) !== String(reservationId)) {
    throw new Error('Guesty authoritative Guest Folio reservation id does not match');
  }
  if (String(raw.fiscalFolioOverview.listingId) !== String(listingId)) {
    throw new Error('Guesty authoritative Guest Folio listing id does not match');
  }
  const financials = guestyFinancials(raw);
  const lineListingIds = [...new Set(financials.invoiceItems
    .map((item) => item.listingId).filter(Boolean).map(String))];
  const stayIndexes = [...new Set(financials.invoiceItems
    .map((item) => item.stayIndex).filter((value) => value !== null).map(Number))];
  const allLinesAllocated = financials.invoiceItems.every((item) => item.listingId
    && Number.isInteger(item.stayIndex));
  const singleStayConfirmed = allLinesAllocated
    && lineListingIds.length === 1
    && lineListingIds[0] === String(listingId)
    && stayIndexes.length === 1;
  const derivedNights = nightsBetween(checkIn, checkOut);
  if (raw.nights !== undefined && raw.nights !== null && Number(raw.nights) !== derivedNights) {
    throw new Error('Guesty nights do not match localized check-in/check-out dates');
  }
  return {
    reservationId: String(reservationId),
    listingId: String(listingId),
    status: String(raw.status || '').toLowerCase(),
    checkIn,
    checkOut,
    nights: derivedNights,
    financials,
    fiscalInvoiceItems: financials.invoiceItems,
    // Data minimisation: fiscal processing/PDF needs only the display name,
    // never Guesty's complete guest profile or the raw webhook payload.
    guest: fiscalGuest(raw.guest),
    platform: String(rawPlatform),
    source: String(rawSource),
    platformKey: normalizedIdentifierKey(rawPlatform),
    sourceKey: normalizedIdentifierKey(rawSource),
    guestStayStatus: raw.guestStay?.status ? String(raw.guestStay.status).trim().toLowerCase() : null,
    stayEvidence: {
      reservationListingId: String(listingId),
      folioListingId: String(raw.fiscalFolioOverview.listingId),
      lineListingIds,
      stayIndexes,
      allLinesAllocated,
      singleStayConfirmed,
    },
    folioOverview: {
      reservationId: String(raw.fiscalFolioOverview.reservationId),
      listingId: String(raw.fiscalFolioOverview.listingId),
      currency: String(raw.fiscalFolioOverview.currency),
      platform: String(rawPlatform),
      source: String(rawSource),
      updatedAt: raw.fiscalFolioOverview.updatedAt || null,
    },
  };
}

module.exports = {
  normalizeGuestyReservation,
  normalizeFiscalInvoiceItem,
  normalizedIdentifierKey,
  guestyGross,
  guestyFinancials,
  nightsBetween,
};

'use strict';

const {
  listListings,
  getListingById,
  getListingByGuestyId,
  createListing,
  updateListing,
} = require('../repositories/listings');
const { getCompanyById } = require('../repositories/companies');
const { normalizeAccommodationClimateCategory, normalizeCounterpart, normalizeSeries, validateAccommodationClimatePair } = require('../validation/fiscal-fields');

const PROPERTY_TYPES = new Set(['villa', 'apartment']);
const INVOICE_TYPES = new Set(['11.2', '2.1']);

function normalizeFee(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const fee = Number(value);
  if (!Number.isFinite(fee) || fee < 0 || Math.round(fee * 100) !== fee * 100) {
    const error = new Error(`${fieldName} must be a non-negative amount with up to 2 decimals`);
    error.status = 400;
    throw error;
  }
  return fee;
}

function normalizeClimateCategory(value, fieldName) {
  return normalizeAccommodationClimateCategory(value, fieldName.includes('high') ? 'high' : 'low', fieldName);
}

function parseId(value, label) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1) {
    const error = new Error(`${label} must be a positive integer`);
    error.status = 400;
    throw error;
  }
  return id;
}

function normalizePaymentMethod(value) {
  const type = Number.parseInt(value ?? 1, 10);
  if (!Number.isInteger(type) || type < 1 || type > 8) {
    const error = new Error('payment_method_type must be an AADE payment code (1-8)');
    error.status = 400;
    throw error;
  }
  return type;
}

function normalizeCreatePayload(payload) {
  const listingId = String(payload.listing_id_guesty || '').trim();
  const propertyType = String(payload.property_type || 'apartment').trim();
  const defaultInvoiceType = String(payload.default_invoice_type || '11.2').trim();
  const companyId = parseId(payload.company_id, 'company_id');
  const errors = [];

  if (!listingId) errors.push('listing_id_guesty is required');
  if (listingId.length > 100) errors.push('listing_id_guesty must be <= 100 chars');
  if (!PROPERTY_TYPES.has(propertyType)) errors.push('property_type must be villa or apartment');
  if (!INVOICE_TYPES.has(defaultInvoiceType)) errors.push('default_invoice_type must be 11.2 or 2.1');

  const climateFeeHigh = normalizeFee(payload.climate_fee_high, 'climate_fee_high');
  const climateFeeLow = normalizeFee(payload.climate_fee_low, 'climate_fee_low');
  const climateCategoryHigh = normalizeClimateCategory(payload.climate_fee_high_category, 'climate_fee_high_category');
  const climateCategoryLow = normalizeClimateCategory(payload.climate_fee_low_category, 'climate_fee_low_category');
  const counterpart = normalizeCounterpart({
    vatNumber: payload.invoice_counterpart_vat_number,
    country: payload.invoice_counterpart_country,
    name: payload.invoice_counterpart_name,
    branch: payload.invoice_counterpart_branch,
  }, { required: defaultInvoiceType === '2.1', label: 'invoice_counterpart' });
  const climateFeeSeries = normalizeSeries(payload.climate_fee_series || 'TAKK', { fieldName: 'climate_fee_series', required: true });
  const paymentMethodInfo = String(payload.payment_method_info || '').trim() || null;
  if (climateFeeHigh === null) errors.push('climate_fee_high is required per listing');
  if (climateFeeLow === null) errors.push('climate_fee_low is required per listing');
  if (climateCategoryHigh === null) errors.push('climate_fee_high_category is required per listing');
  if (climateCategoryLow === null) errors.push('climate_fee_low_category is required per listing');
  if (climateCategoryHigh !== null && climateCategoryLow !== null) {
    validateAccommodationClimatePair(propertyType, climateCategoryHigh, climateCategoryLow);
  }

  return {
    errors,
    normalized: {
      company_id: companyId,
      listing_id_guesty: listingId,
      property_type: propertyType,
      default_invoice_type: defaultInvoiceType,
      invoice_counterpart_vat_number: counterpart.vatNumber,
      invoice_counterpart_country: counterpart.country,
      invoice_counterpart_name: counterpart.name,
      invoice_counterpart_branch: counterpart.branch,
      climate_fee_high: climateFeeHigh,
      climate_fee_low: climateFeeLow,
      climate_fee_high_category: climateCategoryHigh,
      climate_fee_low_category: climateCategoryLow,
      climate_fee_series: climateFeeSeries,
      payment_method_type: normalizePaymentMethod(payload.payment_method_type),
      payment_method_info: paymentMethodInfo,
      active: payload.active === undefined ? true : Boolean(payload.active),
    },
  };
}

async function ensureCompanyExists(companyId) {
  if (!await getCompanyById(companyId)) {
    const error = new Error('Company not found');
    error.status = 404;
    throw error;
  }
}

async function handleListListings() {
  return listListings();
}

async function handleGetListing(id) {
  const listing = await getListingById(parseId(id, 'listing id'));
  if (!listing) {
    const error = new Error('Listing not found');
    error.status = 404;
    throw error;
  }
  return listing;
}

async function handleCreateListing(payload) {
  const { errors, normalized } = normalizeCreatePayload(payload);
  if (normalized.payment_method_info?.length > 200) errors.push('payment_method_info must be <= 200 chars');
  if (errors.length) {
    const error = new Error(errors.join('; '));
    error.status = 400;
    throw error;
  }

  await ensureCompanyExists(normalized.company_id);
  if (await getListingByGuestyId(normalized.listing_id_guesty)) {
    const error = new Error(`Listing ${normalized.listing_id_guesty} already exists`);
    error.status = 409;
    throw error;
  }
  return createListing(normalized);
}

async function handleUpdateListing(id, payload) {
  const listingId = parseId(id, 'listing id');
  const existing = await getListingById(listingId);
  if (!existing) {
    const error = new Error('Listing not found');
    error.status = 404;
    throw error;
  }

  const normalized = {};
  if ('company_id' in payload) {
    normalized.company_id = parseId(payload.company_id, 'company_id');
    await ensureCompanyExists(normalized.company_id);
  }
  if ('listing_id_guesty' in payload) {
    const value = String(payload.listing_id_guesty || '').trim();
    if (!value || value.length > 100) {
      const error = new Error('listing_id_guesty must be 1-100 chars');
      error.status = 400;
      throw error;
    }
    const conflict = await getListingByGuestyId(value);
    if (conflict && conflict.id !== existing.id) {
      const error = new Error(`Listing ${value} already exists`);
      error.status = 409;
      throw error;
    }
    normalized.listing_id_guesty = value;
  }
  if ('property_type' in payload) {
    const value = String(payload.property_type || '').trim();
    if (!PROPERTY_TYPES.has(value)) {
      const error = new Error('property_type must be villa or apartment');
      error.status = 400;
      throw error;
    }
    normalized.property_type = value;
  }
  if ('default_invoice_type' in payload) {
    const value = String(payload.default_invoice_type || '').trim();
    if (!INVOICE_TYPES.has(value)) {
      const error = new Error('default_invoice_type must be 11.2 or 2.1');
      error.status = 400;
      throw error;
    }
    normalized.default_invoice_type = value;
  }
  for (const field of ['invoice_counterpart_vat_number', 'invoice_counterpart_name']) {
    if (field in payload) normalized[field] = String(payload[field] || '').trim() || null;
  }
  if ('invoice_counterpart_branch' in payload) normalized.invoice_counterpart_branch = payload.invoice_counterpart_branch;
  if ('invoice_counterpart_country' in payload) {
    normalized.invoice_counterpart_country = String(payload.invoice_counterpart_country || '').trim().toUpperCase() || null;
  }
  if ('climate_fee_high' in payload) normalized.climate_fee_high = normalizeFee(payload.climate_fee_high, 'climate_fee_high');
  if ('climate_fee_low' in payload) normalized.climate_fee_low = normalizeFee(payload.climate_fee_low, 'climate_fee_low');
  if ('climate_fee_high_category' in payload) normalized.climate_fee_high_category = normalizeClimateCategory(payload.climate_fee_high_category, 'climate_fee_high_category');
  if ('climate_fee_low_category' in payload) normalized.climate_fee_low_category = normalizeClimateCategory(payload.climate_fee_low_category, 'climate_fee_low_category');
  if ('climate_fee_series' in payload) {
    normalized.climate_fee_series = normalizeSeries(payload.climate_fee_series, { fieldName: 'climate_fee_series', required: true });
  }
  if ('payment_method_type' in payload) normalized.payment_method_type = normalizePaymentMethod(payload.payment_method_type);
  if ('payment_method_info' in payload) {
    const value = String(payload.payment_method_info || '').trim();
    if (value.length > 200) {
      const error = new Error('payment_method_info must be <= 200 chars'); error.status = 400; throw error;
    }
    normalized.payment_method_info = value || null;
  }
  if ('active' in payload) normalized.active = Boolean(payload.active);
  const finalValue = { ...existing, ...normalized };
  for (const requiredField of ['climate_fee_high', 'climate_fee_low', 'climate_fee_high_category', 'climate_fee_low_category']) {
    if (finalValue[requiredField] === null || finalValue[requiredField] === undefined || finalValue[requiredField] === '') {
      const error = new Error(`${requiredField} is required per listing`);
      error.status = 400;
      throw error;
    }
  }
  const climateFieldsChanged = ['property_type', 'climate_fee_high_category', 'climate_fee_low_category'].some((field) => field in payload);
  if (finalValue.active !== false || climateFieldsChanged) {
    validateAccommodationClimatePair(finalValue.property_type, finalValue.climate_fee_high_category, finalValue.climate_fee_low_category);
  }
  const counterpartFieldsChanged = ['default_invoice_type', 'invoice_counterpart_vat_number', 'invoice_counterpart_country', 'invoice_counterpart_name', 'invoice_counterpart_branch']
    .some((field) => field in payload);
  if (finalValue.active !== false || counterpartFieldsChanged) {
    const counterpart = normalizeCounterpart({
      vatNumber: finalValue.invoice_counterpart_vat_number,
      country: finalValue.invoice_counterpart_country,
      name: finalValue.invoice_counterpart_name,
      branch: finalValue.invoice_counterpart_branch,
    }, { required: finalValue.default_invoice_type === '2.1', label: 'invoice_counterpart' });
    normalized.invoice_counterpart_vat_number = counterpart.vatNumber;
    normalized.invoice_counterpart_country = counterpart.country;
    normalized.invoice_counterpart_name = counterpart.name;
    normalized.invoice_counterpart_branch = counterpart.branch;
  }
  return updateListing(listingId, normalized);
}

module.exports = {
  handleListListings,
  handleGetListing,
  handleCreateListing,
  handleUpdateListing,
};

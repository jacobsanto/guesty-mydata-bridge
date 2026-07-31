'use strict';

const { getListingById } = require('../repositories/listings');
const { normalizeSource, listBillingRules, createBillingRule, updateBillingRule } = require('../repositories/billing-rules');
const { normalizeCounterpart, normalizeSeries } = require('../validation/fiscal-fields');

function normalize(payload) {
  const invoiceType = String(payload.invoice_type || '').trim();
  const platform = normalizeSource(payload.guesty_platform);
  const source = normalizeSource(payload.guesty_source);
  if (!platform) throw Object.assign(new Error('guesty_platform is required'), { status: 400 });
  if (!source) throw Object.assign(new Error('guesty_source is required'), { status: 400 });
  if (platform.length > 100) throw Object.assign(new Error('guesty_platform must be <= 100 chars'), { status: 400 });
  if (source.length > 100) throw Object.assign(new Error('guesty_source must be <= 100 chars'), { status: 400 });
  if (!['11.2', '2.1'].includes(invoiceType)) throw Object.assign(new Error('invoice_type must be 11.2 or 2.1'), { status: 400 });
  const counterpart = normalizeCounterpart({
    vatNumber: payload.counterpart_vat_number,
    country: payload.counterpart_country,
    name: payload.counterpart_name,
    branch: payload.counterpart_branch,
  }, { required: invoiceType === '2.1', label: 'counterpart' });
  const result = {
    guesty_platform: platform,
    guesty_source: source,
    invoice_type: invoiceType,
    series: normalizeSeries(payload.series),
    counterpart_vat_number: counterpart.vatNumber,
    counterpart_country: counterpart.country,
    counterpart_name: counterpart.name,
    counterpart_branch: counterpart.branch,
    active: payload.active === undefined ? true : Boolean(payload.active),
  };
  return result;
}

async function handleCreateBillingRule(payload) {
  const listingId = Number(payload.listing_id);
  if (!Number.isInteger(listingId) || !await getListingById(listingId)) throw Object.assign(new Error('Listing not found'), { status: 404 });
  try {
    return await createBillingRule({ listing_id: listingId, ...normalize(payload) });
  } catch (error) {
    if (/unique/i.test(error.message)) throw Object.assign(new Error('A rule for this listing and exact Guesty platform/source already exists'), { status: 409 });
    throw error;
  }
}

async function handleUpdateBillingRule(id, payload) {
  const existing = (await listBillingRules()).find((row) => row.id === Number(id));
  if (!existing) throw Object.assign(new Error('Billing rule not found'), { status: 404 });
  return updateBillingRule(existing.id, normalize({ ...existing, ...payload }));
}

module.exports = { listBillingRules, handleCreateBillingRule, handleUpdateBillingRule };

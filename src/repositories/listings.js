'use strict';

const { db } = require('../database');
const { insertedId } = require('../database-utils');

async function listListings() {
  return db('listings as l')
    .join('companies as c', 'l.company_id', 'c.id')
    .select(
      'l.id',
      'l.listing_id_guesty',
      'l.property_type',
      'l.default_invoice_type',
      'l.invoice_counterpart_vat_number',
      'l.invoice_counterpart_country',
      'l.invoice_counterpart_name',
      'l.climate_fee_high',
      'l.climate_fee_low',
      'l.climate_fee_high_category',
      'l.climate_fee_low_category',
      'l.climate_fee_series',
      'l.payment_method_type',
      'l.payment_method_info',
      'l.active',
      'l.company_id',
      'c.company_name',
      'c.vat_number'
    )
    .orderBy('l.id', 'desc');
}

async function getListingById(id) {
  return db('listings').where({ id }).first();
}

async function getListingByGuestyId(listingIdGuesty) {
  return db('listings').where({ listing_id_guesty: listingIdGuesty }).first();
}

async function getCompanyAndListingByGuestyListingId(listingIdGuesty) {
  return db('listings as l')
    .join('companies as c', 'l.company_id', 'c.id')
    .where({ 'l.listing_id_guesty': listingIdGuesty })
    .select(
      'l.id as listing_id',
      'l.listing_id_guesty',
      'l.property_type',
      'l.default_invoice_type',
      'l.invoice_counterpart_vat_number',
      'l.invoice_counterpart_country',
      'l.invoice_counterpart_name',
      'l.climate_fee_high',
      'l.climate_fee_low',
      'l.climate_fee_high_category',
      'l.climate_fee_low_category',
      'l.climate_fee_series',
      'l.payment_method_type',
      'l.payment_method_info',
      'l.active as listing_active',
      'c.id as company_id',
      'c.company_name',
      'c.vat_number',
      'c.invoice_series',
      'c.invoice_counter',
      'c.active as company_active'
    )
    .first();

  return row || null;
}

async function createListing(data) {
  const id = insertedId(await db('listings').insert(data).returning('id'));
  return getListingById(id);
}

async function updateListing(id, data) {
  await db('listings').where({ id }).update({
    ...data,
    updated_at: db.fn.now(),
  });
  return getListingById(id);
}

module.exports = {
  listListings,
  getListingById,
  getListingByGuestyId,
  getCompanyAndListingByGuestyListingId,
  createListing,
  updateListing,
};

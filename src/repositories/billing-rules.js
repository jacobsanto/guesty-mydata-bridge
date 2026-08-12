'use strict';

const { db } = require('../database');
const { insertedId } = require('../database-utils');

function normalizeSource(source) {
  return String(source || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

const TABLE = 'listing_channel_billing_rules';

async function listBillingRules(listingId) {
  const query = db(TABLE).select('*').orderBy('guesty_platform').orderBy('guesty_source');
  if (listingId) query.where({ listing_id: listingId });
  return query;
}

async function getBillingRule(listingId, guestyPlatform, guestySource, client = db) {
  const platform = normalizeSource(guestyPlatform);
  const source = normalizeSource(guestySource);
  if (!platform || !source) return null;
  return client(TABLE).where({ listing_id: listingId, guesty_platform: platform, guesty_source: source, active: true }).first();
}

async function createBillingRule(data) {
  const id = insertedId(await db(TABLE).insert({
    ...data,
    guesty_platform: normalizeSource(data.guesty_platform),
    guesty_source: normalizeSource(data.guesty_source),
  }).returning('id'));
  return db(TABLE).where({ id }).first();
}

async function updateBillingRule(id, data) {
  if (data.guesty_platform !== undefined) data.guesty_platform = normalizeSource(data.guesty_platform);
  if (data.guesty_source !== undefined) data.guesty_source = normalizeSource(data.guesty_source);
  await db(TABLE).where({ id }).update({ ...data, updated_at: db.fn.now() });
  return db(TABLE).where({ id }).first();
}

module.exports = { normalizeSource, listBillingRules, getBillingRule, createBillingRule, updateBillingRule };

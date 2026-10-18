'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { insertedId } = require('../database-utils');

const PROFILE_STATUSES = new Set(['draft', 'approved', 'suspended']);
const PROFILE_STRATEGIES = new Set(['folio_rules', 'reservation_total']);

function repositoryError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizeKey(value, fieldName) {
  const key = String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!key || key.length > 100) throw repositoryError(`${fieldName} must contain 1-100 characters`);
  return key;
}

function normalizeMoney(value, fieldName, { nonNegative = false } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || (nonNegative && amount < 0) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8) {
    throw repositoryError(`${fieldName} must be ${nonNegative ? 'a non-negative ' : ''}amount with up to 2 decimals`);
  }
  return Number(amount.toFixed(2));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeLineRules(value) {
  const rules = parseJson(value, null);
  if (!Array.isArray(rules)) throw repositoryError('line_rules must be a JSON array');
  return rules;
}

function normalizeProfileConfig(data) {
  const currency = String(data.currency || 'EUR').trim().toUpperCase();
  if (currency !== 'EUR') throw repositoryError('currency must be EUR');
  const strategy = String(data.strategy || '').trim();
  if (!PROFILE_STRATEGIES.has(strategy)) throw repositoryError('strategy must be folio_rules or reservation_total');
  const tolerance = normalizeMoney(data.tolerance ?? 0, 'tolerance', { nonNegative: true });
  const minimumSamples = Number(data.minimum_samples ?? 3);
  if (!Number.isInteger(minimumSamples) || minimumSamples < 3) throw repositoryError('minimum_samples must be an integer of at least 3');
  return {
    currency,
    strategy,
    line_rules: normalizeLineRules(data.line_rules ?? []),
    tolerance,
    minimum_samples: minimumSamples,
  };
}

function profileConfigHash(config) {
  const canonical = {
    currency: config.currency,
    strategy: config.strategy,
    line_rules: config.line_rules,
    tolerance: Number(config.tolerance).toFixed(2),
    minimum_samples: Number(config.minimum_samples),
  };
  return crypto.createHash('sha256').update(stableJson(canonical)).digest('hex');
}

function hydrateProfile(row) {
  if (!row) return null;
  return {
    ...row,
    line_rules: parseJson(row.line_rules, []),
    tolerance: Number(row.tolerance),
    minimum_samples: Number(row.minimum_samples),
    version: Number(row.version),
  };
}

function hydrateSample(row) {
  if (!row) return null;
  return {
    ...row,
    expected_amount: Number(row.expected_amount),
    computed_amount: Number(row.computed_amount),
    delta_amount: Number(row.delta_amount),
    passed: row.passed === true || row.passed === 1 || row.passed === '1',
    line_evidence: parseJson(row.line_evidence, []),
  };
}

async function listFinancialProfiles(filters = {}, executor = db) {
  const query = executor('financial_profiles').select('*')
    .orderBy('listing_id').orderBy('platform_key').orderBy('source_key').orderBy('version', 'desc');
  if (filters.listingId !== undefined) query.where({ listing_id: Number(filters.listingId) });
  if (filters.platformKey !== undefined) query.where({ platform_key: normalizeKey(filters.platformKey, 'platform_key') });
  if (filters.sourceKey !== undefined) query.where({ source_key: normalizeKey(filters.sourceKey, 'source_key') });
  if (filters.status !== undefined) {
    if (!PROFILE_STATUSES.has(filters.status)) throw repositoryError('status must be draft, approved, or suspended');
    query.where({ status: filters.status });
  }
  return (await query).map(hydrateProfile);
}

async function getFinancialProfileById(id, executor = db) {
  return hydrateProfile(await executor('financial_profiles').where({ id: Number(id) }).first());
}

async function getApprovedFinancialProfile(listingId, platformKey, sourceKey, executor = db) {
  const row = await executor('financial_profiles').where({
    listing_id: Number(listingId),
    platform_key: normalizeKey(platformKey, 'platform_key'),
    source_key: normalizeKey(sourceKey, 'source_key'),
    status: 'approved',
  }).orderBy('version', 'desc').first();
  return hydrateProfile(row);
}

async function assertApprovedFinancialProfileBinding(expected, listingId, platformKey, sourceKey, executor) {
  if (!executor) throw new Error('Financial profile revalidation requires the materialization transaction');
  let query = executor('financial_profiles').where({ id: Number(expected?.id) });
  if (executor.client.config.client === 'pg') query = query.forUpdate();
  const raw = await query.first();
  const profile = hydrateProfile(raw);
  const actualConfigHash = profile ? profileConfigHash(normalizeProfileConfig(profile)) : null;
  const valid = profile
    && profile.status === 'approved'
    && Number(profile.listing_id) === Number(listingId)
    && profile.platform_key === normalizeKey(platformKey, 'platform_key')
    && profile.source_key === normalizeKey(sourceKey, 'source_key')
    && Number(profile.version) === Number(expected?.version)
    && profile.config_hash === String(expected?.configHash || '')
    && actualConfigHash === profile.config_hash;
  if (!valid) {
    const error = new Error('Approved financial profile changed before fiscal materialization');
    error.status = 409;
    error.code = 'FINANCIAL_PROFILE_CHANGED';
    throw error;
  }
  return profile;
}

async function createNextFinancialProfileVersion(data) {
  const listingId = Number(data.listing_id);
  if (!Number.isInteger(listingId) || listingId <= 0) throw repositoryError('listing_id must be a positive integer');
  const platformKey = normalizeKey(data.platform_key, 'platform_key');
  const sourceKey = normalizeKey(data.source_key, 'source_key');
  const config = normalizeProfileConfig(data);

  return db.transaction(async (trx) => {
    let listingQuery = trx('listings').where({ id: listingId });
    if (trx.client.config.client === 'pg') listingQuery = listingQuery.forUpdate();
    if (!await listingQuery.first('id')) throw repositoryError('Listing not found', 404);

    const maximum = await trx('financial_profiles')
      .where({ listing_id: listingId, platform_key: platformKey, source_key: sourceKey })
      .max({ version: 'version' }).first();
    const version = Number(maximum?.version || 0) + 1;
    const row = {
      listing_id: listingId,
      platform_key: platformKey,
      source_key: sourceKey,
      version,
      status: 'draft',
      currency: config.currency,
      strategy: config.strategy,
      line_rules: stableJson(config.line_rules),
      tolerance: config.tolerance,
      minimum_samples: config.minimum_samples,
      config_hash: profileConfigHash(config),
      approved_by: null,
      approval_notes: data.approval_notes ? String(data.approval_notes).slice(0, 4000) : null,
      approved_at: null,
    };
    const id = insertedId(await trx('financial_profiles').insert(row).returning('id'));
    return getFinancialProfileById(id, trx);
  });
}

async function updateDraftFinancialProfile(id, updates) {
  return db.transaction(async (trx) => {
    let query = trx('financial_profiles').where({ id: Number(id) });
    if (trx.client.config.client === 'pg') query = query.forUpdate();
    const existing = hydrateProfile(await query.first());
    if (!existing) throw repositoryError('Financial profile not found', 404);
    if (existing.status !== 'draft') throw repositoryError('Only a draft financial profile can be updated', 409);

    const config = normalizeProfileConfig({ ...existing, ...updates });
    const calculationChanged = config.currency !== existing.currency
      || config.strategy !== existing.strategy
      || stableJson(config.line_rules) !== stableJson(existing.line_rules)
      || config.tolerance !== Number(existing.tolerance);
    await trx('financial_profiles').where({ id: existing.id }).update({
      currency: config.currency,
      strategy: config.strategy,
      line_rules: stableJson(config.line_rules),
      tolerance: config.tolerance,
      minimum_samples: config.minimum_samples,
      config_hash: profileConfigHash(config),
      approval_notes: updates.approval_notes === undefined
        ? existing.approval_notes
        : (updates.approval_notes ? String(updates.approval_notes).slice(0, 4000) : null),
      updated_at: trx.fn.now(),
    });
    // A changed calculation invalidates computed calibration evidence. Expected
    // amounts can be recorded again against the same draft after re-evaluation.
    if (calculationChanged) await trx('financial_calibration_samples').where({ profile_id: existing.id }).delete();
    return getFinancialProfileById(existing.id, trx);
  });
}

async function deleteDraftFinancialProfile(id) {
  return db.transaction(async (trx) => {
    let query = trx('financial_profiles').where({ id: Number(id) });
    if (trx.client.config.client === 'pg') query = query.forUpdate();
    const profile = await query.first();
    if (!profile) return false;
    if (profile.status !== 'draft') throw repositoryError('Only a draft financial profile can be deleted', 409);
    await trx('financial_profiles').where({ id: profile.id }).delete();
    return true;
  });
}

async function recordCalibrationSample(profileId, data) {
  return db.transaction(async (trx) => {
    let profileQuery = trx('financial_profiles').where({ id: Number(profileId) });
    if (trx.client.config.client === 'pg') profileQuery = profileQuery.forUpdate();
    const profile = hydrateProfile(await profileQuery.first());
    if (!profile) throw repositoryError('Financial profile not found', 404);
    if (profile.status !== 'draft') throw repositoryError('Calibration samples can only be recorded for a draft profile', 409);
    const reservationId = String(data.reservation_id || '').trim();
    if (!reservationId || reservationId.length > 120) throw repositoryError('reservation_id must contain 1-120 characters');
    const expected = normalizeMoney(data.expected_amount, 'expected_amount', { nonNegative: true });
    const computed = normalizeMoney(data.computed_amount, 'computed_amount', { nonNegative: true });
    const delta = Number((computed - expected).toFixed(2));
    const evidence = parseJson(data.line_evidence ?? [], null);
    if (!Array.isArray(evidence)) throw repositoryError('line_evidence must be a JSON array');
    const channelKey = normalizeKey(data.channel_key || `${profile.platform_key}:${profile.source_key}`, 'channel_key');
    const currency = String(data.currency || profile.currency).trim().toUpperCase();
    if (currency !== profile.currency) throw repositoryError('Calibration sample currency must match profile currency');
    const derivedPayloadHash = crypto.createHash('sha256').update(stableJson({ reservationId, channelKey, currency, evidence })).digest('hex');
    const payloadHash = data.payload_hash === undefined ? derivedPayloadHash : String(data.payload_hash).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(payloadHash)) throw repositoryError('payload_hash must be a SHA-256 hex digest');
    const capturedAt = data.captured_at === undefined ? new Date() : new Date(data.captured_at);
    if (Number.isNaN(capturedAt.getTime())) throw repositoryError('captured_at must be a valid date');
    const row = {
      profile_id: profile.id,
      reservation_id: reservationId,
      expected_amount: expected,
      computed_amount: computed,
      delta_amount: delta,
      passed: Math.abs(delta) <= Number(profile.tolerance),
      channel_key: channelKey,
      currency,
      line_evidence: stableJson(evidence),
      payload_hash: payloadHash,
      captured_at: capturedAt.toISOString(),
      updated_at: trx.fn.now(),
    };
    await trx('financial_calibration_samples').insert(row)
      .onConflict(['profile_id', 'reservation_id']).merge(row);
    return hydrateSample(await trx('financial_calibration_samples')
      .where({ profile_id: profile.id, reservation_id: reservationId }).first());
  });
}

async function listCalibrationSamples(profileId, executor = db) {
  return (await executor('financial_calibration_samples')
    .where({ profile_id: Number(profileId) })
    .orderBy('captured_at').orderBy('id')).map(hydrateSample);
}

async function approveFinancialProfile(id, { approvedBy, notes } = {}) {
  const actor = String(approvedBy || '').trim();
  if (!actor || actor.length > 200) throw repositoryError('approvedBy must contain 1-200 characters');
  return db.transaction(async (trx) => {
    let query = trx('financial_profiles').where({ id: Number(id) });
    if (trx.client.config.client === 'pg') query = query.forUpdate();
    const profile = hydrateProfile(await query.first());
    if (!profile) throw repositoryError('Financial profile not found', 404);
    if (profile.status !== 'draft') throw repositoryError('Only a draft financial profile can be approved', 409);
    // Serialize approvals for every channel of a listing on PostgreSQL. SQLite
    // already uses a single writer connection, so this remains portable.
    let listingQuery = trx('listings').where({ id: profile.listing_id });
    if (trx.client.config.client === 'pg') listingQuery = listingQuery.forUpdate();
    await listingQuery.first('id');
    const samples = await listCalibrationSamples(profile.id, trx);
    const requiredSamples = Math.max(3, profile.minimum_samples);
    if (samples.length < requiredSamples) {
      throw repositoryError(`At least ${requiredSamples} calibration samples are required`, 409);
    }
    if (samples.some((sample) => !sample.passed)) throw repositoryError('All calibration samples must pass before approval', 409);
    const selectorFields = ['normalType', 'origin', 'title', 'secondIdentifier', 'isDeducted', 'isDeductedV2'];
    const ruleKey = (rule) => {
      const selector = Object.fromEntries(selectorFields.filter((field) => rule[field] !== undefined).map((field) => [field, rule[field]]));
      const decision = rule.decision || rule.action || (rule.include === true ? 'include' : 'exclude');
      return crypto.createHash('sha256').update(`${stableJson(selector)}:${decision}`).digest('hex').slice(0, 16);
    };
    const broadIncludes = profile.line_rules.filter((rule) => {
      const decision = rule.decision || rule.action || (rule.include === true ? 'include' : 'exclude');
      return decision === 'include' && !selectorFields.slice(1).some((field) => rule[field] !== undefined);
    });
    if (broadIncludes.length) {
      throw repositoryError('Broad include rules cannot be approved; every included Guesty line needs a stable discriminator', 409);
    }
    const exercisedRuleKeys = new Set(samples.flatMap((sample) => sample.line_evidence || []).map((line) => line.ruleKey).filter(Boolean));
    const missingRule = profile.line_rules.find((rule) => !exercisedRuleKeys.has(ruleKey(rule)));
    if (missingRule) throw repositoryError('Every financial rule must be exercised by the calibration samples before approval', 409);

    const newerApproved = await trx('financial_profiles').where({
      listing_id: profile.listing_id,
      platform_key: profile.platform_key,
      source_key: profile.source_key,
      status: 'approved',
    }).where('version', '>=', profile.version).whereNot({ id: profile.id }).first('id');
    if (newerApproved) throw repositoryError('A newer profile version is already approved', 409);

    await trx('financial_profiles').where({
      listing_id: profile.listing_id,
      platform_key: profile.platform_key,
      source_key: profile.source_key,
      status: 'approved',
    }).where('version', '<', profile.version).update({ status: 'suspended', updated_at: trx.fn.now() });
    await trx('financial_profiles').where({ id: profile.id }).update({
      status: 'approved',
      approved_by: actor,
      approval_notes: notes === undefined ? profile.approval_notes : (notes ? String(notes).slice(0, 4000) : null),
      approved_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
    return getFinancialProfileById(profile.id, trx);
  });
}

async function suspendFinancialProfile(id, notes) {
  return db.transaction(async (trx) => {
    let query = trx('financial_profiles').where({ id: Number(id) });
    if (trx.client.config.client === 'pg') query = query.forUpdate();
    const profile = await query.first();
    if (!profile) throw repositoryError('Financial profile not found', 404);
    await trx('financial_profiles').where({ id: profile.id }).update({
      status: 'suspended',
      approval_notes: notes === undefined ? profile.approval_notes : (notes ? String(notes).slice(0, 4000) : null),
      updated_at: trx.fn.now(),
    });
    return getFinancialProfileById(profile.id, trx);
  });
}

module.exports = {
  PROFILE_STATUSES,
  PROFILE_STRATEGIES,
  profileConfigHash,
  listFinancialProfiles,
  getFinancialProfileById,
  getApprovedFinancialProfile,
  assertApprovedFinancialProfileBinding,
  createNextFinancialProfileVersion,
  updateDraftFinancialProfile,
  deleteDraftFinancialProfile,
  recordCalibrationSample,
  listCalibrationSamples,
  approveFinancialProfile,
  suspendFinancialProfile,
};

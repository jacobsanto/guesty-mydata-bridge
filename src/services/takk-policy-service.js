'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { normalizeSeries } = require('../validation/fiscal-fields');
const { approvedPolicyIds, assertPolicyDecisionApproved } = require('./policy-decision-service');

function policyError(message, status = 409, code = 'TAKK_POLICY_BLOCKED') {
  return Object.assign(new Error(message), { status, code });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableJson(value) { return JSON.stringify(stableValue(value)); }

function parseJson(value, label) {
  if (typeof value === 'object' && value !== null) return value;
  try { return JSON.parse(String(value || '')); } catch { throw policyError(`${label} is not valid JSON`, 409, 'TAKK_POLICY_INVALID'); }
}

function takkPolicyHash(policy) {
  return crypto.createHash('sha256').update(stableJson({
    company_id: Number(policy.company_id), listing_id: Number(policy.listing_id), version: Number(policy.version),
    property_type: String(policy.property_type), licensed_category: String(policy.licensed_category),
    valid_from: String(policy.valid_from), valid_to: policy.valid_to || null,
    high_category: Number(policy.high_category), low_category: Number(policy.low_category),
    high_rate_cents: Number(policy.high_rate_cents), low_rate_cents: Number(policy.low_rate_cents),
    season_rules_json: parseJson(policy.season_rules_json, 'season_rules_json'), series: String(policy.series),
    calculator_version: String(policy.calculator_version),
  })).digest('hex');
}

function stayDates(checkIn, nights) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(checkIn || '')) || !Number.isInteger(Number(nights)) || Number(nights) <= 0) {
    throw policyError('TAKK policy requires valid check-in date and positive integer nights');
  }
  const start = new Date(`${checkIn}T12:00:00Z`);
  return Array.from({ length: Number(nights) }, (_, index) => {
    const date = new Date(start); date.setUTCDate(start.getUTCDate() + index); return date.toISOString().slice(0, 10);
  });
}

function normalizeSeasonRule(raw) {
  const high = raw?.high;
  if (!high || typeof high !== 'object' || !/^\d{2}-\d{2}$/.test(String(high.from || '')) || !/^\d{2}-\d{2}$/.test(String(high.to || ''))) {
    throw policyError('TAKK season_rules_json requires high.from and high.to as MM-DD', 409, 'TAKK_POLICY_SEASON_INVALID');
  }
  return { from: high.from, to: high.to };
}

function isHighSeason(date, season) {
  const day = String(date).slice(5, 10);
  return season.from <= season.to ? day >= season.from && day <= season.to : day >= season.from || day <= season.to;
}

function activeForStay(policy, dates) {
  return dates.every((date) => String(policy.valid_from) <= date && (!policy.valid_to || String(policy.valid_to) >= date));
}

async function resolveApprovedTakkPolicy({ reservation, billingContext, executor = db, lock = false }) {
  const dates = stayDates(reservation.checkIn, reservation.nights);
  let query = executor('takk_policy_versions').where({ company_id: billingContext.company_id, listing_id: billingContext.listing_id }).orderBy('version', 'desc');
  if (lock && executor.client.config.client === 'pg') query = query.forUpdate();
  const policies = (await query).filter((policy) => activeForStay(policy, dates));
  const approved = await approvedPolicyIds(policies, 'takk', executor);
  const candidates = policies.filter((policy) => approved.has(Number(policy.id)));
  if (candidates.length !== 1) throw policyError(`Expected exactly one approved TAKK policy covering every stay night; found ${candidates.length}`);
  const policy = { ...candidates[0], seasonRules: normalizeSeasonRule(parseJson(candidates[0].season_rules_json, 'season_rules_json')) };
  await assertPolicyDecisionApproved(policy, 'takk', executor, { lock });
  if (takkPolicyHash(policy) !== policy.policy_hash) throw policyError('TAKK policy hash does not match its fiscal configuration', 409, 'TAKK_POLICY_HASH_MISMATCH');
  const samples = await executor('takk_calibration_samples').where({ policy_id: policy.id, passed: true }).select('scenario');
  const scenarios = new Set(samples.map((sample) => sample.scenario));
  if (!scenarios.has('low') || !scenarios.has('high') || !scenarios.has('boundary')) {
    throw policyError(`TAKK policy ${policy.id} requires passed low, high and boundary calibration evidence`);
  }
  const approvals = await executor('policy_approvals').where({ takk_policy_id: policy.id, policy_hash: policy.policy_hash }).select('approval_role');
  const roles = new Set(approvals.map((approval) => approval.approval_role));
  if (!roles.has('accounting') || !roles.has('technical')) throw policyError(`TAKK policy ${policy.id} requires matching accounting and technical approvals`);
  return { policy, dates };
}

function feeLines(policy, dates) {
  return dates.map((date) => {
    const high = isHighSeason(date, policy.seasonRules);
    const cents = high ? Number(policy.high_rate_cents) : Number(policy.low_rate_cents);
    const category = high ? Number(policy.high_category) : Number(policy.low_category);
    if (!Number.isSafeInteger(cents) || cents <= 0 || !Number.isInteger(category) || category <= 0) throw policyError('TAKK policy has invalid rate or AADE category');
    return { date, cents, amount: Number((cents / 100).toFixed(2)), category, season: high ? 'high' : 'low' };
  });
}

async function applyTakkPolicy(reservation, billingContext, options = {}) {
  const { policy, dates } = await resolveApprovedTakkPolicy({ reservation, billingContext, ...options });
  const lines = feeLines(policy, dates);
  return {
    ...reservation,
    climateFeeLines: lines,
    unifiedTakkPolicy: {
      id: policy.id, version: Number(policy.version), policyHash: policy.policy_hash, series: normalizeSeries(policy.series, { required: true }),
      propertyType: policy.property_type, licensedCategory: policy.licensed_category, feeLines: lines,
    },
  };
}

async function assertApprovedTakkPolicyBinding(expected, reservation, billingContext, executor) {
  if (!expected?.id || !expected?.policyHash) throw policyError('Missing frozen TAKK policy binding');
  const { policy } = await resolveApprovedTakkPolicy({ reservation, billingContext, executor, lock: true });
  if (Number(policy.id) !== Number(expected.id) || Number(policy.version) !== Number(expected.version) || policy.policy_hash !== expected.policyHash) {
    throw policyError('TAKK policy changed before fiscal materialization', 409, 'TAKK_POLICY_CHANGED');
  }
  return policy;
}

module.exports = { takkPolicyHash, feeLines, applyTakkPolicy, assertApprovedTakkPolicyBinding };

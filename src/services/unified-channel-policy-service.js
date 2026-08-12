'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { normalizeCounterpart, normalizeSeries } = require('../validation/fiscal-fields');
const { evaluateFolio, normalizeChannelKey, validateLineRules } = require('./financial-rule-engine');
const { assertSingleStayFiscalFolio } = require('./financial-profile-service');
const { approvedPolicyIds, assertPolicyDecisionApproved } = require('./policy-decision-service');

function policyError(message, status = 409, code = 'UNIFIED_CHANNEL_POLICY_BLOCKED') {
  return Object.assign(new Error(message), { status, code });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function parseJson(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { throw policyError(`${label} is not valid JSON`, 409, 'UNIFIED_CHANNEL_POLICY_INVALID'); }
}

function channelPolicyHash(policy) {
  const canonical = {
    company_id: Number(policy.company_id), listing_id: Number(policy.listing_id),
    guesty_account_id: String(policy.guesty_account_id), platform_key: String(policy.platform_key),
    source_key: String(policy.source_key), currency: String(policy.currency || 'EUR'), version: Number(policy.version),
    recipient_model: String(policy.recipient_model), document_type: String(policy.document_type), series: String(policy.series),
    counterpart_json: parseJson(policy.counterpart_json, 'counterpart_json'), vat_category: Number(policy.vat_category),
    classification_category: String(policy.classification_category), classification_type: String(policy.classification_type),
    gross_strategy: String(policy.gross_strategy), gross_strategy_config_json: parseJson(policy.gross_strategy_config_json, 'gross_strategy_config_json'),
    line_rules_json: parseJson(policy.line_rules_json, 'line_rules_json'), tolerance_cents: Number(policy.tolerance_cents),
    normalizer_version: String(policy.normalizer_version), calculator_version: String(policy.calculator_version),
    valid_from: policy.valid_from || null, valid_to: policy.valid_to || null,
  };
  return crypto.createHash('sha256').update(stableJson(canonical)).digest('hex');
}

function requiredGuestyAccountId(reservation, explicit) {
  const value = explicit || reservation?.guestyAccountId || process.env.GUESTY_ACCOUNT_ID;
  const normalized = String(value || '').trim();
  if (!normalized) throw policyError('GUESTY_ACCOUNT_ID is required for unified policy resolution', 503, 'GUESTY_ACCOUNT_ID_REQUIRED');
  return normalized;
}

function activeOnDate(policy, issueDate) {
  return (!policy.valid_from || String(policy.valid_from) <= issueDate)
    && (!policy.valid_to || String(policy.valid_to) >= issueDate);
}

function hydratePolicy(policy) {
  if (!policy) return null;
  return {
    ...policy,
    line_rules: parseJson(policy.line_rules_json, 'line_rules_json') || [],
    strategy_config: parseJson(policy.gross_strategy_config_json, 'gross_strategy_config_json') || {},
    counterpart: parseJson(policy.counterpart_json, 'counterpart_json'),
  };
}

function validateRoute(policy) {
  const isPrivate = policy.recipient_model === 'private_guest';
  const isBusiness = policy.recipient_model === 'approved_business_counterpart';
  if (isPrivate && policy.document_type === '11.2' && !policy.counterpart) return null;
  if (isBusiness && policy.document_type === '2.1' && policy.counterpart) {
    return normalizeCounterpart(policy.counterpart, { required: true, label: 'approved policy counterpart' });
  }
  throw policyError('Unified policy recipient model, counterpart and document type are inconsistent', 409, 'UNIFIED_CHANNEL_RECIPIENT_INVALID');
}

async function approvalsAndSamplesValid(policy, executor) {
  const [samples, approvals] = await Promise.all([
    executor('channel_policy_samples as s')
      .join('fiscal_evidence_captures as e', 'e.id', 's.evidence_capture_id')
      .where({ 's.policy_id': policy.id, 's.policy_hash': policy.policy_hash, 's.passed': true, 's.stale': false })
      .whereNotNull('s.historical_mark')
      .select('e.reservation_id'),
    executor('policy_approvals').where({ channel_policy_id: policy.id, policy_hash: policy.policy_hash }).select('approval_role'),
  ]);
  const validSamples = new Set(samples.map((sample) => String(sample.reservation_id))).size;
  const roles = new Set(approvals.map((approval) => approval.approval_role));
  if (validSamples < 3) throw policyError(`Unified channel policy ${policy.id} requires at least 3 distinct finalized calibration samples`);
  if (!roles.has('accounting') || !roles.has('technical')) {
    throw policyError(`Unified channel policy ${policy.id} requires matching accounting and technical approvals`);
  }
}

async function resolveApprovedUnifiedChannelPolicy({ reservation, billingContext, guestyAccountId, executor = db, lock = false }) {
  const platformKey = normalizeChannelKey(reservation.platformKey || reservation.platform);
  const sourceKey = normalizeChannelKey(reservation.sourceKey || reservation.source);
  const currency = String(reservation.fiscalCurrency || reservation.financials?.currency || 'EUR').trim().toUpperCase();
  const issueDate = String(reservation.checkOut || '').slice(0, 10);
  if (!platformKey || !sourceKey || !issueDate) throw policyError('Guesty platform/source and check-out date are required for unified policy resolution');
  if (currency !== 'EUR') throw policyError(`Guesty reservation currency ${currency} is not supported for unified policy issuance`);
  let query = executor('channel_policy_versions').where({
    company_id: billingContext.company_id, listing_id: billingContext.listing_id,
    guesty_account_id: requiredGuestyAccountId(reservation, guestyAccountId), platform_key: platformKey, source_key: sourceKey, currency,
  }).orderBy('version', 'desc');
  if (lock && executor.client.config.client === 'pg') query = query.forUpdate();
  const policies = (await query).filter((candidate) => activeOnDate(candidate, issueDate));
  const approved = await approvedPolicyIds(policies, 'channel', executor);
  const candidates = policies.filter((candidate) => approved.has(Number(candidate.id)));
  if (candidates.length !== 1) {
    throw policyError(`Expected exactly one approved unified policy for ${platformKey} / ${sourceKey}; found ${candidates.length}`);
  }
  const policy = hydratePolicy(candidates[0]);
  await assertPolicyDecisionApproved(policy, 'channel', executor, { lock });
  if (channelPolicyHash(policy) !== policy.policy_hash) throw policyError('Unified policy hash does not match its fiscal configuration', 409, 'UNIFIED_CHANNEL_POLICY_HASH_MISMATCH');
  if (policy.gross_strategy !== 'folio_items_sum') throw policyError(`Unsupported unified gross strategy ${policy.gross_strategy}`);
  try { policy.line_rules = validateLineRules(policy.line_rules); } catch (error) { throw policyError(`Unified policy line rules are invalid: ${error.message}`); }
  const counterpart = validateRoute(policy);
  await approvalsAndSamplesValid(policy, executor);
  return { policy, counterpart, platformKey, sourceKey, currency };
}

async function applyUnifiedChannelPolicy(reservation, billingContext, options = {}) {
  const resolved = await resolveApprovedUnifiedChannelPolicy({ reservation, billingContext, ...options });
  const invoiceItems = assertSingleStayFiscalFolio(reservation);
  const result = evaluateFolio({
    invoiceItems,
    profile: { status: 'approved', line_rules: resolved.policy.line_rules, tolerance_cents: resolved.policy.tolerance_cents },
  });
  if (!result.ok) throw policyError(`Unified channel policy blocked issuance: ${(result.errors || []).map((item) => item.code).join(', ')}`);
  return {
    ...reservation,
    platformKey: resolved.platformKey,
    sourceKey: resolved.sourceKey,
    invoiceType: resolved.policy.document_type,
    invoiceSeries: normalizeSeries(resolved.policy.series, { required: true }),
    invoiceCounterpart: resolved.counterpart || undefined,
    financials: {
      ...reservation.financials,
      totalGross: result.totalGross,
      amountSource: 'approved_unified_channel_policy',
      invoiceItems,
      reconciliation: result.reconciliation,
    },
    unifiedChannelPolicy: {
      id: resolved.policy.id, version: Number(resolved.policy.version), policyHash: resolved.policy.policy_hash,
      guestyAccountId: resolved.policy.guesty_account_id, platformKey: resolved.platformKey, sourceKey: resolved.sourceKey,
      currency: resolved.currency, documentType: resolved.policy.document_type, series: resolved.policy.series,
      recipientModel: resolved.policy.recipient_model, counterpart: resolved.counterpart || null,
      classificationType: resolved.policy.classification_type, classificationCategory: resolved.policy.classification_category,
      evidenceHash: crypto.createHash('sha256').update(stableJson(result.evidence)).digest('hex'),
    },
  };
}

async function assertApprovedUnifiedChannelPolicyBinding(expected, reservation, billingContext, executor) {
  if (!expected?.id || !expected?.policyHash) throw policyError('Missing frozen unified policy binding');
  const resolved = await resolveApprovedUnifiedChannelPolicy({ reservation, billingContext, executor, lock: true, guestyAccountId: expected.guestyAccountId });
  const same = Number(resolved.policy.id) === Number(expected.id)
    && Number(resolved.policy.version) === Number(expected.version)
    && resolved.policy.policy_hash === expected.policyHash;
  if (!same) throw policyError('Unified channel policy changed before fiscal materialization', 409, 'UNIFIED_CHANNEL_POLICY_CHANGED');
  return resolved.policy;
}

module.exports = {
  channelPolicyHash,
  resolveApprovedUnifiedChannelPolicy,
  applyUnifiedChannelPolicy,
  assertApprovedUnifiedChannelPolicyBinding,
};

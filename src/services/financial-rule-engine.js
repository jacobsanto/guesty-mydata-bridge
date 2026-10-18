'use strict';

const crypto = require('crypto');

const SELECTOR_FIELDS = ['normalType', 'origin', 'title', 'secondIdentifier', 'isDeducted', 'isDeductedV2'];

class FinancialRuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FinancialRuleError';
    this.code = code;
  }
}

function normalizeChannelKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new FinancialRuleError('INVALID_CHANNEL_KEY', 'Channel key must be a string');
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized || null;
}

function normalizeSelectorString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FinancialRuleError('INVALID_LINE_RULE', `${field} must be a non-empty string`);
  }
  const normalized = value.normalize('NFKC').trim();
  return field === 'normalType' ? normalized.toUpperCase() : normalized.toLowerCase();
}

function decisionFor(rule) {
  const stringDecision = rule.action ?? rule.decision;
  if (stringDecision !== undefined) {
    const decision = String(stringDecision).trim().toLowerCase();
    if (!['include', 'exclude'].includes(decision)) {
      throw new FinancialRuleError('INVALID_LINE_RULE', 'Rule action must be include or exclude');
    }
    if (rule.include !== undefined && Boolean(rule.include) !== (decision === 'include')) {
      throw new FinancialRuleError('INVALID_LINE_RULE', 'Rule action and include flag conflict');
    }
    return decision;
  }
  if (typeof rule.include === 'boolean') return rule.include ? 'include' : 'exclude';
  throw new FinancialRuleError('INVALID_LINE_RULE', 'Rule must explicitly include or exclude matching lines');
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new FinancialRuleError('INVALID_LINE_RULE', 'Each line rule must be an object');
  }
  const source = rule.selector && typeof rule.selector === 'object'
    ? { ...rule, ...rule.selector }
    : rule;
  const normalized = {
    decision: decisionFor(rule),
    normalType: normalizeSelectorString(source.normalType, 'normalType'),
  };
  for (const field of ['origin', 'title', 'secondIdentifier']) {
    if (source[field] !== undefined) normalized[field] = normalizeSelectorString(source[field], field);
  }
  for (const field of ['isDeducted', 'isDeductedV2']) {
    if (source[field] !== undefined) {
      if (typeof source[field] !== 'boolean') {
        throw new FinancialRuleError('INVALID_LINE_RULE', `${field} must be boolean when supplied`);
      }
      normalized[field] = source[field];
    }
  }
  const hasDiscriminator = SELECTOR_FIELDS.some((field) => field !== 'normalType' && normalized[field] !== undefined);
  if (normalized.decision === 'include' && !hasDiscriminator && rule.allowBroad !== true) {
    throw new FinancialRuleError('BROAD_INCLUDE_REQUIRES_APPROVAL', 'Broad include rules require allowBroad: true or a stable discriminator');
  }
  if (rule.allowBroad === true) normalized.allowBroad = true;
  return normalized;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function ruleSelectorKey(rule) {
  return stableJson(Object.fromEntries(SELECTOR_FIELDS.filter((field) => rule[field] !== undefined).map((field) => [field, rule[field]])));
}

function normalizedRuleSort(a, b) {
  const left = `${ruleSelectorKey(a)}:${a.decision}`;
  const right = `${ruleSelectorKey(b)}:${b.decision}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateLineRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new FinancialRuleError('INVALID_LINE_RULES', 'At least one explicit line rule is required');
  }
  const normalized = rules.map(normalizeRule).sort(normalizedRuleSort);
  const selectors = new Map();
  for (const rule of normalized) {
    const key = ruleSelectorKey(rule);
    if (selectors.has(key)) {
      const previous = selectors.get(key);
      const code = previous === rule.decision ? 'DUPLICATE_RULE' : 'CONFLICTING_RULES';
      throw new FinancialRuleError(code, 'Line rules cannot repeat or conflict on the same selector');
    }
    selectors.set(key, rule.decision);
  }
  return normalized;
}

function decimalToCents(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value))) {
    throw new FinancialRuleError('NONFINITE_AMOUNT', `${field} must be a finite monetary amount`);
  }
  const number = Number(value);
  const cents = Math.sign(number) * Math.round((Math.abs(number) + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new FinancialRuleError('UNSAFE_AMOUNT', `${field} exceeds the safe monetary range`);
  }
  return cents;
}

function centsConfig(profile, centKeys, decimalKeys, field, defaultCents = null) {
  const centValues = centKeys.filter((key) => profile[key] !== undefined).map((key) => profile[key]);
  const decimalValues = decimalKeys.filter((key) => profile[key] !== undefined).map((key) => profile[key]);
  if (centValues.length > 1 || decimalValues.length > 1) {
    throw new FinancialRuleError('INVALID_PROFILE', `${field} is configured more than once`);
  }
  let cents = defaultCents;
  if (centValues.length) {
    const value = Number(centValues[0]);
    if (!Number.isSafeInteger(value)) throw new FinancialRuleError('INVALID_PROFILE', `${field} cents must be an integer`);
    cents = value;
  }
  if (decimalValues.length) {
    const fromDecimal = decimalToCents(decimalValues[0], field);
    if (centValues.length && fromDecimal !== cents) {
      throw new FinancialRuleError('INVALID_PROFILE', `${field} cents and decimal values conflict`);
    }
    cents = fromDecimal;
  }
  if (cents !== null && cents < 0) throw new FinancialRuleError('INVALID_PROFILE', `${field} cannot be negative`);
  return cents;
}

function profileRules(profile) {
  if (profile.line_rules !== undefined && profile.lineRules !== undefined) {
    throw new FinancialRuleError('INVALID_PROFILE', 'Use either line_rules or lineRules, not both');
  }
  return profile.line_rules ?? profile.lineRules;
}

function normalizedProfileConfig(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new FinancialRuleError('PROFILE_REQUIRED', 'A financial profile is required');
  }
  return {
    channelKey: normalizeChannelKey(profile.channel_key ?? profile.channelKey ?? profile.channel),
    lineRules: validateLineRules(profileRules(profile)),
    toleranceCents: centsConfig(profile, ['tolerance_cents', 'toleranceCents'], ['tolerance'], 'tolerance', 0),
    expectedTotalCents: centsConfig(
      profile,
      ['expected_total_cents', 'expectedTotalCents'],
      ['expected_total', 'expectedTotal', 'reference_total', 'referenceTotal'],
      'expected total',
      null,
    ),
  };
}

function hashProfileConfig(profile) {
  const config = normalizedProfileConfig(profile);
  return crypto.createHash('sha256').update(stableJson(config)).digest('hex');
}

function normalizedItemSelector(item, field) {
  if (item[field] === undefined || item[field] === null) return undefined;
  if (field === 'isDeducted' || field === 'isDeductedV2') {
    return typeof item[field] === 'boolean' ? item[field] : undefined;
  }
  if (typeof item[field] !== 'string') return undefined;
  const value = item[field].normalize('NFKC').trim();
  if (!value) return undefined;
  return field === 'normalType' ? value.toUpperCase() : value.toLowerCase();
}

function matchesRule(item, rule) {
  return SELECTOR_FIELDS.every((field) => rule[field] === undefined || normalizedItemSelector(item, field) === rule[field]);
}

function opaqueKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function deterministicSort(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function blocked(errors, evidence = [], profileHash = null, reconciliation = null) {
  return {
    ok: false,
    blocked: true,
    totalCents: null,
    totalGross: null,
    reconciliation,
    profileHash,
    errors: [...errors].sort((a, b) => deterministicSort(`${a.itemKey || ''}:${a.code}`, `${b.itemKey || ''}:${b.code}`)),
    evidence: [...evidence].sort((a, b) => deterministicSort(a.itemKey, b.itemKey)),
  };
}

function evaluateFolio({ invoiceItems, profile } = {}) {
  if (!profile || typeof profile !== 'object') return blocked([{ code: 'PROFILE_REQUIRED' }]);
  const approved = profile.approved !== undefined
    ? profile.approved === true
    : String(profile.status || '').trim().toLowerCase() === 'approved';
  if (!approved) return blocked([{ code: 'PROFILE_UNAPPROVED' }]);

  let config;
  let profileHash;
  try {
    config = normalizedProfileConfig(profile);
    profileHash = crypto.createHash('sha256').update(stableJson(config)).digest('hex');
  } catch (error) {
    return blocked([{ code: error.code || 'INVALID_PROFILE' }]);
  }
  if (!Array.isArray(invoiceItems) || invoiceItems.length === 0) {
    return blocked([{ code: 'EMPTY_FOLIO' }], [], profileHash);
  }

  const errors = [];
  const evidence = [];
  const seenIds = new Set();
  // Guesty returns totalPrice with full stored precision. Accumulate the
  // approved raw amounts first (Kahan summation limits binary-float drift) and
  // round only the final fiscal gross to cents. Rounding every folio item first
  // can over/understate reservations that contain several sub-cent values.
  let includedAmount = 0;
  let includedCompensation = 0;
  for (const item of invoiceItems) {
    const rawId = item && typeof item === 'object' ? (item.id ?? item._id) : null;
    const itemKey = rawId === null || rawId === undefined || String(rawId).trim() === '' ? null : opaqueKey(rawId);
    if (!itemKey) {
      errors.push({ code: 'MISSING_ITEM_ID' });
      continue;
    }
    if (seenIds.has(String(rawId))) {
      errors.push({ code: 'DUPLICATE_ITEM', itemKey });
      continue;
    }
    seenIds.add(String(rawId));
    if (!item || typeof item !== 'object') {
      errors.push({ code: 'INVALID_ITEM', itemKey });
      continue;
    }
    let amountCents;
    let totalPriceDecimal;
    try {
      amountCents = decimalToCents(item.totalPrice, 'totalPrice');
      if (amountCents === null) throw new FinancialRuleError('NONFINITE_AMOUNT', 'totalPrice is required');
      // Preserve Guesty's exact JSON-number representation for audit and
      // calibration. amountCents is display-only and must never be used to
      // reconstruct a total containing sub-cent invoice items.
      totalPriceDecimal = String(item.totalPrice);
    } catch (error) {
      errors.push({ code: error.code || 'NONFINITE_AMOUNT', itemKey });
      continue;
    }
    const matchingRules = config.lineRules.filter((rule) => matchesRule(item, rule));
    if (matchingRules.length === 0) {
      errors.push({ code: 'UNKNOWN_LINE', itemKey });
      evidence.push({ itemKey, normalType: normalizedItemSelector(item, 'normalType') || null, totalPriceDecimal, amountCents, decision: 'blocked', ruleKeys: [] });
      continue;
    }
    if (matchingRules.length > 1) {
      const decisions = new Set(matchingRules.map((rule) => rule.decision));
      errors.push({ code: decisions.size > 1 ? 'CONFLICTING_MATCH' : 'AMBIGUOUS_MATCH', itemKey });
      evidence.push({
        itemKey,
        normalType: normalizedItemSelector(item, 'normalType') || null,
        totalPriceDecimal,
        amountCents,
        decision: 'blocked',
        ruleKeys: matchingRules.map((rule) => opaqueKey(`${ruleSelectorKey(rule)}:${rule.decision}`)).sort(deterministicSort),
      });
      continue;
    }
    const rule = matchingRules[0];
    const included = rule.decision === 'include';
    if (included) {
      const adjusted = Number(item.totalPrice) - includedCompensation;
      const next = includedAmount + adjusted;
      includedCompensation = (next - includedAmount) - adjusted;
      includedAmount = next;
    }
    evidence.push({
      itemKey,
      normalType: normalizedItemSelector(item, 'normalType') || null,
      totalPriceDecimal,
      amountCents,
      decision: rule.decision,
      ruleKey: opaqueKey(`${ruleSelectorKey(rule)}:${rule.decision}`),
    });
  }
  if (errors.length) return blocked(errors, evidence, profileHash);
  let includedCents;
  try {
    includedCents = decimalToCents(includedAmount, 'included total');
  } catch (error) {
    return blocked([{ code: error.code || 'UNSAFE_TOTAL' }], evidence, profileHash);
  }
  if (includedCents <= 0) return blocked([{ code: 'NONPOSITIVE_TOTAL' }], evidence, profileHash);

  let reconciliation = { status: 'not_configured', expectedTotalCents: null, differenceCents: null, toleranceCents: config.toleranceCents };
  if (config.expectedTotalCents !== null) {
    const differenceCents = Math.abs(includedCents - config.expectedTotalCents);
    reconciliation = {
      status: differenceCents <= config.toleranceCents ? 'matched' : 'mismatch',
      expectedTotalCents: config.expectedTotalCents,
      differenceCents,
      toleranceCents: config.toleranceCents,
    };
    if (reconciliation.status === 'mismatch') {
      return blocked([{ code: 'TOTAL_MISMATCH' }], evidence, profileHash, reconciliation);
    }
  }

  return {
    ok: true,
    blocked: false,
    totalCents: includedCents,
    totalGross: includedCents / 100,
    reconciliation,
    profileHash,
    errors: [],
    evidence: evidence.sort((a, b) => deterministicSort(a.itemKey, b.itemKey)),
  };
}

module.exports = {
  FinancialRuleError,
  normalizeChannelKey,
  validateLineRules,
  hashProfileConfig,
  evaluateFolio,
};

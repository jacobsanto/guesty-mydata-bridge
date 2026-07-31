'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeChannelKey,
  validateLineRules,
  hashProfileConfig,
  evaluateFolio,
} = require('../src/services/financial-rule-engine');

function approvedProfile(channel, expectedTotal, lineRules, extra = {}) {
  const auditedRules = lineRules.map((rule) => {
    const include = rule.action === 'include' || rule.include === true;
    const discriminated = ['origin', 'title', 'secondIdentifier', 'isDeducted', 'isDeductedV2']
      .some((field) => rule[field] !== undefined || rule.selector?.[field] !== undefined);
    return include && !discriminated ? { ...rule, allowBroad: true } : rule;
  });
  return { channel_key: channel, approved: true, expected_total: expectedTotal, tolerance_cents: 0, line_rules: auditedRules, ...extra };
}

test('channel keys normalize deterministically without applying aliases', () => {
  assert.equal(normalizeChannelKey('  Booking   Engine  '), 'booking engine');
  assert.equal(normalizeChannelKey('ＡＩＲＢＮＢ２'), 'airbnb2');
  assert.equal(normalizeChannelKey('bookingCom'), 'bookingcom');
  assert.equal(normalizeChannelKey('booking.com'), 'booking.com');
  assert.equal(normalizeChannelKey('  '), null);
});

test('line rules require explicit, unique include/exclude selectors', () => {
  assert.throws(() => validateLineRules([]), (error) => error.code === 'INVALID_LINE_RULES');
  assert.throws(() => validateLineRules([{ normalType: 'AF' }]), (error) => error.code === 'INVALID_LINE_RULE');
  assert.throws(() => validateLineRules([
    { normalType: 'AF', action: 'include' },
  ]), (error) => error.code === 'BROAD_INCLUDE_REQUIRES_APPROVAL');
  assert.throws(() => validateLineRules([
    { normalType: 'AF', action: 'include', allowBroad: true },
    { normalType: 'af', include: true, allowBroad: true },
  ]), (error) => error.code === 'DUPLICATE_RULE');
  assert.throws(() => validateLineRules([
    { normalType: 'AF', action: 'include', allowBroad: true },
    { normalType: 'af', action: 'exclude' },
  ]), (error) => error.code === 'CONFLICTING_RULES');
  const rules = validateLineRules([
    { normalType: 'AF', origin: 'Room', isDeducted: true, action: 'include' },
    { selector: { normalType: 'CT', secondIdentifier: 'City' }, include: false },
  ]);
  assert.equal(rules.length, 2);
  assert(rules.some((rule) => rule.normalType === 'AF' && rule.origin === 'room' && rule.isDeducted === true));
});

test('a stable title discriminator blocks a changed Guesty line instead of guessing', () => {
  const profile = approvedProfile('other-ota', 113, [
    { normalType: 'AF', title: 'Accommodation fare', action: 'include' },
    { normalType: 'VAT', title: 'VAT 13%', action: 'include' },
  ]);
  const result = evaluateFolio({ profile, invoiceItems: [
    { id: 'ota-af', normalType: 'AF', title: 'Room charge', totalPrice: 100 },
    { id: 'ota-vat', normalType: 'VAT', title: 'VAT 13%', totalPrice: 13 },
  ] });
  assert.equal(result.blocked, true);
  assert.equal(result.errors.some((error) => error.code === 'UNKNOWN_LINE'), true);
});

test('another OTA uses its own calibrated profile and never inherits Airbnb or Booking rules', () => {
  const profile = approvedProfile('expedia', 226, [
    { normalType: 'ROOM', origin: 'expedia', action: 'include' },
    { normalType: 'VAT', origin: 'expedia', action: 'include' },
    { normalType: 'COMMISSION', action: 'exclude' },
  ]);
  const result = evaluateFolio({ profile, invoiceItems: [
    { id: 'ex-room', normalType: 'ROOM', origin: 'expedia', totalPrice: 200 },
    { id: 'ex-vat', normalType: 'VAT', origin: 'expedia', totalPrice: 26 },
    { id: 'ex-commission', normalType: 'COMMISSION', totalPrice: -34 },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.totalCents, 22600);
});

test('full-precision Guesty amounts are summed before the one final cent rounding', () => {
  const profile = approvedProfile('precision-ota', 0.02, [
    { normalType: 'FEE', action: 'include', allowBroad: true },
  ]);
  const result = evaluateFolio({ profile, invoiceItems: [
    { id: 'precision-1', normalType: 'FEE', totalPrice: 0.005 },
    { id: 'precision-2', normalType: 'FEE', totalPrice: 0.005 },
    { id: 'precision-3', normalType: 'FEE', totalPrice: 0.005 },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.totalCents, 2);
  assert.deepEqual(result.evidence.map((line) => line.totalPriceDecimal), ['0.005', '0.005', '0.005']);
  assert.equal(result.evidence.reduce((sum, line) => sum + Number(line.totalPriceDecimal), 0), 0.015);
});

test('profile hash is stable across property and rule order and changes with fiscal config', () => {
  const a = approvedProfile('Airbnb2', 630, [
    { normalType: 'VAT', action: 'include' },
    { normalType: 'AF', action: 'include' },
  ], { approved_at: '2026-01-01' });
  const b = {
    approved_at: '2030-01-01',
    lineRules: [
      { action: 'include', normalType: 'AF', allowBroad: true },
      { action: 'include', normalType: 'VAT', allowBroad: true },
    ],
    expectedTotal: 630,
    channelKey: 'airbnb2',
    toleranceCents: 0,
    status: 'approved',
  };
  assert.equal(hashProfileConfig(a), hashProfileConfig(b));
  assert.notEqual(hashProfileConfig(a), hashProfileConfig({ ...a, tolerance_cents: 1 }));
});

test('Airbnb profile produces 630 without reapplying deduction flags', () => {
  const profile = approvedProfile('airbnb2', 630, [
    { normalType: 'AF', isDeducted: true, isDeductedV2: true, action: 'include' },
    { normalType: 'VAT', action: 'include' },
    { normalType: 'CT', action: 'exclude' },
    { normalType: 'AIRBNB_COMMISSION', action: 'exclude' },
  ]);
  const result = evaluateFolio({ profile, invoiceItems: [
    { id: 'airbnb-af', normalType: 'AF', totalPrice: 557.52, isDeducted: true, isDeductedV2: true, nightsSubtotal: 9999 },
    { id: 'airbnb-vat', normalType: 'VAT', totalPrice: 72.48, adjustments: [{ amount: -500 }] },
    { id: 'airbnb-city', normalType: 'CT', totalPrice: 24 },
    { id: 'airbnb-commission', normalType: 'AIRBNB_COMMISSION', totalPrice: -94.50 },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.totalCents, 63000);
  assert.equal(result.totalGross, 630);
  assert.equal(result.reconciliation.status, 'matched');
  assert.deepEqual(result.evidence.map((line) => line.decision).sort(), ['exclude', 'exclude', 'include', 'include']);
});

test('Booking.com profile produces 485.90 and excludes city, local and commission lines', () => {
  const profile = approvedProfile('bookingcom', 485.90, [
    { normalType: 'AF', action: 'include', allowBroad: true },
    { normalType: 'CLEANING', action: 'include' },
    { normalType: 'VAT', action: 'include' },
    { normalType: 'CT', action: 'exclude' },
    { normalType: 'LT', action: 'exclude' },
    { normalType: 'BOOKING_COMMISSION', action: 'exclude' },
  ]);
  const result = evaluateFolio({ profile, invoiceItems: [
    { id: 'b-af', normalType: 'AF', totalPrice: 400 },
    { id: 'b-clean', normalType: 'CLEANING', totalPrice: 30 },
    { id: 'b-vat', normalType: 'VAT', totalPrice: 55.90 },
    { id: 'b-ct', normalType: 'CT', totalPrice: 8 },
    { id: 'b-lt', normalType: 'LT', totalPrice: 6 },
    { id: 'b-commission', normalType: 'BOOKING_COMMISSION', totalPrice: -72.30 },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.totalCents, 48590);
});

test('Guesty Booking Engine applies a discount exactly once and produces 316.40', () => {
  const profile = approvedProfile('booking_engine', 316.40, [
    { normalType: 'AF', action: 'include', allowBroad: true },
    { normalType: 'VAT', action: 'include' },
    { normalType: 'DISCOUNT', isDeductedV2: true, action: 'include' },
    { normalType: 'PAYMENT_PROCESSING', action: 'exclude' },
  ]);
  const result = evaluateFolio({ profile, invoiceItems: [
    { id: 'be-af', normalType: 'AF', totalPrice: 300 },
    { id: 'be-vat', normalType: 'VAT', totalPrice: 39 },
    { id: 'be-discount', normalType: 'DISCOUNT', totalPrice: -22.60, isDeductedV2: true, adjustments: [{ amount: -22.60 }] },
    { id: 'be-processing', normalType: 'PAYMENT_PROCESSING', totalPrice: -6 },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.totalCents, 31640);
});

test('unknown or unapproved channel profiles fail closed', () => {
  const items = [{ id: 'unknown-af', normalType: 'AF', totalPrice: 200 }, { id: 'unknown-vat', normalType: 'VAT', totalPrice: 26 }];
  assert.deepEqual(evaluateFolio({ invoiceItems: items, profile: null }).errors, [{ code: 'PROFILE_REQUIRED' }]);
  const draft = approvedProfile('unknown-ota', 226, [{ normalType: 'AF', action: 'include' }, { normalType: 'VAT', action: 'include' }]);
  draft.approved = false;
  assert.deepEqual(evaluateFolio({ invoiceItems: items, profile: draft }).errors, [{ code: 'PROFILE_UNAPPROVED' }]);
});

test('empty, nonfinite, duplicate and unmatched folio lines block evaluation', () => {
  const profile = approvedProfile('test', 113, [{ normalType: 'AF', action: 'include' }, { normalType: 'VAT', action: 'include' }]);
  assert.equal(evaluateFolio({ profile, invoiceItems: [] }).errors[0].code, 'EMPTY_FOLIO');
  assert.equal(evaluateFolio({ profile, invoiceItems: [{ id: 'bad', normalType: 'AF', totalPrice: Infinity }] }).errors[0].code, 'NONFINITE_AMOUNT');
  assert.equal(evaluateFolio({ profile, invoiceItems: [
    { id: 'same', normalType: 'AF', totalPrice: 100 },
    { id: 'same', normalType: 'VAT', totalPrice: 13 },
  ] }).errors.some((error) => error.code === 'DUPLICATE_ITEM'), true);
  assert.equal(evaluateFolio({ profile, invoiceItems: [{ id: 'city', normalType: 'CT', totalPrice: 4 }] }).errors[0].code, 'UNKNOWN_LINE');
});

test('overlapping selectors produce ambiguous or conflicting matches', () => {
  const item = [{ id: 'af-room', normalType: 'AF', origin: 'room', totalPrice: 100 }];
  const ambiguous = approvedProfile('test', 100, [
    { normalType: 'AF', action: 'include' },
    { normalType: 'AF', origin: 'room', action: 'include' },
  ]);
  assert.equal(evaluateFolio({ profile: ambiguous, invoiceItems: item }).errors[0].code, 'AMBIGUOUS_MATCH');
  const conflicting = approvedProfile('test', 100, [
    { normalType: 'AF', action: 'include' },
    { normalType: 'AF', origin: 'room', action: 'exclude' },
  ]);
  assert.equal(evaluateFolio({ profile: conflicting, invoiceItems: item }).errors[0].code, 'CONFLICTING_MATCH');
});

test('tolerance accepts the exact boundary and blocks one cent beyond it', () => {
  const items = [{ id: 'af', normalType: 'AF', totalPrice: 485.90 }];
  const rules = [{ normalType: 'AF', action: 'include' }];
  const accepted = evaluateFolio({
    invoiceItems: items,
    profile: approvedProfile('bookingcom', 485.91, rules, { tolerance_cents: 1 }),
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.reconciliation, {
    status: 'matched', expectedTotalCents: 48591, differenceCents: 1, toleranceCents: 1,
  });
  const rejected = evaluateFolio({
    invoiceItems: items,
    profile: approvedProfile('bookingcom', 485.92, rules, { tolerance: 0.01, tolerance_cents: undefined }),
  });
  assert.equal(rejected.blocked, true);
  assert.equal(rejected.errors[0].code, 'TOTAL_MISMATCH');
  assert.deepEqual(rejected.reconciliation, {
    status: 'mismatch', expectedTotalCents: 48592, differenceCents: 2, toleranceCents: 1,
  });
});

test('evidence is order-independent, sorted and excludes raw PII fields', () => {
  const profile = approvedProfile('test', 113, [{ normalType: 'AF', action: 'include' }, { normalType: 'VAT', action: 'include' }]);
  const first = { id: 'z-id', normalType: 'AF', totalPrice: 100, title: 'Guest Jane Doe', description: 'jane@example.test' };
  const second = { id: 'a-id', normalType: 'VAT', totalPrice: 13, secondIdentifier: 'secret-reference' };
  const a = evaluateFolio({ profile, invoiceItems: [first, second] });
  const b = evaluateFolio({ profile, invoiceItems: [second, first] });
  assert.deepEqual(a.evidence, b.evidence);
  assert.equal(JSON.stringify(a.evidence).includes('Jane Doe'), false);
  assert.equal(JSON.stringify(a.evidence).includes('jane@example.test'), false);
  assert.equal(JSON.stringify(a.evidence).includes('secret-reference'), false);
  assert.equal(JSON.stringify(a.evidence).includes('z-id'), false);
});

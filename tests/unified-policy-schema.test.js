'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const databasePath = `/tmp/guesty-mydata-unified-policy-${process.pid}.db`;
process.env.DB_CLIENT = 'better-sqlite3';
process.env.DB_PATH = databasePath;

const { db, initSchema } = require('../src/database');

let companyId;
let listingId;
let channelPolicyId;

test.before(async () => {
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
  await initSchema();
  [companyId] = await db('companies').insert({
    company_name: 'Unified Policy Test',
    vat_number: '109262634',
    active: true,
  });
  [listingId] = await db('listings').insert({
    company_id: companyId,
    listing_id_guesty: 'centro-policy-test',
    property_type: 'apartment',
    climate_fee_high: 8,
    climate_fee_low: 2,
    climate_fee_high_category: 24,
    climate_fee_low_category: 10,
    active: true,
  });
});

test.after(async () => {
  await db.destroy();
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
});

test('unified policy schema binds amount and recipient route in one version', async () => {
  [channelPolicyId] = await db('channel_policy_versions').insert({
    company_id: companyId,
    listing_id: listingId,
    guesty_account_id: 'guesty-account',
    platform_key: 'airbnb2',
    source_key: 'airbnb2',
    currency: 'EUR',
    version: 1,
    status: 'blocked',
    recipient_model: 'private_guest',
    document_type: '11.2',
    series: 'APY',
    vat_category: 2,
    classification_category: 'category1_3',
    classification_type: 'E3_561_003',
    gross_strategy: 'folio_items_sum',
    gross_strategy_config_json: '{}',
    line_rules_json: '[]',
    tolerance_cents: 0,
    normalizer_version: 'v1',
    calculator_version: 'v1',
    policy_hash: 'a'.repeat(64),
    blocked_reason: 'Recipient route requires accounting evidence',
    created_by: 'schema-test',
  });
  const policy = await db('channel_policy_versions').where({ id: channelPolicyId }).first();
  assert.equal(policy.document_type, '11.2');
  assert.equal(policy.recipient_model, 'private_guest');
  assert.equal(policy.gross_strategy, 'folio_items_sum');
  assert.equal(policy.tolerance_cents, 0);
  await assert.rejects(
    db('channel_policy_versions').where({ id: channelPolicyId }).update({ series: 'CHANGED' }),
    /immutable and append-only/,
  );
});

test('fiscal evidence and approvals are append-only', async () => {
  const payload = JSON.stringify({ reservationId: 'pseudonymized', invoiceItems: [] });
  const [captureId] = await db('fiscal_evidence_captures').insert({
    company_id: companyId,
    listing_id: listingId,
    reservation_id: 'pseudonymized',
    platform_key: 'bookingcom',
    source_key: 'booking.com',
    guesty_account_id: 'guesty-account',
    currency: 'EUR',
    normalized_payload_json: payload,
    payload_sha256: 'b'.repeat(64),
    capture_method: 'live_guesty_stable_snapshot',
    guesty_contract_version: 'reservations-v3+guest-folio-v1',
  });
  await assert.rejects(
    db('fiscal_evidence_captures').where({ id: captureId }).update({ normalized_payload_json: '{}' }),
    /immutable and append-only/,
  );
  await assert.rejects(
    db('fiscal_evidence_captures').where({ id: captureId }).delete(),
    /immutable and append-only/,
  );

  const [approvalId] = await db('policy_approvals').insert({
    channel_policy_id: channelPolicyId,
    policy_hash: 'a'.repeat(64),
    approval_role: 'accounting',
    actor_id: 'accountant:test',
  });
  await assert.rejects(
    db('policy_approvals').where({ id: approvalId }).update({ actor_id: 'changed' }),
    /immutable and append-only/,
  );
  const [decisionId] = await db('policy_decision_events').insert({
    channel_policy_id: channelPolicyId,
    policy_hash: 'a'.repeat(64),
    decision: 'approved',
    idempotency_key: 'fixture-schema-decision',
    actor_id: 'policy-authority:test',
    reason: 'Fixture approval decision',
  });
  await assert.rejects(
    db('policy_decision_events').where({ id: decisionId }).update({ decision: 'suspended' }),
    /immutable and append-only/,
  );
});

test('cross-tenant, cross-tuple and wrong-hash evidence fail closed', async () => {
  const [otherCompanyId] = await db('companies').insert({ company_name: 'Other', vat_number: '099999999', active: true });
  await assert.rejects(
    db('channel_policy_versions').insert({
      company_id: otherCompanyId,
      listing_id: listingId,
      guesty_account_id: 'guesty-account', platform_key: 'airbnb2', source_key: 'airbnb2', currency: 'EUR',
      version: 1, status: 'blocked', recipient_model: 'private_guest', document_type: '11.2', series: 'APY',
      vat_category: 2, classification_category: 'category1_3', classification_type: 'E3_561_003',
      gross_strategy: 'folio_items_sum', gross_strategy_config_json: '{}', line_rules_json: '[]', tolerance_cents: 0,
      normalizer_version: 'v1', calculator_version: 'v1', policy_hash: 'e'.repeat(64), created_by: 'schema-test',
    }),
    /listing must belong to company/,
  );

  const capture = await db('fiscal_evidence_captures').where({ reservation_id: 'pseudonymized' }).first();
  await assert.rejects(
    db('channel_policy_samples').insert({
      policy_id: channelPolicyId,
      evidence_capture_id: capture.id,
      policy_hash: 'a'.repeat(64),
      evidence_sha256: capture.payload_sha256,
      scenario: 'normal', historical_document_type: '11.2', historical_primary_cents: 10000,
      historical_takk_cents: 0, candidate_source_values_json: '{}', computed_primary_cents: 10000,
      delta_cents: 0, passed: true,
    }),
    /exact policy tuple and hashes/,
  );
  await assert.rejects(
    db('policy_approvals').insert({
      channel_policy_id: channelPolicyId,
      policy_hash: 'f'.repeat(64),
      approval_role: 'technical', actor_id: 'engineer:test',
    }),
    /exactly one policy with its exact hash/,
  );
  await assert.rejects(
    db('policy_decision_events').insert({
      channel_policy_id: channelPolicyId,
      policy_hash: 'f'.repeat(64),
      decision: 'approved',
      idempotency_key: 'fixture-schema-decision-wrong-hash',
      actor_id: 'policy-authority:test',
    }),
    /exactly one policy with its exact hash/,
  );
});

test('recipient model cannot be confused with an OTA payment collector', async () => {
  await assert.rejects(
    db('channel_policy_versions').insert({
      company_id: companyId, listing_id: listingId, guesty_account_id: 'guesty-account',
      platform_key: 'bookingcom', source_key: 'booking.com', currency: 'EUR', version: 1, status: 'blocked',
      recipient_model: 'private_guest', document_type: '2.1', series: 'TPY',
      counterpart_json: JSON.stringify({ vatNumber: 'IE9827384L', country: 'IE', name: 'OTA collector' }),
      vat_category: 2, classification_category: 'category1_3', classification_type: 'E3_561_007',
      gross_strategy: 'folio_items_sum', gross_strategy_config_json: '{}', line_rules_json: '[]', tolerance_cents: 0,
      normalizer_version: 'v1', calculator_version: 'v1', policy_hash: '9'.repeat(64), created_by: 'schema-test',
    }),
    /Recipient model and document type are inconsistent/,
  );
});

test('TAKK policy is independently versioned with immutable low/high/boundary evidence', async () => {
  const [policyId] = await db('takk_policy_versions').insert({
    company_id: companyId,
    listing_id: listingId,
    version: 1,
    status: 'blocked',
    property_type: 'rented_rooms',
    licensed_category: 'accountant-confirmation-required',
    valid_from: '2026-01-01',
    high_category: 24,
    low_category: 10,
    high_rate_cents: 800,
    low_rate_cents: 200,
    season_rules_json: JSON.stringify({ high: { from: '04-01', to: '10-31' } }),
    series: 'TAKK',
    calculator_version: 'v1',
    policy_hash: 'c'.repeat(64),
    blocked_reason: 'Licensed category and low season require approval',
    created_by: 'schema-test',
  });
  const [sampleId] = await db('takk_calibration_samples').insert({
    policy_id: policyId,
    scenario: 'high',
    check_in: '2026-06-01',
    check_out: '2026-06-03',
    expected_cents: 1600,
    computed_cents: 1600,
    delta_cents: 0,
    passed: true,
    evidence_sha256: 'd'.repeat(64),
  });
  await assert.rejects(
    db('takk_calibration_samples').where({ id: sampleId }).delete(),
    /immutable and append-only/,
  );
  await assert.rejects(
    db('takk_policy_versions').where({ id: policyId }).update({ high_rate_cents: 9999 }),
    /immutable and append-only/,
  );
});

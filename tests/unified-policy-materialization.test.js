'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const databasePath = `/tmp/guesty-mydata-unified-materialization-${process.pid}.db`;
process.env.DB_CLIENT = 'better-sqlite3';
process.env.DB_PATH = databasePath;
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString('base64');
process.env.GUESTY_ACCOUNT_ID = 'account-policy-test';

const { db, initSchema } = require('../src/database');
const { channelPolicyHash } = require('../src/services/unified-channel-policy-service');
const { takkPolicyHash } = require('../src/services/takk-policy-service');
const { getPolicyMatrix } = require('../src/services/policy-matrix-service');
const { stageReservation, applyFiscalOverride, materializeDueReservations } = require('../src/services/reservation-service');

let companyId;
let listing;

function sha(seed) {
  return seed.repeat(64).slice(0, 64);
}

function reservation(id) {
  const invoiceItems = [{ id: `${id}-af`, normalType: 'AF', title: 'Accommodation', totalPrice: 113, listingId: listing.listing_id_guesty, stayIndex: 0 }];
  return {
    reservationId: id, listingId: listing.listing_id_guesty, status: 'checked_out', checkIn: '2026-07-01', checkOut: '2026-07-02', nights: 1,
    platform: 'airbnb2', platformKey: 'airbnb2', source: 'airbnb2', sourceKey: 'airbnb2', fiscalCurrency: 'EUR',
    fiscalInvoiceItems: invoiceItems, financials: { totalGross: 113, currency: 'EUR', invoiceItems },
    stayEvidence: { reservationListingId: listing.listing_id_guesty, folioListingId: listing.listing_id_guesty, singleStayConfirmed: true },
  };
}

async function seedApprovedPolicy() {
  const base = {
    company_id: companyId, listing_id: listing.id, guesty_account_id: process.env.GUESTY_ACCOUNT_ID,
    platform_key: 'airbnb2', source_key: 'airbnb2', currency: 'EUR', version: 1, status: 'approved',
    recipient_model: 'private_guest', document_type: '11.2', series: 'APY', counterpart_json: null,
    vat_category: 2, classification_category: 'category1_3', classification_type: 'E3_561_003',
    gross_strategy: 'folio_items_sum', gross_strategy_config_json: '{}',
    line_rules_json: JSON.stringify([{ normalType: 'AF', action: 'include', allowBroad: true }]),
    tolerance_cents: 0, normalizer_version: 'guesty-v3', calculator_version: 'bridge-v1',
    valid_from: '2026-01-01', valid_to: '2026-12-31', blocked_reason: null, created_by: 'test',
  };
  const policyHash = channelPolicyHash(base);
  const [policyId] = await db('channel_policy_versions').insert({ ...base, policy_hash: policyHash });
  for (const [index, reservationId] of ['historical-a', 'historical-b', 'historical-c'].entries()) {
    const payloadSha = sha(String(index + 1));
    const [captureId] = await db('fiscal_evidence_captures').insert({
      company_id: companyId, listing_id: listing.id, reservation_id: reservationId,
      platform_key: 'airbnb2', source_key: 'airbnb2', guesty_account_id: process.env.GUESTY_ACCOUNT_ID, currency: 'EUR',
      normalized_payload_json: JSON.stringify({ reservationId, fixture: true }), payload_sha256: payloadSha,
      capture_method: 'welcome-vs-guesty-calibration', guesty_contract_version: 'reservations-v3',
    });
    await db('channel_policy_samples').insert({
      policy_id: policyId, evidence_capture_id: captureId, policy_hash: policyHash, evidence_sha256: payloadSha,
      scenario: 'normal', historical_document_type: '11.2', historical_mark: `4000000000000${index + 1}`,
      historical_primary_cents: 11300, historical_takk_cents: 1000, candidate_source_values_json: '{}',
      computed_primary_cents: 11300, delta_cents: 0, passed: true, stale: false,
    });
  }
  await db('policy_approvals').insert([
    { channel_policy_id: policyId, policy_hash: policyHash, approval_role: 'accounting', actor_id: 'accountant:test' },
    { channel_policy_id: policyId, policy_hash: policyHash, approval_role: 'technical', actor_id: 'engineer:test' },
  ]);
  await db('policy_decision_events').insert({
    channel_policy_id: policyId, policy_hash: policyHash, decision: 'approved', idempotency_key: 'fixture-channel-policy-decision', actor_id: 'policy-authority:test', reason: 'fixture approval',
  });
  return { policyId, policyHash };
}

async function seedApprovedTakkPolicy() {
  const base = {
    company_id: companyId, listing_id: listing.id, version: 1, status: 'approved', property_type: 'apartment',
    licensed_category: 'licensed-apartment', valid_from: '2026-01-01', valid_to: '2026-12-31',
    high_category: 24, low_category: 10, high_rate_cents: 800, low_rate_cents: 200,
    season_rules_json: JSON.stringify({ high: { from: '04-01', to: '10-31' } }), series: 'T-2026',
    calculator_version: 'takk-v1', blocked_reason: null, created_by: 'test',
  };
  const policyHash = takkPolicyHash(base);
  const [policyId] = await db('takk_policy_versions').insert({ ...base, policy_hash: policyHash });
  for (const [scenario, checkIn, checkOut, cents, seed] of [
    ['low', '2026-01-10', '2026-01-11', 200, '4'],
    ['high', '2026-07-10', '2026-07-11', 800, '5'],
    ['boundary', '2026-04-01', '2026-04-02', 800, '6'],
  ]) {
    await db('takk_calibration_samples').insert({
      policy_id: policyId, scenario, check_in: checkIn, check_out: checkOut,
      expected_cents: cents, computed_cents: cents, delta_cents: 0, passed: true, evidence_sha256: sha(seed),
    });
  }
  await db('policy_approvals').insert([
    { takk_policy_id: policyId, policy_hash: policyHash, approval_role: 'accounting', actor_id: 'accountant:test' },
    { takk_policy_id: policyId, policy_hash: policyHash, approval_role: 'technical', actor_id: 'engineer:test' },
  ]);
  await db('policy_decision_events').insert({
    takk_policy_id: policyId, policy_hash: policyHash, decision: 'approved', idempotency_key: 'fixture-takk-policy-decision', actor_id: 'policy-authority:test', reason: 'fixture approval',
  });
  return { policyId, policyHash };
}

test.before(async () => {
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
  await initSchema();
  [companyId] = await db('companies').insert({ company_name: 'Policy Materialization', vat_number: '109262634', invoice_series: 'A', active: true });
  const [listingId] = await db('listings').insert({
    company_id: companyId, listing_id_guesty: 'listing-policy-materialization', property_type: 'apartment', default_invoice_type: '2.1',
    invoice_counterpart_vat_number: 'IE9827384L', invoice_counterpart_country: 'IE', invoice_counterpart_name: 'Legacy OTA collector',
    climate_fee_high: 10, climate_fee_low: 1.5, climate_fee_high_category: 24, climate_fee_low_category: 10, climate_fee_series: 'TAKK', active: true,
  });
  listing = await db('listings').where({ id: listingId }).first();
});

test.after(async () => {
  await db.destroy();
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
});

test('enforced unified policy blocks no-policy issue and overrides cannot change recipient route', async () => {
  await stageReservation(reservation('res-no-policy'), { company_id: companyId, listing_id: listing.id, company_active: true, listing_active: true });
  const missing = await materializeDueReservations(companyId, '2026-07-02', { useGuestyRefresh: false, enforceUnifiedPolicy: true });
  assert.match(missing[0].error, /Expected exactly one approved unified policy/);
  assert.equal((await db('fiscal_documents').where({ reservation_id: 'res-no-policy' })).length, 0);

  await seedApprovedPolicy();
  await seedApprovedTakkPolicy();
  await stageReservation(reservation('res-locked-route'), { company_id: companyId, listing_id: listing.id, company_active: true, listing_active: true });
  await applyFiscalOverride('res-locked-route', {
    invoice_type: '2.1', series: 'BYPASS', counterpart_vat_number: 'IE9827384L', counterpart_country: 'IE', counterpart_name: 'Payment collector',
  });
  const completed = await materializeDueReservations(companyId, '2026-07-02', { useGuestyRefresh: false, enforceUnifiedPolicy: true });
  assert.equal(completed.find((item) => item.reservationId === 'res-locked-route').skipped, false);
  const primary = await db('fiscal_documents').where({ reservation_id: 'res-locked-route', document_type: '11.2' }).first();
  assert.equal(primary.series, 'APY');
  assert.equal(primary.gross_value, 113);
  assert.doesNotMatch(primary.xml_payload, /<counterpart>/);
  const frozen = JSON.parse(primary.source_payload);
  assert.equal(frozen.billingSnapshot.unified_channel_policy.policy_hash.length, 64);
  assert.equal(frozen.billingSnapshot.unified_channel_policy.vat_category, 2);
  assert.equal(frozen.billingSnapshot.unified_channel_policy.classification_type, 'E3_561_003');
  const takk = await db('fiscal_documents').where({ reservation_id: 'res-locked-route', document_type: '8.2' }).first();
  assert.equal(takk.series, 'T-2026');
  assert.equal(takk.gross_value, 8);
  assert.match(takk.xml_payload, /<otherTaxesPercentCategory>24<\/otherTaxesPercentCategory>/);
  assert.equal(JSON.parse(takk.source_payload).climateSnapshot.unified_takk_policy.fee_lines[0].cents, 800);
  const matrix = await getPolicyMatrix({ asOf: '2026-07-02' });
  const channel = matrix.channels.find((row) => row.platform_key === 'airbnb2' && row.source_key === 'airbnb2');
  const takkRow = matrix.takk.find((row) => Number(row.id) === Number(listing.id));
  assert.equal(channel.status, 'ready');
  assert.equal(channel.calibration.samples, 3);
  assert.equal(takkRow.status, 'ready');
  assert.deepEqual(takkRow.calibration.scenarios.sort(), ['boundary', 'high', 'low']);
  const expired = await getPolicyMatrix({ asOf: '2027-01-01' });
  assert.equal(expired.channels.find((row) => row.platform_key === 'airbnb2').status, 'hold');
  assert.equal(expired.takk.find((row) => Number(row.id) === Number(listing.id)).status, 'hold');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const databasePath = `/tmp/guesty-mydata-policy-authoring-${process.pid}.db`;
process.env.DB_CLIENT = 'better-sqlite3';
process.env.DB_PATH = databasePath;
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 37).toString('base64');
process.env.GUESTY_ACCOUNT_ID = 'policy-authoring-account';

const { db, initSchema } = require('../src/database');
const {
  createChannelPolicyDraft, createTakkPolicyDraft, captureChannelCalibration, captureTakkCalibration, recordApproval, recordDecision,
} = require('../src/services/policy-authoring-service');
const { stageReservation } = require('../src/services/reservation-service');

let companyId;
let listingId;

function sha(seed) { return seed.repeat(64).slice(0, 64); }

async function addExactChannelSamples(policy) {
  for (const [index, reservationId] of ['guest-1', 'guest-2', 'guest-3'].entries()) {
    await stageReservation(calibrationReservation(reservationId, '2026-07-01', '2026-07-02', 1), { company_id: companyId, listing_id: listingId, company_active: true, listing_active: true });
    const result = await captureChannelCalibration('channel', policy.id, {
      reservation_id: reservationId, historical_document_type: policy.document_type, historical_series: policy.series,
      historical_mark: `4000000000000${index + 1}`, historical_pdf_sha256: sha(String(index + 1)),
      historical_primary_cents: 11300, historical_takk_cents: 200, scenario: 'normal', accountant_reference: 'Welcome final',
    }, 'administrator:1');
    assert.equal(Boolean(result.sample.passed), true);
  }
}

function calibrationReservation(reservationId, checkIn, checkOut, nights) {
  const invoiceItems = [{ id: `${reservationId}-af`, normalType: 'AF', title: 'Accommodation', totalPrice: 113, listingId: 'authoring-listing', stayIndex: 0 }];
  return {
    reservationId, listingId: 'authoring-listing', status: 'checked_out', checkIn, checkOut, nights,
    platform: 'airbnb2', platformKey: 'airbnb2', source: 'direct api', sourceKey: 'direct api', fiscalCurrency: 'EUR',
    fiscalInvoiceItems: invoiceItems, financials: { totalGross: 113, currency: 'EUR', invoiceItems },
    stayEvidence: { reservationListingId: 'authoring-listing', folioListingId: 'authoring-listing', singleStayConfirmed: true },
  };
}

test.before(async () => {
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
  await initSchema();
  [companyId] = await db('companies').insert({ company_name: 'Authoring Test', vat_number: '109262634', invoice_series: 'A', active: true });
  [listingId] = await db('listings').insert({
    company_id: companyId, listing_id_guesty: 'authoring-listing', property_type: 'apartment', default_invoice_type: '11.2',
    climate_fee_high: 8, climate_fee_low: 2, climate_fee_high_category: 24, climate_fee_low_category: 10, climate_fee_series: 'TAKK', active: true,
  });
});

test.after(async () => {
  await db.destroy();
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
});

test('draft authoring makes a versioned immutable policy and requires exact evidence plus separate approvals', async () => {
  const policy = await createChannelPolicyDraft({
    company_id: companyId, listing_id: listingId, platform_key: 'Airbnb2', source_key: 'Direct API',
    recipient_model: 'approved_business_counterpart', series: 'TPY', valid_from: '2026-01-01', valid_to: '2026-12-31',
    counterpart: { vatNumber: 'IE9827384L', country: 'IE', name: 'Airbnb Ireland UC', branch: 0 },
    line_rules: [{ normalType: 'AF', action: 'include', allowBroad: true }],
  }, 'administrator:1');
  assert.equal(policy.version, 1);
  assert.equal(policy.status, 'draft');
  assert.equal(policy.document_type, '2.1');
  assert.equal(policy.classification_type, 'E3_561_007');
  assert.equal(policy.platform_key, 'airbnb2');
  assert.equal(policy.source_key, 'direct api');
  assert.equal(policy.policy_hash.length, 64);

  await recordApproval('channel', policy.id, 'accounting', 'Checked source documents', 'accountant:1');
  await recordApproval('channel', policy.id, 'technical', 'Checked Guesty line rules', 'engineer:1');
  await assert.rejects(
    () => recordDecision('channel', policy.id, { decision: 'approved', reason: 'too early' }, 'administrator:1', 'policy-early'),
    /3 distinct finalized samples/,
  );

  await addExactChannelSamples(policy);
  const decision = await recordDecision('channel', policy.id, { decision: 'approved', reason: 'Calibrated with finalized Welcome/myDATA examples' }, 'administrator:1', 'policy-approve-1');
  assert.equal(decision.decision, 'approved');
  const replay = await recordDecision('channel', policy.id, { decision: 'approved', reason: 'ignored on replay' }, 'administrator:1', 'policy-approve-1');
  assert.equal(replay.idempotent, true);
  await assert.rejects(() => recordApproval('channel', policy.id, 'technical', 'late change', 'engineer:2'), /decided policy/);
});

test('TAKK policy drafts derive the licensed property category only from the mapped listing', async () => {
  const policy = await createTakkPolicyDraft({
    company_id: companyId, listing_id: listingId, licensed_category: 'Ενοικιαζόμενα δωμάτια', valid_from: '2026-01-01', valid_to: '2026-12-31',
    high_rate_cents: 800, low_rate_cents: 200, season_rules: { high: { from: '04-01', to: '10-31' } }, series: 'TAKK',
  }, 'administrator:1');
  assert.equal(policy.property_type, 'apartment');
  assert.equal(policy.high_category, 24);
  assert.equal(policy.low_category, 10);
  assert.equal(policy.status, 'draft');
  for (const [scenario, reservationId, checkIn, checkOut, expected, mark, seed] of [
    ['low', 'takk-low', '2026-01-10', '2026-01-11', 200, '4000000000011', '4'],
    ['high', 'takk-high', '2026-07-10', '2026-07-11', 800, '4000000000012', '5'],
    ['boundary', 'takk-boundary', '2026-04-01', '2026-04-02', 800, '4000000000013', '6'],
  ]) {
    await stageReservation(calibrationReservation(reservationId, checkIn, checkOut, 1), { company_id: companyId, listing_id: listingId, company_active: true, listing_active: true });
    const sample = await captureTakkCalibration(policy.id, {
      reservation_id: reservationId, historical_document_type: '8.2', historical_series: 'TAKK',
      historical_mark: mark, historical_pdf_sha256: sha(seed),
      historical_takk_cents: expected, scenario, accountant_reference: 'Welcome TAKK final',
    }, 'administrator:1');
    assert.equal(Boolean(sample.passed), true);
  }
  await recordApproval('takk', policy.id, 'accounting', 'Checked TAKK source examples', 'accountant:1');
  await recordApproval('takk', policy.id, 'technical', 'Checked nightly calculation', 'engineer:1');
  assert.equal((await recordDecision('takk', policy.id, { decision: 'approved', reason: 'All three season scenarios agree' }, 'administrator:1', 'takk-approve-1')).decision, 'approved');
  await assert.rejects(() => createTakkPolicyDraft({
    company_id: companyId, listing_id: listingId, licensed_category: 'bad', valid_from: '2026-01-01',
    high_rate_cents: 1, low_rate_cents: 1, season_rules: { high: { from: '13-01', to: '10-31' } }, series: 'TAKK',
  }, 'administrator:1'), /valid MM-DD/);
});

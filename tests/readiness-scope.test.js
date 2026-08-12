'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const originalEnv = { ...process.env };
const databasePath = `/tmp/guesty-mydata-readiness-scope-${process.pid}.db`;
process.env.DB_CLIENT = 'better-sqlite3';
process.env.DB_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString('base64');
process.env.GUESTY_CLIENT_ID = 'scope-client';
process.env.GUESTY_CLIENT_SECRET = 'scope-secret';
process.env.GUESTY_WEBHOOK_SECRET = 'scope-webhook-secret';
process.env.GUESTY_ACCOUNT_ID = 'scope-account';
process.env.MYDATA_ENV = 'production';
process.env.MYDATA_PRODUCTION_ENABLED = 'true';
process.env.DAILY_CLOSE_ENABLED = 'true';

const { db, initSchema } = require('../src/database');
const { encryptSecret, companySecretContext, companyCredentialBinding } = require('../src/security/credentials');
const { recordIntegrationCheck } = require('../src/repositories/integration-checks');
const { getReadiness } = require('../src/services/readiness-service');
const { assertProductionTransmissionEnabled } = require('../src/security/production-guard');
const { ACCEPTANCE_CONTRACT_VERSION, CAPABILITIES } = require('../src/services/sandbox-acceptance-service');
const { takkPolicyHash } = require('../src/services/takk-policy-service');

function companyCredentials(vatNumber, user, key) {
  const company = { vat_number: vatNumber };
  return {
    aade_user_id: encryptSecret(user, companySecretContext(company, 'aade_user_id')),
    aade_subscription_key: encryptSecret(key, companySecretContext(company, 'aade_subscription_key')),
  };
}

async function insertReadyAcceptance(company, listing) {
  const [documentId] = await db('fiscal_documents').insert({
    document_key: `readiness-evidence-${company.id}`,
    company_id: company.id,
    listing_id: listing.id,
    reservation_id: `readiness-evidence-${company.id}`,
    document_kind: 'climate_fee_receipt',
    document_type: '8.2',
    series: `R-${company.id}`,
    aa: 1,
    issue_date: '2026-07-31',
    status: 'sent',
    xml_payload: '<InvoicesDoc/>',
    source_payload: '{}',
    mydata_mark: `40000000000${company.id}`,
    verification_status: 'verified',
    mydata_environment: 'sandbox',
    target_environment: 'sandbox',
  });
  const [runId] = await db('sandbox_acceptance_runs').insert({
    company_id: company.id,
    issuer_vat: company.vat_number,
    credential_binding_sha256: companyCredentialBinding(company),
    contract_version: ACCEPTANCE_CONTRACT_VERSION,
    approved_by: 'Readiness Scope Test',
  });
  for (const capability of [CAPABILITIES.STAY_APY, CAPABILITIES.CREDIT_APY, CAPABILITIES.CANCEL]) {
    await db('sandbox_acceptance_artifacts').insert({
      run_id: runId,
      capability,
      document_id: documentId,
      document_type: '8.2',
      reservation_id: `readiness-evidence-${company.id}`,
      invoice_mark: `40000000000${company.id}`,
      evidence_json: '{}',
    });
  }
}

async function insertReadyTakkPolicy(company, listing) {
  const base = {
    company_id: company.id, listing_id: listing.id, version: 1, status: 'approved', property_type: 'apartment',
    licensed_category: 'readiness-test', valid_from: '2020-01-01', valid_to: '2099-12-31',
    high_category: 24, low_category: 10, high_rate_cents: 800, low_rate_cents: 200,
    season_rules_json: JSON.stringify({ high: { from: '04-01', to: '10-31' } }), series: 'READY-TAKK',
    calculator_version: 'takk-v1', created_by: 'readiness-test',
  };
  const [policyId] = await db('takk_policy_versions').insert({ ...base, policy_hash: takkPolicyHash(base) });
  for (const [scenario, checkIn, checkOut, cents, hash] of [
    ['low', '2026-01-01', '2026-01-02', 200, 'a'], ['high', '2026-07-01', '2026-07-02', 800, 'b'], ['boundary', '2026-04-01', '2026-04-02', 800, 'c'],
  ]) await db('takk_calibration_samples').insert({ policy_id: policyId, scenario, check_in: checkIn, check_out: checkOut, expected_cents: cents, computed_cents: cents, delta_cents: 0, passed: true, evidence_sha256: hash.repeat(64) });
  const policy = await db('takk_policy_versions').where({ id: policyId }).first();
  await db('policy_approvals').insert([
    { takk_policy_id: policyId, policy_hash: policy.policy_hash, approval_role: 'accounting', actor_id: 'accountant:test' },
    { takk_policy_id: policyId, policy_hash: policy.policy_hash, approval_role: 'technical', actor_id: 'engineer:test' },
  ]);
}

test.before(async () => {
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
  await initSchema();
});

test.after(async () => {
  await db.destroy();
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

test('SQLite readiness and production submission guard isolate one broken company', async () => {
  await assert.rejects(getReadiness({ companyId: '' }), /companyId must be a positive integer/);
  const readyVat = '109262634';
  const [readyCompanyId] = await db('companies').insert({
    company_name: 'Ready Tenant',
    vat_number: readyVat,
    ...companyCredentials(readyVat, 'ready-user', 'ready-key'),
    aade_credential_status: 'verified',
    aade_credentials_verified_at: new Date().toISOString(),
    invoice_series: 'READY',
    pdf_address: 'Θήρα 84700',
    pdf_tax_office: 'Θήρας',
    active: true,
  });
  const readyCompany = await db('companies').where({ id: readyCompanyId }).first();
  const [readyListingId] = await db('listings').insert({
    company_id: readyCompany.id,
    listing_id_guesty: 'ready-listing',
    property_type: 'apartment',
    default_invoice_type: '11.2',
    climate_fee_high: 8,
    climate_fee_low: 2,
    climate_fee_high_category: 24,
    climate_fee_low_category: 10,
    climate_fee_series: 'READY-TAKK',
    payment_method_type: 1,
    active: true,
  });
  const readyListing = await db('listings').where({ id: readyListingId }).first();

  const [brokenCompanyId] = await db('companies').insert({
    company_name: 'Broken Tenant',
    vat_number: '044800455',
    aade_user_id: 'plaintext-user',
    aade_subscription_key: 'plaintext-key',
    aade_credential_status: 'configured',
    invoice_series: '',
    active: true,
  });
  await db('listings').insert({
    company_id: brokenCompanyId,
    listing_id_guesty: 'broken-listing',
    property_type: 'apartment',
    default_invoice_type: '11.2',
    climate_fee_high: 0,
    climate_fee_low: 0,
    climate_fee_high_category: 24,
    climate_fee_low_category: 10,
    climate_fee_series: 'BROKEN-TAKK',
    payment_method_type: 1,
    active: true,
  });

  await insertReadyAcceptance(readyCompany, readyListing);
  await insertReadyTakkPolicy(readyCompany, readyListing);
  await recordIntegrationCheck('guesty', 'success', 'guesty');
  await recordIntegrationCheck(`mydata:${readyCompany.id}:sandbox`, 'success', 'sandbox');
  await recordIntegrationCheck(`mydata:${readyCompany.id}:production`, 'success', 'production');

  // The readiness invariant inspects the configured deployment database. The
  // fixture itself remains SQLite, while this makes the gate exercise every
  // other production invariant and its real tenant-scoped queries.
  process.env.DB_CLIENT = 'pg';
  const ready = await getReadiness({ companyId: readyCompany.id });
  const broken = await getReadiness({ companyId: brokenCompanyId });
  const aggregate = await getReadiness();

  assert.equal(ready.productionReady, true);
  assert.equal(ready.counts.companies, 1);
  assert.equal(ready.counts.listings, 1);
  assert(ready.checks.every((check) => check.key === 'guesty' || check.key.startsWith(`mydata:${readyCompany.id}:`)));
  assert.equal(broken.productionReady, false);
  assert(broken.productionIssues.some((item) => item.scope === `company:${brokenCompanyId}`));
  assert.equal(aggregate.productionReady, false);
  assert.equal(aggregate.counts.companies, 2);

  await assert.doesNotReject(assertProductionTransmissionEnabled('submissions', readyCompany.id));
  await assert.rejects(assertProductionTransmissionEnabled('submissions', brokenCompanyId), /Production myDATA preflight failed/);
});

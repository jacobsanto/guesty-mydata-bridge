'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

if (process.env.POSTGRES_INTEGRATION_TEST !== 'true') {
  test('PostgreSQL integration suite requires POSTGRES_INTEGRATION_TEST=true', { skip: true }, () => {});
} else {
  process.env.DB_CLIENT = 'pg';
  process.env.DB_POOL_MIN = process.env.DB_POOL_MIN || '0';
  process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '20';
  process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString('base64');

  const execFileAsync = promisify(execFile);
  const projectRoot = path.resolve(__dirname, '..');
  const { db, initSchema } = require('../src/database');
  const {
    createDocumentOnce, claimDocument, markDocumentSent, markDocumentCancelled,
    resolveDefinitiveCancellationFailure, listCancellationResolutionEvents, quarantineStaleCancellations,
  } = require('../src/repositories/fiscal-documents');
  const { upsertReservationSnapshot, reopenSnapshotForReissue } = require('../src/repositories/reservation-snapshots');
  const { prepareReservationDocuments } = require('../src/services/document-service');
  const { executeDailyClose } = require('../src/services/daily-close-service');
  const { stageReservation, materializeDueReservations } = require('../src/services/reservation-service');
  const { runGuestyReconciliation, retryGuestyUnresolvedReservations } = require('../src/services/guesty-reconciliation-service');
  const { beginRun, heartbeatRun, recordRunItem, recordVerificationResult, finishRun } = require('../src/repositories/daily-close');
  const { getFiscalPdfArtifact, insertFiscalPdfArtifactOnce } = require('../src/repositories/fiscal-pdf-artifacts');
  const { recordIntegrationCheck } = require('../src/repositories/integration-checks');
  const {
    assertApprovedFinancialProfileBinding, profileConfigHash, suspendFinancialProfile,
  } = require('../src/repositories/financial-profiles');
  const { getReadiness } = require('../src/services/readiness-service');
  const { assertProductionTransmissionEnabled } = require('../src/security/production-guard');
  const {
    encryptSecret, companySecretContext, companyCredentialBinding,
  } = require('../src/security/credentials');
  const {
    ACCEPTANCE_CONTRACT_VERSION, CAPABILITIES,
  } = require('../src/services/sandbox-acceptance-service');
  const { takkPolicyHash } = require('../src/services/takk-policy-service');

  let company;
  let listing;

  async function runMigrationProcess() {
    return execFileAsync(process.execPath, ['migrations/run.js'], {
      cwd: projectRoot,
      env: process.env,
      timeout: 30000,
    });
  }

  async function insertFiscalDocument({
    key, reservationId = key, type = '11.2', series, aa, kind = 'service_receipt', retryable = true,
    companyId = company.id, listingId = listing.id,
  }) {
    await db('fiscal_documents').insert({
      document_key: key,
      company_id: companyId,
      listing_id: listingId,
      reservation_id: reservationId,
      document_kind: kind,
      document_type: type,
      series,
      aa,
      issue_date: '2026-07-31',
      net_value: 100,
      vat_amount: 13,
      other_taxes_amount: 0,
      gross_value: 113,
      status: 'pending',
      target_environment: 'sandbox',
      retryable,
      xml_payload: `<invoice aa="${aa}"/>`,
      source_payload: '{}',
    });
    return db('fiscal_documents').where({ document_key: key }).first();
  }

  function pdfArtifact(document, mark, suffix = '') {
    return {
      documentId: document.id,
      companyId: document.company_id,
      mark,
      uid: `UID-${mark}`,
      pdfBytes: Buffer.from(`%PDF-1.4\n${mark}:${suffix}\n%%EOF`),
      renderSnapshot: { documentType: document.document_type, series: document.series, number: document.aa, mark },
      renderVersion: 'test-v1',
    };
  }

  async function insertReadyTakkPolicy(companyRow, listingRow) {
    const base = {
      company_id: companyRow.id, listing_id: listingRow.id, version: 1, status: 'approved', property_type: 'apartment',
      licensed_category: 'postgres-test', valid_from: '2020-01-01', valid_to: '2099-12-31',
      high_category: 24, low_category: 10, high_rate_cents: 800, low_rate_cents: 200,
      season_rules_json: JSON.stringify({ high: { from: '04-01', to: '10-31' } }), series: 'PG-READY-TAKK',
      calculator_version: 'takk-v1', created_by: 'postgres-test',
    };
    const [policy] = await db('takk_policy_versions').insert({ ...base, policy_hash: takkPolicyHash(base) }).returning('*');
    await db('takk_calibration_samples').insert([
      { policy_id: policy.id, scenario: 'low', check_in: '2026-01-01', check_out: '2026-01-02', expected_cents: 200, computed_cents: 200, delta_cents: 0, passed: true, evidence_sha256: 'a'.repeat(64) },
      { policy_id: policy.id, scenario: 'high', check_in: '2026-07-01', check_out: '2026-07-02', expected_cents: 800, computed_cents: 800, delta_cents: 0, passed: true, evidence_sha256: 'b'.repeat(64) },
      { policy_id: policy.id, scenario: 'boundary', check_in: '2026-04-01', check_out: '2026-04-02', expected_cents: 800, computed_cents: 800, delta_cents: 0, passed: true, evidence_sha256: 'c'.repeat(64) },
    ]);
    await db('policy_approvals').insert([
      { takk_policy_id: policy.id, policy_hash: policy.policy_hash, approval_role: 'accounting', actor_id: 'accountant:test' },
      { takk_policy_id: policy.id, policy_hash: policy.policy_hash, approval_role: 'technical', actor_id: 'engineer:test' },
    ]);
  }

  test.before(async () => {
    const current = await db.raw('SELECT current_database() AS name');
    assert.equal(current.rows[0].name, 'guesty_mydata_test', 'destructive setup is restricted to the dedicated CI test database');
    await db.raw('DROP SCHEMA public CASCADE');
    await db.raw('CREATE SCHEMA public');

    // Two independent processes must serialize the first production migration
    // through the PostgreSQL advisory lock.
    await Promise.all([runMigrationProcess(), runMigrationProcess()]);
    await initSchema();

    const primaryIdentity = { vat_number: '044800455' };
    [company] = await db('companies').insert({
      company_name: 'PostgreSQL Integration Test',
      vat_number: primaryIdentity.vat_number,
      aade_user_id: encryptSecret('pg-test-user', companySecretContext(primaryIdentity, 'aade_user_id')),
      aade_subscription_key: encryptSecret('pg-test-key', companySecretContext(primaryIdentity, 'aade_subscription_key')),
      aade_credential_status: 'verified',
      aade_credentials_verified_at: new Date().toISOString(),
      invoice_series: 'PG-APY',
      active: true,
    }).returning('*');
    [listing] = await db('listings').insert({
      company_id: company.id,
      listing_id_guesty: 'pg-listing-1',
      property_type: 'apartment',
      default_invoice_type: '11.2',
      climate_fee_high: 10,
      climate_fee_low: 1.5,
      climate_fee_high_category: 24,
      climate_fee_low_category: 10,
      climate_fee_series: 'PG-TAKK',
      payment_method_type: 1,
      active: true,
    }).returning('*');
  });

  test.after(async () => {
    await db.destroy();
  });

  test('concurrent migrations create the required production unique indexes', async () => {
    const indexes = await db('pg_indexes').where({ schemaname: 'public' }).pluck('indexname');
    for (const expected of [
      'fiscal_documents_company_type_series_aa_uq',
      'document_sequences_company_type_series_uq',
      'daily_close_runs_company_date_uq',
    ]) assert(indexes.includes(expected), `${expected} exists`);
  });

  test('PostgreSQL readiness and production submission guard isolate one broken company', async () => {
    const savedEnv = { ...process.env };
    try {
      Object.assign(process.env, {
        NODE_ENV: 'test',
        GUESTY_CLIENT_ID: 'pg-scope-client',
        GUESTY_CLIENT_SECRET: 'pg-scope-secret',
        GUESTY_WEBHOOK_SECRET: 'pg-scope-webhook',
        GUESTY_ACCOUNT_ID: 'pg-scope-account',
        MYDATA_ENV: 'production',
        MYDATA_PRODUCTION_ENABLED: 'true',
        DAILY_CLOSE_ENABLED: 'true',
      });
      const readyVat = '109262634';
      const readyIdentity = { vat_number: readyVat };
      const [readyCompany] = await db('companies').insert({
        company_name: 'PostgreSQL Ready Tenant',
        vat_number: readyVat,
        aade_user_id: encryptSecret('pg-ready-user', companySecretContext(readyIdentity, 'aade_user_id')),
        aade_subscription_key: encryptSecret('pg-ready-key', companySecretContext(readyIdentity, 'aade_subscription_key')),
        aade_credential_status: 'verified',
        aade_credentials_verified_at: new Date().toISOString(),
        invoice_series: 'PG-READY',
        pdf_address: 'Θήρα 84700',
        pdf_tax_office: 'Θήρας',
        active: true,
      }).returning('*');
      const [readyListing] = await db('listings').insert({
        company_id: readyCompany.id,
        listing_id_guesty: 'pg-ready-listing',
        property_type: 'apartment',
        default_invoice_type: '11.2',
        climate_fee_high: 8,
        climate_fee_low: 2,
        climate_fee_high_category: 24,
        climate_fee_low_category: 10,
        climate_fee_series: 'PG-READY-TAKK',
        payment_method_type: 1,
        active: true,
      }).returning('*');
      const [brokenCompany] = await db('companies').insert({
        company_name: 'PostgreSQL Broken Tenant',
        vat_number: '094524053',
        aade_user_id: 'plaintext-user',
        aade_subscription_key: 'plaintext-key',
        aade_credential_status: 'configured',
        invoice_series: '',
        active: true,
      }).returning('*');
      await db('listings').insert({
        company_id: brokenCompany.id,
        listing_id_guesty: 'pg-broken-listing',
        property_type: 'apartment',
        default_invoice_type: '11.2',
        climate_fee_high: 0,
        climate_fee_low: 0,
        climate_fee_high_category: 24,
        climate_fee_low_category: 10,
        climate_fee_series: 'PG-BROKEN-TAKK',
        payment_method_type: 1,
        active: true,
      });

      await insertReadyTakkPolicy(readyCompany, readyListing);
      const [evidence] = await db('fiscal_documents').insert({
        document_key: `pg-readiness-evidence-${readyCompany.id}`,
        company_id: readyCompany.id,
        listing_id: readyListing.id,
        reservation_id: `pg-readiness-evidence-${readyCompany.id}`,
        document_kind: 'climate_fee_receipt',
        document_type: '8.2',
        series: `PG-R-${readyCompany.id}`,
        aa: 1,
        issue_date: '2026-07-31',
        status: 'sent',
        xml_payload: '<InvoicesDoc/>',
        source_payload: '{}',
        mydata_mark: `40000000000${readyCompany.id}`,
        verification_status: 'verified',
        mydata_environment: 'sandbox',
        target_environment: 'sandbox',
      }).returning('*');
      const [acceptanceRun] = await db('sandbox_acceptance_runs').insert({
        company_id: readyCompany.id,
        issuer_vat: readyCompany.vat_number,
        credential_binding_sha256: companyCredentialBinding(readyCompany),
        contract_version: ACCEPTANCE_CONTRACT_VERSION,
        approved_by: 'PostgreSQL Readiness Scope Test',
      }).returning('*');
      await db('sandbox_acceptance_artifacts').insert([
        CAPABILITIES.STAY_APY, CAPABILITIES.CREDIT_APY, CAPABILITIES.CANCEL,
      ].map((capability) => ({
        run_id: acceptanceRun.id,
        capability,
        document_id: evidence.id,
        document_type: '8.2',
        reservation_id: evidence.reservation_id,
        invoice_mark: evidence.mydata_mark,
        evidence_json: '{}',
      })));
      await recordIntegrationCheck('guesty', 'success', 'guesty');
      await recordIntegrationCheck(`mydata:${readyCompany.id}:sandbox`, 'success', 'sandbox');
      await recordIntegrationCheck(`mydata:${readyCompany.id}:production`, 'success', 'production');

      const ready = await getReadiness({ companyId: readyCompany.id });
      const broken = await getReadiness({ companyId: brokenCompany.id });
      assert.equal(ready.productionReady, true);
      assert.equal(ready.counts.companies, 1);
      assert.equal(ready.counts.listings, 1);
      assert(ready.checks.every((check) => check.key === 'guesty' || check.key.startsWith(`mydata:${readyCompany.id}:`)));
      assert.equal(broken.productionReady, false);
      assert(broken.productionIssues.some((item) => item.scope === `company:${brokenCompany.id}`));
      await assert.doesNotReject(assertProductionTransmissionEnabled('submissions', readyCompany.id));
      await assert.rejects(assertProductionTransmissionEnabled('submissions', brokenCompany.id), /Production myDATA preflight failed/);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });

  test('concurrent PostgreSQL AA allocation is unique, gap-free and monotonic', async () => {
    const count = 24;
    const created = await Promise.all(Array.from({ length: count }, (_, index) => createDocumentOnce({
      documentKey: `pg-concurrent-${index}`,
      companyId: company.id,
      listingId: listing.id,
      reservationId: `pg-concurrent-${index}`,
      documentKind: 'service_receipt',
      documentType: '11.2',
      series: 'PG-CONCURRENT',
      issueDate: '2026-07-31',
      amounts: { netValue: 100, vatAmount: 13, otherTaxesAmount: 0, grossValue: 113 },
      sourcePayload: {},
      buildXml: (aa) => `<invoice aa="${aa}"/>`,
    })));
    assert.deepEqual(created.map((row) => Number(row.document.aa)).sort((a, b) => a - b), Array.from({ length: count }, (_, index) => index + 1));
    const sequence = await db('document_sequences').where({
      company_id: company.id, document_type: '11.2', series: 'PG-CONCURRENT',
    }).first();
    assert.equal(Number(sequence.last_number), count);
  });

  test('migration reconciles an absent or lagging sequence from already issued documents', async () => {
    await insertFiscalDocument({ key: 'pg-legacy-aa-41', series: 'PG-LEGACY', aa: 41 });
    await db('document_sequences').where({
      company_id: company.id, document_type: '11.2', series: 'PG-LEGACY',
    }).delete();
    await initSchema();
    const reconciled = await db('document_sequences').where({
      company_id: company.id, document_type: '11.2', series: 'PG-LEGACY',
    }).first();
    assert.equal(Number(reconciled.last_number), 41);
    const next = await createDocumentOnce({
      documentKey: 'pg-legacy-next',
      companyId: company.id,
      listingId: listing.id,
      reservationId: 'pg-legacy-next',
      documentKind: 'service_receipt',
      documentType: '11.2',
      series: 'PG-LEGACY',
      issueDate: '2026-07-31',
      amounts: { netValue: 100, vatAmount: 13, otherTaxesAmount: 0, grossValue: 113 },
      sourcePayload: {},
      buildXml: (aa) => `<invoice aa="${aa}"/>`,
    });
    assert.equal(Number(next.document.aa), 42);
  });

  function reservation(reservationId) {
    return {
      reservationId,
      listingId: listing.listing_id_guesty,
      status: 'checked_out',
      platformKey: 'direct',
      sourceKey: 'direct',
      checkIn: '2026-07-30',
      checkOut: '2026-07-31',
      nights: 1,
      financials: { totalGross: 113 },
      financialProfile: { status: 'matched', id: 1, version: 1, configHash: 'a'.repeat(64) },
    };
  }

  function billingContext(overrides = {}) {
    return {
      company_id: company.id,
      listing_id: listing.id,
      vat_number: company.vat_number,
      property_type: 'apartment',
      default_invoice_type: '11.2',
      invoice_series: 'PG-ATOMIC',
      climate_fee_high: 10,
      climate_fee_low: 1.5,
      climate_fee_high_category: 24,
      climate_fee_low_category: 10,
      climate_fee_series: 'PG-ATOMIC-TAKK',
      payment_method_type: 1,
      ...overrides,
    };
  }

  test('snapshot generation CAS prevents stale Guesty data from resurrecting a cancellation', async () => {
    const currentReservation = reservation('pg-snapshot-cas');
    const staged = await upsertReservationSnapshot(currentReservation, billingContext());
    const cancelled = await upsertReservationSnapshot({ ...currentReservation, status: 'cancelled' }, billingContext());
    assert(Number(cancelled.generation) > Number(staged.generation));
    await assert.rejects(
      db.transaction(async (trx) => {
        await upsertReservationSnapshot(currentReservation, billingContext(), {
          transaction: trx,
          expectedGeneration: staged.generation,
        });
        await prepareReservationDocuments(currentReservation, billingContext(), { transaction: trx });
      }),
      (error) => error.code === 'RESERVATION_SNAPSHOT_CHANGED',
    );
    const finalSnapshot = await db('reservation_snapshots').where({ reservation_id: currentReservation.reservationId }).first();
    assert.equal(finalSnapshot.status, 'cancelled');
    assert.equal(Number((await db('fiscal_documents').where({ reservation_id: currentReservation.reservationId }).count({ count: '*' }).first()).count), 0);
  });

  test('core-only Guesty cancellation backfill locally cancels unsent docs, quarantines sent docs, and persists its watermark', async () => {
    const reservationId = 'pg-core-cancellation';
    await stageReservation(reservation(reservationId), billingContext());
    await db('reservation_snapshots').where({ reservation_id: reservationId }).update({ materialized_at: db.fn.now() });
    const sent = await insertFiscalDocument({
      key: 'pg-core-cancellation-sent', reservationId, series: 'PG-CORE-CANCEL', aa: 1,
    });
    const pending = await insertFiscalDocument({
      key: 'pg-core-cancellation-pending', reservationId, series: 'PG-CORE-CANCEL', aa: 2,
    });
    await db('fiscal_documents').where({ id: sent.id }).update({
      status: 'sent', mydata_mark: '400000000007001', verification_status: 'verified',
    });
    const to = '2026-08-01T00:00:00.000Z';
    const result = await runGuestyReconciliation({
      from: '2026-07-31T00:00:00.000Z', to,
      searcher: async () => [reservationId],
      fetcher: async () => ({
        _id: reservationId,
        listingId: listing.listing_id_guesty,
        status: 'cancelled',
        checkInDateLocalized: '2026-07-30',
        checkOutDateLocalized: '2026-07-31',
        authoritativeCancellation: true,
      }),
    });
    assert.equal(result.watermark, to);
    assert.equal((await db('fiscal_documents').where({ id: pending.id }).first()).status, 'cancelled');
    assert.equal((await db('fiscal_documents').where({ id: sent.id }).first()).status, 'sent');
    const snapshot = await db('reservation_snapshots').where({ reservation_id: reservationId }).first();
    assert.equal(snapshot.status, 'cancelled');
    assert.equal(Boolean(snapshot.requires_review), true);
    assert.match(snapshot.last_error, /quarantined/);
    const successEvidence = await db('integration_checks').where({ check_key: 'guesty:reservation_reconciliation' }).first();
    assert.equal(successEvidence.status, 'success');
    assert.equal(JSON.parse(successEvidence.message).successfulWatermark, to);

    await assert.rejects(
      runGuestyReconciliation({
        from: to, to: '2026-08-02T00:00:00.000Z',
        searcher: async () => { throw new Error('PG Guesty outage'); },
      }),
      /PG Guesty outage/,
    );
    const failedEvidence = await db('integration_checks').where({ check_key: 'guesty:reservation_reconciliation' }).first();
    assert.equal(failedEvidence.status, 'failed');
    assert.equal(JSON.parse(failedEvidence.message).priorSuccessfulWatermark, to);
    assert.equal((await db('sync_cursors').where({ provider: 'guesty', cursor_key: 'reservations_last_updated' }).first()).cursor_value, to);
  });

  test('inactive Guesty rows survive cursor advancement and resolve idempotently after activation', async () => {
    const reservationId = 'pg-inactive-reconciliation-inbox';
    const payload = {
      _id: reservationId,
      listingId: listing.listing_id_guesty,
      status: 'cancelled',
      checkInDateLocalized: '2026-08-01',
      checkOutDateLocalized: '2026-08-02',
      authoritativeCancellation: true,
    };
    await db('listings').where({ id: listing.id }).update({ active: false });
    try {
      const unresolved = await runGuestyReconciliation({
        from: '2026-08-02T00:00:00.000Z', to: '2026-08-03T00:00:00.000Z',
        searcher: async () => [reservationId],
        fetcher: async () => payload,
      });
      const inbox = await db('guesty_reconciliation_inbox').where({ reservation_id: reservationId }).first();
      assert.equal(unresolved.watermark, '2026-08-03T00:00:00.000Z');
      assert.equal(inbox.status, 'unresolved');
      assert.equal(inbox.reason, 'inactive_listing');
      assert.equal(Number(inbox.attempts), 1);
    } finally {
      await db('listings').where({ id: listing.id }).update({ active: true });
    }
    const resolved = await runGuestyReconciliation({
      from: '2026-08-03T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z',
      searcher: async () => [],
      fetcher: async () => payload,
    });
    const inbox = await db('guesty_reconciliation_inbox').where({ reservation_id: reservationId }).first();
    assert.equal(resolved.retried, 1);
    assert.equal(inbox.status, 'resolved');
    assert(inbox.resolved_at);
    assert.equal(Number(inbox.attempts), 2);
    assert.equal((await db('reservation_snapshots').where({ reservation_id: reservationId }).first()).status, 'cancelled');
    const replay = await retryGuestyUnresolvedReservations({ fetcher: async () => { throw new Error('resolved row replayed'); } });
    assert.equal(replay.attempted, 0);
  });

  test('authoritative Guesty cancellation durably queues and automatically verifies APY and TAKK cancellation work', async () => {
    const vatNumber = '123456783';
    const identity = { vat_number: vatNumber };
    const [autoCompany] = await db('companies').insert({
      company_name: 'PG Automatic Cancellation Tenant',
      vat_number: vatNumber,
      aade_user_id: encryptSecret('pg-auto-user', companySecretContext(identity, 'aade_user_id')),
      aade_subscription_key: encryptSecret('pg-auto-key', companySecretContext(identity, 'aade_subscription_key')),
      aade_credential_status: 'verified',
      aade_credentials_verified_at: new Date().toISOString(),
      invoice_series: 'PG-AUTO-CANCEL',
      active: true,
    }).returning('*');
    const [autoListing] = await db('listings').insert({
      company_id: autoCompany.id,
      listing_id_guesty: 'pg-auto-cancel-listing',
      property_type: 'apartment',
      default_invoice_type: '11.2',
      climate_fee_high: 10,
      climate_fee_low: 1.5,
      climate_fee_high_category: 24,
      climate_fee_low_category: 10,
      climate_fee_series: 'PG-AUTO-CANCEL-TAKK',
      payment_method_type: 1,
      active: true,
    }).returning('*');
    const autoBilling = {
      company_id: autoCompany.id,
      listing_id: autoListing.id,
      listing_id_guesty: autoListing.listing_id_guesty,
      vat_number: autoCompany.vat_number,
      property_type: autoListing.property_type,
      default_invoice_type: autoListing.default_invoice_type,
      invoice_series: autoCompany.invoice_series,
      climate_fee_high: autoListing.climate_fee_high,
      climate_fee_low: autoListing.climate_fee_low,
      climate_fee_high_category: autoListing.climate_fee_high_category,
      climate_fee_low_category: autoListing.climate_fee_low_category,
      climate_fee_series: autoListing.climate_fee_series,
      payment_method_type: 1,
    };
    const autoReservation = {
      reservationId: 'pg-auto-cancel-reservation',
      listingId: autoListing.listing_id_guesty,
      status: 'checked_out',
      platform: 'direct', platformKey: 'direct', source: 'direct', sourceKey: 'direct',
      checkIn: '2026-07-30', checkOut: '2026-07-31', nights: 1,
      financials: { totalGross: 113 },
      financialProfile: { status: 'matched', id: 1, version: 1, configHash: 'b'.repeat(64) },
    };
    await stageReservation(autoReservation, autoBilling);
    const pair = await prepareReservationDocuments(autoReservation, autoBilling);
    await db('reservation_snapshots').where({ reservation_id: autoReservation.reservationId }).update({ materialized_at: db.fn.now() });
    const marks = new Map([
      [pair.primary.document.id, '400000000008001'],
      [pair.climate.document.id, '400000000008002'],
    ]);
    for (const [documentId, mark] of marks) {
      await db('fiscal_documents').where({ id: documentId }).update({
        status: 'sent', mydata_mark: mark, mydata_environment: 'sandbox', verification_status: 'verified',
      });
    }
    await stageReservation({ ...autoReservation, status: 'cancelled' }, autoBilling);
    const queued = await db('fiscal_documents').where({ reservation_id: autoReservation.reservationId });
    assert(queued.every((document) => document.cancellation_status === 'requested'));
    const calls = [];
    const verificationOptions = [];
    const cancellationMark = (mark) => String(BigInt(mark) + 500000000000000n);
    await executeDailyClose({
      companyId: autoCompany.id,
      businessDate: '2026-08-10',
      materializer: async () => [],
      sender: async () => { throw new Error('must not send new invoices'); },
      cancellationSender: async (mark) => { calls.push(String(mark)); return { cancellationMark: cancellationMark(mark) }; },
      cancellationVerifier: async (mark, _companyContext, options) => {
        verificationOptions.push(options);
        return {
          verified: true, invoiceMark: String(mark), cancellationMark: cancellationMark(mark),
        };
      },
    });
    const cancelled = await db('fiscal_documents').where({ reservation_id: autoReservation.reservationId });
    assert.equal(calls.length, 2);
    assert.equal(verificationOptions.length, 2);
    assert(verificationOptions.every((options) => options?.cancellationMark));
    assert(cancelled.every((document) => document.status === 'cancelled'
      && document.cancellation_verification_status === 'verified'));
    assert.equal(Boolean((await db('reservation_snapshots').where({ reservation_id: autoReservation.reservationId }).first()).requires_review), false);
    await executeDailyClose({
      companyId: autoCompany.id,
      businessDate: '2026-08-10',
      materializer: async () => [],
      cancellationSender: async () => { throw new Error('duplicate CancelInvoice'); },
      cancellationVerifier: async () => { throw new Error('duplicate verification'); },
    });
    assert.equal(calls.length, 2);
    assert.equal(verificationOptions.length, 2);
  });

  test('materialization fails closed when a listing is deactivated after staging', async () => {
    const reservationId = 'pg-inactive-at-close';
    await stageReservation(reservation(reservationId), billingContext());
    await db('listings').where({ id: listing.id }).update({ active: false });
    let results;
    try {
      results = await materializeDueReservations(company.id, '2026-07-31', { useGuestyRefresh: false });
    } finally {
      await db('listings').where({ id: listing.id }).update({ active: true });
    }
    assert.match(results.find((row) => row.reservationId === reservationId).error, /inactive/);
    assert.equal(Number((await db('fiscal_documents').where({ reservation_id: reservationId }).count({ count: '*' }).first()).count), 0);
    assert.equal(Boolean((await db('reservation_snapshots').where({ reservation_id: reservationId }).first()).requires_review), true);
  });

  test('late transmission responses never downgrade verified or cancelled fiscal state', async () => {
    const document = await insertFiscalDocument({
      key: 'pg-late-mark', series: 'PG-LATE', aa: 1, kind: 'credit_note', retryable: true,
    });
    const attemptToken = await claimDocument(document.id);
    assert(attemptToken);
    await db('fiscal_documents').where({ id: document.id }).update({
      status: 'failed', transmission_uncertain: true,
    });
    await markDocumentSent(document.id, { mark: 'PG-MARK-MONOTONIC', uid: 'PG-UID' }, { attemptToken });
    await db('fiscal_documents').where({ id: document.id }).update({
      verification_status: 'verified', status: 'cancelled', cancellation_status: 'cancelled',
    });
    await markDocumentSent(document.id, { mark: 'PG-MARK-MONOTONIC', uid: 'LATE-UID' }, { attemptToken });
    const unchanged = await db('fiscal_documents').where({ id: document.id }).first();
    assert.equal(unchanged.status, 'cancelled');
    assert.equal(unchanged.verification_status, 'verified');
    assert.equal(unchanged.mydata_mark, 'PG-MARK-MONOTONIC');
    await assert.rejects(
      markDocumentSent(document.id, { mark: 'PG-CONFLICTING-MARK' }, { attemptToken }),
      (error) => error.status === 409,
    );
  });

  test('cancellation resolution is PG-race-safe, environment-bound, audited and monotonic', async () => {
    const document = await insertFiscalDocument({ key: 'pg-cancel-resolution', series: 'PG-CANCEL-RESOLVE', aa: 1 });
    await db('fiscal_documents').where({ id: document.id }).update({
      status: 'sent', mydata_mark: '400000000000901', mydata_environment: 'sandbox',
      verification_status: 'verified', cancellation_status: 'failed',
      cancellation_retryable: false, cancellation_uncertain: false,
      cancellation_error: 'explicit AADE rejection', cancellation_attempt_at: db.fn.now(),
    });
    const failed = await db('fiscal_documents').where({ id: document.id }).first();
    const expectedUpdatedAt = failed.updated_at instanceof Date
      ? failed.updated_at.toISOString() : new Date(failed.updated_at).toISOString();
    const input = {
      documentId: document.id, decision: 'authorize_retry', reason: 'Accountant authorized one corrected retry',
      resolvedBy: 'PG Accountant', expectedUpdatedAt, idempotencyKey: 'pg-resolution-same-key-001',
      adminKeyFingerprint: 'b'.repeat(64), expectedEnvironment: 'sandbox',
    };
    input.payloadHash = crypto.createHash('sha256').update(JSON.stringify({
      documentId: Number(input.documentId), decision: input.decision, reason: input.reason,
      resolvedBy: input.resolvedBy, expectedUpdatedAt: input.expectedUpdatedAt,
    })).digest('hex');
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => resolveDefinitiveCancellationFailure(input)));
    assert.equal(concurrent.filter((row) => !row.idempotent).length, 1);
    assert(concurrent.slice(1).some((row) => row.idempotent));
    assert.equal((await listCancellationResolutionEvents(document.id)).length, 1);

    const foundDocument = await insertFiscalDocument({ key: 'pg-cancel-found', series: 'PG-CANCEL-FOUND', aa: 1 });
    await db('fiscal_documents').where({ id: foundDocument.id }).update({
      status: 'sent', mydata_mark: '400000000000902', mydata_environment: 'sandbox',
      verification_status: 'verified', cancellation_status: 'failed', cancellation_retryable: false,
      cancellation_uncertain: false, cancellation_error: 'explicit AADE rejection',
    });
    const foundFailed = await db('fiscal_documents').where({ id: foundDocument.id }).first();
    const foundExpected = foundFailed.updated_at instanceof Date
      ? foundFailed.updated_at.toISOString() : new Date(foundFailed.updated_at).toISOString();
    const foundInput = {
      documentId: foundDocument.id, decision: 'retain_active', reason: 'Fresh AADE check found cancellation',
      resolvedBy: 'PG Accountant', expectedUpdatedAt: foundExpected, idempotencyKey: 'pg-resolution-found-001',
      adminKeyFingerprint: 'b'.repeat(64), expectedEnvironment: 'sandbox',
      foundCancellation: {
        invoiceMark: '400000000000902', cancellationMark: '900000000000902', raw: { verified: true },
      },
    };
    foundInput.payloadHash = crypto.createHash('sha256').update(JSON.stringify({
      documentId: Number(foundInput.documentId), decision: foundInput.decision, reason: foundInput.reason,
      resolvedBy: foundInput.resolvedBy, expectedUpdatedAt: foundInput.expectedUpdatedAt,
    })).digest('hex');
    const found = await resolveDefinitiveCancellationFailure(foundInput);
    const foundReplay = await resolveDefinitiveCancellationFailure(foundInput);
    assert(found.reconciled && found.document.status === 'cancelled'
      && found.document.cancellation_verification_status === 'verified');
    assert(foundReplay.idempotent && foundReplay.reconciled);
    assert.equal((await listCancellationResolutionEvents(foundDocument.id))[0].decision, 'reconciled_cancelled');
    await upsertReservationSnapshot(reservation('pg-cancel-found'), billingContext());
    await db('reservation_snapshots').where({ reservation_id: 'pg-cancel-found' }).update({
      materialized_at: db.fn.now(), requires_review: true,
    });
    await db('fiscal_documents').where({ id: foundDocument.id }).update({ cancellation_verification_status: 'pending' });
    await assert.rejects(
      reopenSnapshotForReissue('pg-cancel-found', 'Corrected reservation after cancellation'),
      (error) => error.status === 409,
    );
    await db('fiscal_documents').where({ id: foundDocument.id }).update({ cancellation_verification_status: 'verified' });
    const reopened = await reopenSnapshotForReissue('pg-cancel-found', 'Corrected reservation after verified cancellation');
    assert.equal(Number(reopened.fiscal_revision), 1);

    const lateDocument = await insertFiscalDocument({ key: 'pg-cancel-late-verify', series: 'PG-CANCEL-LATE', aa: 1 });
    await db('fiscal_documents').where({ id: lateDocument.id }).update({
      status: 'sent', mydata_mark: '400000000000903', mydata_environment: 'sandbox',
      cancellation_status: 'transmitting', cancellation_token: 'pg-cancel-token',
    });
    await markDocumentCancelled(lateDocument.id, '900000000000903', {
      attemptToken: 'pg-cancel-token', response: { statusCode: 'Success' }, expectedEnvironment: 'sandbox',
    });
    const merged = await markDocumentCancelled(lateDocument.id, '900000000000903', {
      reconciled: true, verificationResponse: { verified: true }, expectedEnvironment: 'sandbox',
    });
    assert.equal(merged.cancellation_verification_status, 'verified');

    await assert.rejects(
      resolveDefinitiveCancellationFailure({ ...input, idempotencyKey: 'pg-resolution-wrong-env', expectedEnvironment: 'production' }),
      (error) => error.status === 409,
    );
  });

  test('primary and TAKK rollback atomically, including both sequence increments', async () => {
    const failedReservation = reservation('pg-atomic-rollback');
    await assert.rejects(
      prepareReservationDocuments(failedReservation, billingContext({ climate_fee_high_category: 999 })),
      /requires AADE climate categories/,
    );
    assert.equal(Number((await db('fiscal_documents').where({ reservation_id: failedReservation.reservationId }).count({ count: '*' }).first()).count), 0);
    assert.equal(Number((await db('document_sequences').whereIn('series', ['PG-ATOMIC', 'PG-ATOMIC-TAKK']).count({ count: '*' }).first()).count), 0);

    const corrected = await prepareReservationDocuments(failedReservation, billingContext());
    assert.equal(Number(corrected.primary.document.aa), 1);
    assert.equal(Number(corrected.climate.document.aa), 1);
  });

  test('concurrent identical materialization returns one idempotent APY+TAKK pair to every worker', async () => {
    const sameReservation = reservation('pg-identical-race');
    const results = await Promise.all(Array.from({ length: 12 }, () => prepareReservationDocuments(sameReservation, billingContext({
      invoice_series: 'PG-RACE', climate_fee_series: 'PG-RACE-TAKK',
    }))));
    assert.equal(new Set(results.map((result) => result.primary.document.id)).size, 1);
    assert.equal(new Set(results.map((result) => result.climate.document.id)).size, 1);
    assert.equal(Number((await db('fiscal_documents').where({ reservation_id: sameReservation.reservationId }).count({ count: '*' }).first()).count), 2);
  });

  test('daily-close lease is exclusive and a stale worker cannot heartbeat or finish', async () => {
    const leaseVat = '876543210';
    const [leaseCompany] = await db('companies').insert({
      company_name: 'PostgreSQL Lease Isolation Test',
      vat_number: leaseVat,
      aade_user_id: 'pg-lease-user',
      aade_subscription_key: 'pg-lease-key',
      invoice_series: 'PG-LEASE',
      active: true,
    }).returning('*');
    const [leaseListing] = await db('listings').insert({
      company_id: leaseCompany.id,
      listing_id_guesty: 'pg-lease-listing',
      property_type: 'apartment',
      default_invoice_type: '11.2',
      climate_fee_high: 10,
      climate_fee_low: 1.5,
      climate_fee_high_category: 24,
      climate_fee_low_category: 10,
      climate_fee_series: 'PG-LEASE-TAKK',
      payment_method_type: 1,
      active: true,
    }).returning('*');
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => beginRun(leaseCompany.id, '2026-07-31')));
    const winners = attempts.filter((result) => result.status === 'fulfilled');
    const losers = attempts.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert(losers.every((result) => result.reason.status === 409));
    await finishRun(winners[0].value.id, { total: 0, sent: 0, failed: 0 }, winners[0].value.lease_token);

    const crashed = await beginRun(leaseCompany.id, '2026-07-30', { leaseSeconds: 30 });
    const document = await insertFiscalDocument({
      key: 'pg-daily-close-lease-document',
      reservationId: 'pg-daily-close-lease-reservation',
      series: 'PG-LEASE',
      aa: 1,
      companyId: leaseCompany.id,
      listingId: leaseListing.id,
    });
    await recordRunItem(crashed.id, document.id, 'failed', 'crashed attempt', crashed.lease_token);
    await db('daily_close_runs').where({ id: crashed.id }).update({ lease_expires_at_ms: Date.now() - 1 });
    await assert.rejects(
      recordRunItem(crashed.id, document.id, 'failed', 'expired worker', crashed.lease_token),
      (error) => error.status === 409,
    );
    const recovered = await beginRun(leaseCompany.id, '2026-07-30', { leaseSeconds: 30 });
    assert.notEqual(recovered.lease_token, crashed.lease_token);
    assert.equal(Number((await db('daily_close_items').where({ run_id: recovered.id }).count({ count: '*' }).first()).count), 0);
    await assert.rejects(heartbeatRun(crashed.id, crashed.lease_token, 30), (error) => error.status === 409);
    await assert.rejects(finishRun(crashed.id, { total: 0, sent: 0, failed: 0 }, crashed.lease_token), (error) => error.status === 409);
    await Promise.all(Array.from({ length: 12 }, () => (
      recordRunItem(recovered.id, document.id, 'verified', 'current worker', recovered.lease_token)
    )));
    await assert.rejects(
      recordRunItem(crashed.id, document.id, 'failed', 'stale worker', crashed.lease_token),
      (error) => error.status === 409,
    );
    const auditItem = await db('daily_close_items').where({ run_id: recovered.id, document_id: document.id }).first();
    assert.equal(auditItem.result, 'verified');
    assert.equal(auditItem.message, 'current worker');

    await db('fiscal_documents').where({ id: document.id }).update({
      status: 'sent', mydata_mark: 'PG-LEASE-MARK', verification_status: 'pending', verified_at: null,
    });
    await assert.rejects(
      recordVerificationResult(crashed.id, document.id, 'PG-LEASE-MARK', { verified: true }, crashed.lease_token),
      (error) => error.status === 409,
    );
    assert.equal((await db('fiscal_documents').where({ id: document.id }).first()).verification_status, 'pending');
    const firstArtifact = pdfArtifact(document, 'PG-LEASE-MARK', 'original');
    await recordVerificationResult(recovered.id, document.id, 'PG-LEASE-MARK', {
      verified: true, artifact: firstArtifact,
    }, recovered.lease_token);
    assert.equal((await db('fiscal_documents').where({ id: document.id }).first()).verification_status, 'verified');
    const archivedHash = (await getFiscalPdfArtifact(document.id)).pdf_sha256;
    await insertFiscalPdfArtifactOnce(pdfArtifact(document, 'PG-LEASE-MARK', 'different-render'));
    assert.equal((await getFiscalPdfArtifact(document.id)).pdf_sha256, archivedHash, 'idempotent archive never overwrites the first exact PDF');
    await assert.rejects(
      db('fiscal_pdf_artifacts').where({ document_id: document.id }).update({ render_snapshot: '{}' }),
      /immutable and append-only/,
    );
    await assert.rejects(
      db('fiscal_pdf_artifacts').where({ document_id: document.id }).delete(),
      /immutable and append-only/,
    );
    assert.match((await getFiscalPdfArtifact(document.id)).render_snapshot_sha256, /^[a-f0-9]{64}$/);
    const finished = await finishRun(recovered.id, { total: 0, sent: 0, failed: 0 }, recovered.lease_token);
    assert.equal(finished.status, 'completed');
    assert.equal(Number(finished.document_count), 1);
    assert.equal(Number(finished.sent_count), 1);
    assert.equal(Number(finished.failed_count), 0);

    const lateDocument = await insertFiscalDocument({
      key: 'pg-late-mark-after-crash', reservationId: 'pg-late-mark-after-crash',
      series: 'PG-LATE-MARK', aa: 1,
      companyId: leaseCompany.id, listingId: leaseListing.id,
    });
    await db('fiscal_documents').where({ id: lateDocument.id }).update({
      issue_date: '2026-08-01', status: 'transmitting', mydata_mark: null,
      verification_status: 'pending', verified_at: null,
    });
    const inFlightRun = await beginRun(leaseCompany.id, '2026-08-01', { leaseSeconds: 30 });
    await recordRunItem(inFlightRun.id, lateDocument.id, 'in_flight', 'waiting for MARK', inFlightRun.lease_token);
    const partial = await finishRun(inFlightRun.id, {}, inFlightRun.lease_token);
    assert.equal(partial.status, 'partial');
    assert.equal(Number(partial.document_count), 1);
    assert.equal(Number(partial.sent_count), 0);
    assert.equal(Number(partial.failed_count), 0);

    await db('fiscal_documents').where({ id: lateDocument.id }).update({ status: 'sent', mydata_mark: 'PG-LATE-MARK' });
    await db('fiscal_documents').where({ company_id: leaseCompany.id }).whereNot({ id: lateDocument.id }).update({
      status: 'cancelled', cancellation_status: 'cancelled',
    });
    const verificationRun = await beginRun(leaseCompany.id, '2026-08-01', { leaseSeconds: 30 });
    await recordVerificationResult(verificationRun.id, lateDocument.id, 'PG-LATE-MARK', {
      verified: true, artifact: pdfArtifact(lateDocument, 'PG-LATE-MARK', 'late'),
    }, verificationRun.lease_token);
    const completed = await finishRun(verificationRun.id, {}, verificationRun.lease_token);
    assert.equal(completed.status, 'completed');
    assert.equal(Number(completed.document_count), 1);
    assert.equal(Number(completed.sent_count), 1);
    assert.equal(Number(completed.failed_count), 0);
  });
}

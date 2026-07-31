'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  const { createDocumentOnce } = require('../src/repositories/fiscal-documents');
  const { prepareReservationDocuments } = require('../src/services/document-service');
  const { beginRun, heartbeatRun, recordRunItem, recordVerificationResult, finishRun } = require('../src/repositories/daily-close');

  let company;
  let listing;

  async function runMigrationProcess() {
    return execFileAsync(process.execPath, ['migrations/run.js'], {
      cwd: projectRoot,
      env: process.env,
      timeout: 30000,
    });
  }

  async function insertFiscalDocument({ key, type = '11.2', series, aa }) {
    await db('fiscal_documents').insert({
      document_key: key,
      company_id: company.id,
      listing_id: listing.id,
      reservation_id: key,
      document_kind: 'service_receipt',
      document_type: type,
      series,
      aa,
      issue_date: '2026-07-31',
      net_value: 100,
      vat_amount: 13,
      other_taxes_amount: 0,
      gross_value: 113,
      status: 'pending',
      xml_payload: `<invoice aa="${aa}"/>`,
      source_payload: '{}',
    });
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

    [company] = await db('companies').insert({
      company_name: 'PostgreSQL Integration Test',
      vat_number: '044800455',
      aade_user_id: 'pg-test-user',
      aade_subscription_key: 'pg-test-key',
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
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => beginRun(company.id, '2026-07-31')));
    const winners = attempts.filter((result) => result.status === 'fulfilled');
    const losers = attempts.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert(losers.every((result) => result.reason.status === 409));
    await finishRun(winners[0].value.id, { total: 0, sent: 0, failed: 0 }, winners[0].value.lease_token);

    const crashed = await beginRun(company.id, '2026-07-30', { leaseSeconds: 30 });
    const document = await db('fiscal_documents').orderBy('id', 'asc').first();
    await recordRunItem(crashed.id, document.id, 'failed', 'crashed attempt', crashed.lease_token);
    await db('daily_close_runs').where({ id: crashed.id }).update({ lease_expires_at_ms: Date.now() - 1 });
    await assert.rejects(
      recordRunItem(crashed.id, document.id, 'failed', 'expired worker', crashed.lease_token),
      (error) => error.status === 409,
    );
    const recovered = await beginRun(company.id, '2026-07-30', { leaseSeconds: 30 });
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
    await recordVerificationResult(recovered.id, document.id, 'PG-LEASE-MARK', { verified: true }, recovered.lease_token);
    assert.equal((await db('fiscal_documents').where({ id: document.id }).first()).verification_status, 'verified');
    const finished = await finishRun(recovered.id, { total: 0, sent: 0, failed: 0 }, recovered.lease_token);
    assert.equal(finished.status, 'completed');
  });
}

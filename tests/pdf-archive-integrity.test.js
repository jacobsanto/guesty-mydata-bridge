'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const databasePath = `/tmp/guesty-mydata-pdf-archive-${process.pid}.db`;
process.env.DB_CLIENT = 'better-sqlite3';
process.env.DB_PATH = databasePath;

const { db, initSchema } = require('../src/database');
const {
  getFiscalPdfArtifact, insertFiscalPdfArtifactOnce, sha256,
} = require('../src/repositories/fiscal-pdf-artifacts');

let company;
let listing;

async function insertDocument(key, aa) {
  const [id] = await db('fiscal_documents').insert({
    document_key: key,
    company_id: company.id,
    listing_id: listing.id,
    reservation_id: key,
    document_kind: 'service_receipt',
    document_type: '11.2',
    series: 'ARCHIVE',
    aa,
    issue_date: '2026-07-31',
    status: 'sent',
    xml_payload: '<InvoicesDoc/>',
    mydata_mark: String(400000000000000n + BigInt(aa)),
    verification_status: 'verified',
    mydata_environment: 'sandbox',
    target_environment: 'sandbox',
  });
  return db('fiscal_documents').where({ id }).first();
}

test.before(async () => {
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
  // Reproduce the pre-checksum archive shape so initSchema exercises the
  // production backfill path before installing append-only triggers.
  await db.schema.createTable('fiscal_pdf_artifacts', (t) => {
    t.increments('id').primary();
    t.integer('document_id').notNullable().unique();
    t.integer('company_id').notNullable();
    t.string('mydata_mark', 30).notNullable();
    t.string('mydata_uid', 50).nullable();
    t.string('pdf_sha256', 64).notNullable();
    t.binary('pdf_bytes').notNullable();
    t.text('render_snapshot').notNullable();
    t.string('render_version', 30).notNullable();
    t.timestamp('archived_at').notNullable().defaultTo(db.fn.now());
  });
  const legacyPdf = Buffer.from('%PDF-1.4\nlegacy-archive\n%%EOF');
  await db('fiscal_pdf_artifacts').insert({
    document_id: 999,
    company_id: 999,
    mydata_mark: '400000000009999',
    pdf_sha256: sha256(legacyPdf),
    pdf_bytes: legacyPdf,
    render_snapshot: JSON.stringify({ legacy: true }),
    render_version: 'legacy-v1',
  });
  await initSchema();
  const [companyId] = await db('companies').insert({
    company_name: 'PDF Archive Test',
    vat_number: '109262634',
    aade_user_id: 'test-user',
    aade_subscription_key: 'test-key',
    invoice_series: 'ARCHIVE',
    active: true,
  });
  company = await db('companies').where({ id: companyId }).first();
  const [listingId] = await db('listings').insert({
    company_id: company.id,
    listing_id_guesty: 'pdf-archive-listing',
    property_type: 'apartment',
    climate_fee_high: 8,
    climate_fee_low: 2,
    climate_fee_high_category: 24,
    climate_fee_low_category: 10,
    active: true,
  });
  listing = await db('listings').where({ id: listingId }).first();
});

test.after(async () => {
  await db.destroy();
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
});

test('SQLite migration backfills legacy render snapshot checksums before locking the archive', async () => {
  const legacy = await getFiscalPdfArtifact(999);
  assert.match(legacy.render_snapshot_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(legacy.render_snapshot), { legacy: true });
  await assert.rejects(
    db('fiscal_pdf_artifacts').where({ document_id: 999 }).update({ render_snapshot: '{}' }),
    /immutable and append-only/,
  );
});

test('SQLite fiscal PDF archive checksums the snapshot and rejects update/delete', async () => {
  const document = await insertDocument('pdf-archive-immutable', 1);
  const first = await insertFiscalPdfArtifactOnce({
    documentId: document.id,
    companyId: company.id,
    mark: document.mydata_mark,
    uid: 'UID-ARCHIVE-1',
    pdfBytes: Buffer.from('%PDF-1.4\nimmutable\n%%EOF'),
    renderSnapshot: { documentType: '11.2', series: 'ARCHIVE', number: 1 },
    renderVersion: 'test-v1',
  });
  assert.match(first.render_snapshot_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(first.render_snapshot), { documentType: '11.2', series: 'ARCHIVE', number: 1 });

  await assert.rejects(
    db('fiscal_pdf_artifacts').where({ document_id: document.id }).update({ render_snapshot: '{}' }),
    /immutable and append-only/,
  );
  await assert.rejects(
    db('fiscal_pdf_artifacts').where({ document_id: document.id }).delete(),
    /immutable and append-only/,
  );
  assert.equal((await getFiscalPdfArtifact(document.id)).pdf_sha256, first.pdf_sha256);
});

test('SQLite read detects a render snapshot checksum mismatch', async () => {
  const document = await insertDocument('pdf-archive-corrupt-snapshot', 2);
  const pdfBytes = Buffer.from('%PDF-1.4\ncorrupt-snapshot-test\n%%EOF');
  await db('fiscal_pdf_artifacts').insert({
    document_id: document.id,
    company_id: company.id,
    mydata_mark: document.mydata_mark,
    mydata_uid: 'UID-ARCHIVE-2',
    pdf_sha256: sha256(pdfBytes),
    pdf_bytes: pdfBytes,
    render_snapshot: JSON.stringify({ number: 2 }),
    render_snapshot_sha256: '0'.repeat(64),
    render_version: 'test-v1',
  });
  await assert.rejects(getFiscalPdfArtifact(document.id), /render snapshot checksum verification failed/);
});

test('SQLite insert trigger requires a render snapshot checksum', async () => {
  const document = await insertDocument('pdf-archive-missing-snapshot-hash', 3);
  const pdfBytes = Buffer.from('%PDF-1.4\nmissing-snapshot-hash\n%%EOF');
  await assert.rejects(db('fiscal_pdf_artifacts').insert({
    document_id: document.id,
    company_id: company.id,
    mydata_mark: document.mydata_mark,
    pdf_sha256: sha256(pdfBytes),
    pdf_bytes: pdfBytes,
    render_snapshot: '{}',
    render_version: 'test-v1',
  }), /render snapshot checksum is required/);
});

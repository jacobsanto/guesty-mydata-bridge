'use strict';

const crypto = require('crypto');
const { db } = require('../database');

function bad(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

function pdfBuffer(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  if (bytes.length < 4 || bytes.subarray(0, 4).toString() !== '%PDF') {
    throw bad('Fiscal PDF artifact is not a valid PDF buffer', 500);
  }
  return bytes;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeArtifact(row) {
  if (!row) return null;
  const bytes = pdfBuffer(row.pdf_bytes);
  if (sha256(bytes) !== row.pdf_sha256) {
    throw bad('Archived fiscal PDF checksum verification failed', 500);
  }
  if (sha256(Buffer.from(String(row.render_snapshot), 'utf8')) !== row.render_snapshot_sha256) {
    throw bad('Archived fiscal PDF render snapshot checksum verification failed', 500);
  }
  return { ...row, pdf_bytes: bytes };
}

async function getFiscalPdfArtifact(documentId, client = db) {
  return normalizeArtifact(await client('fiscal_pdf_artifacts').where({ document_id: documentId }).first());
}

async function insertFiscalPdfArtifactOnce(input, client = db) {
  const bytes = pdfBuffer(input.pdfBytes);
  const digest = sha256(bytes);
  const snapshot = typeof input.renderSnapshot === 'string'
    ? input.renderSnapshot
    : JSON.stringify(input.renderSnapshot);
  if (!snapshot) throw bad('Fiscal PDF render snapshot is required', 500);
  try { JSON.parse(snapshot); } catch { throw bad('Fiscal PDF render snapshot must be valid JSON', 500); }
  const snapshotDigest = sha256(Buffer.from(snapshot, 'utf8'));

  await client('fiscal_pdf_artifacts').insert({
    document_id: input.documentId,
    company_id: input.companyId,
    mydata_mark: String(input.mark),
    mydata_uid: input.uid ? String(input.uid) : null,
    pdf_sha256: digest,
    pdf_bytes: bytes,
    render_snapshot: snapshot,
    render_snapshot_sha256: snapshotDigest,
    render_version: input.renderVersion || 'fiscal-pdf-v1',
  }).onConflict('document_id').ignore();

  const archived = await getFiscalPdfArtifact(input.documentId, client);
  if (!archived) throw bad('Fiscal PDF artifact could not be archived', 500);
  if (Number(archived.company_id) !== Number(input.companyId) || String(archived.mydata_mark) !== String(input.mark)) {
    throw bad('Existing fiscal PDF artifact belongs to a different fiscal identity');
  }
  return archived;
}

module.exports = { getFiscalPdfArtifact, insertFiscalPdfArtifactOnce, sha256 };

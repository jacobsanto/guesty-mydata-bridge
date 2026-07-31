'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { getDocumentById } = require('../repositories/fiscal-documents');
const { renderFiscalDocumentPdf } = require('./pdf-service');

function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }

function assertSandboxDocument(document, kind, companyId, reservationId) {
  if (!document) throw bad(`${kind} document not found`, 404);
  const acceptedTypes = kind === 'primary' ? ['2.1', '11.2'] : ['8.2'];
  if (!acceptedTypes.includes(document.document_type)) throw bad(`${kind} document has the wrong myDATA type`, 409);
  if (Number(document.company_id) !== companyId || String(document.reservation_id) !== reservationId) {
    throw bad('Sign-off documents must belong to the same company and reservation', 409);
  }
  if (document.status !== 'sent' || document.verification_status !== 'verified' || !document.mydata_mark
      || document.mydata_environment !== 'sandbox') {
    throw bad(`${kind} document must be sent and verified in myDATA sandbox`, 409);
  }
}

async function createSandboxSignoff(payload) {
  if ((process.env.MYDATA_ENV || 'sandbox') !== 'sandbox') throw bad('Sandbox sign-off can only be recorded while MYDATA_ENV=sandbox', 409);
  const primaryId = Number(payload.primary_document_id);
  const takkId = Number(payload.takk_document_id);
  const approvedBy = String(payload.approved_by || '').trim();
  if (!Number.isInteger(primaryId) || !Number.isInteger(takkId) || primaryId === takkId) throw bad('Two valid, distinct document IDs are required');
  if (!approvedBy || approvedBy.length > 200) throw bad('approved_by must contain 1-200 characters');
  const [primary, takk] = await Promise.all([getDocumentById(primaryId), getDocumentById(takkId)]);
  const companyId = Number(primary?.company_id);
  const reservationId = String(primary?.reservation_id || '');
  assertSandboxDocument(primary, 'primary', companyId, reservationId);
  assertSandboxDocument(takk, 'TAKK', companyId, reservationId);
  const [primaryPdf, takkPdf] = await Promise.all([renderFiscalDocumentPdf(primary.id), renderFiscalDocumentPdf(takk.id)]);
  const row = {
    company_id: companyId, reservation_id: reservationId,
    primary_document_id: primary.id, takk_document_id: takk.id,
    primary_mark: String(primary.mydata_mark), takk_mark: String(takk.mydata_mark),
    primary_pdf_sha256: crypto.createHash('sha256').update(primaryPdf).digest('hex'),
    takk_pdf_sha256: crypto.createHash('sha256').update(takkPdf).digest('hex'),
    approved_by: approvedBy,
    approval_notes: payload.approval_notes ? String(payload.approval_notes).slice(0, 4000) : null,
  };
  try {
    const result = await db('sandbox_signoffs').insert(row).returning('id');
    const id = typeof result[0] === 'object' ? result[0].id : result[0];
    return db('sandbox_signoffs').where({ id }).first();
  } catch (error) {
    if (error.code === '23505' || String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw bad('A sandbox sign-off already exists for this reservation or document pair', 409);
    }
    throw error;
  }
}

async function listSandboxSignoffs() {
  return db('sandbox_signoffs').select('*').orderBy('approved_at', 'desc');
}

module.exports = { createSandboxSignoff, listSandboxSignoffs };

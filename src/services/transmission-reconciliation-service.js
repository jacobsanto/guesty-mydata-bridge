'use strict';

const { db } = require('../database');
const { getCompanyById } = require('../repositories/companies');
const {
  getDocumentById, markDocumentSent, markDocumentVerified,
} = require('../repositories/fiscal-documents');
const { assertVerifiedAadeCredentials } = require('../security/aade-credential-guard');
const { verifyTransmittedDocument } = require('../mydata-client');
const { assertSameFiscalIdentity } = require('../validation/mydata-identity');
const { prepareFiscalDocumentPdfArtifact } = require('./pdf-service');

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

async function reconcileUncertainTransmission({ documentId, mark, verifier = verifyTransmittedDocument }) {
  const numericMark = String(mark || '').trim();
  if (!/^\d+$/.test(numericMark)) throw Object.assign(new Error('A numeric MARK is required'), { status: 400 });
  const document = await getDocumentById(documentId);
  if (!document) throw Object.assign(new Error('Fiscal document not found'), { status: 404 });
  if (document.status !== 'failed' || !document.transmission_uncertain || document.mydata_mark) {
    throw conflict('Only an uncertain failed transmission without a stored MARK can be reconciled');
  }
  const duplicateMark = await db('fiscal_documents').where({ mydata_mark: numericMark }).whereNot({ id: document.id }).first('id');
  if (duplicateMark) throw conflict('This MARK is already assigned to another local document');
  const company = await getCompanyById(document.company_id);
  if (!company) throw Object.assign(new Error('Company not found'), { status: 404 });
  const result = await verifier(numericMark, assertVerifiedAadeCredentials(company));
  if (!result?.verified || String(result.mark) !== numericMark || !result.raw) {
    throw conflict('RequestTransmittedDocs did not verify the supplied MARK');
  }
  assertSameFiscalIdentity(document, result.raw);
  await markDocumentSent(document.id, {
    mark: numericMark,
    uid: result.uid || result.raw.uid || null,
    qrUrl: result.raw.qrUrl || null,
    raw: { reconciledFromRequestTransmittedDocs: true, invoice: result.raw },
  }, { reconciled: true });
  const artifact = await prepareFiscalDocumentPdfArtifact(document.id, {
    verified: true,
    mark: numericMark,
    uid: result.uid || result.raw.uid || null,
    qrUrl: result.raw.qrUrl || null,
  });
  await markDocumentVerified(document.id, artifact);
  return getDocumentById(document.id);
}

module.exports = { reconcileUncertainTransmission };

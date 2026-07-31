'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { getCompanyById } = require('../repositories/companies');
const { getDocumentById } = require('../repositories/fiscal-documents');
const {
  insertAcceptanceRun, listAcceptanceRuns, listLegacyAcceptanceEvidence,
} = require('../repositories/sandbox-acceptance');
const { companyCredentialBinding } = require('../security/credentials');
const { getFiscalPdfArtifact } = require('../repositories/fiscal-pdf-artifacts');

const ACCEPTANCE_CONTRACT_VERSION = 'mydata-v2.0.1-accommodation-1';
const CAPABILITIES = Object.freeze({
  STAY_TPY: 'stay:2.1+8.2',
  STAY_APY: 'stay:11.2+8.2',
  CREDIT_TPY: 'credit:5.1',
  CREDIT_APY: 'credit:11.4',
  CANCEL: 'cancel+verify',
});
const CAPABILITY_ORDER = [
  CAPABILITIES.STAY_TPY, CAPABILITIES.CREDIT_TPY,
  CAPABILITIES.STAY_APY, CAPABILITIES.CREDIT_APY,
  CAPABILITIES.CANCEL,
];

function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
function sha256(value) {
  if (value === undefined || value === null || value === '') return null;
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function requiredCapabilityKeys({
  listingTypes = [], ruleTypes = [], overrideTypes = [], documentTypes = [], creditableProductionTypes = [],
} = {}) {
  const observed = new Set([
    ...listingTypes, ...ruleTypes, ...overrideTypes, ...documentTypes, ...creditableProductionTypes,
  ].map(String));
  const primary = new Set();
  if (observed.has('2.1') || observed.has('5.1')) primary.add('2.1');
  if (observed.has('11.2') || observed.has('11.4')) primary.add('11.2');
  const required = new Set();
  if (primary.has('2.1')) {
    required.add(CAPABILITIES.STAY_TPY);
    required.add(CAPABILITIES.CREDIT_TPY);
  }
  if (primary.has('11.2')) {
    required.add(CAPABILITIES.STAY_APY);
    required.add(CAPABILITIES.CREDIT_APY);
  }
  if (primary.size) required.add(CAPABILITIES.CANCEL);
  return CAPABILITY_ORDER.filter((capability) => required.has(capability));
}

async function deriveRequiredCapabilities(companyId, client = db) {
  const [listings, rules, overrides, nonterminal, creditable] = await Promise.all([
    client('listings').where({ company_id: companyId, active: true }).select('default_invoice_type'),
    client('listing_channel_billing_rules as r')
      .join('listings as l', 'l.id', 'r.listing_id')
      .where({ 'l.company_id': companyId, 'l.active': true, 'r.active': true })
      .select('r.invoice_type'),
    client('reservation_snapshots')
      .where({ company_id: companyId })
      .whereIn('status', ['confirmed', 'checked_out'])
      .whereIn('invoice_type_override', ['2.1', '11.2'])
      .select('invoice_type_override'),
    client('fiscal_documents').where({ company_id: companyId })
      .whereIn('status', ['pending', 'failed', 'transmitting'])
      .whereIn('document_type', ['2.1', '11.2', '5.1', '11.4'])
      .select('document_type'),
    client('fiscal_documents').where({ company_id: companyId, status: 'sent', verification_status: 'verified', mydata_environment: 'production' })
      .whereIn('document_type', ['2.1', '11.2'])
      .where((query) => query.whereNull('cancellation_status').orWhere({ cancellation_status: 'none' }))
      .select('document_type'),
  ]);
  return requiredCapabilityKeys({
    listingTypes: listings.map((row) => row.default_invoice_type),
    ruleTypes: rules.map((row) => row.invoice_type),
    overrideTypes: overrides.map((row) => row.invoice_type_override),
    documentTypes: nonterminal.map((row) => row.document_type),
    creditableProductionTypes: creditable.map((row) => row.document_type),
  });
}

function assertSandboxSubmission(document, companyId, acceptedTypes, label) {
  if (!document) throw bad(`${label} document not found`, 404);
  if (Number(document.company_id) !== Number(companyId)) throw bad(`${label} document belongs to another company`, 409);
  if (!acceptedTypes.includes(document.document_type)) throw bad(`${label} document has the wrong myDATA type`, 409);
  if (document.target_environment !== 'sandbox' || document.mydata_environment !== 'sandbox') {
    throw bad(`${label} document is not bound to myDATA sandbox`, 409);
  }
  if (document.status !== 'sent' || document.verification_status !== 'verified' || !document.mydata_mark) {
    throw bad(`${label} document must be sent and MARK-verified`, 409);
  }
  if (![null, undefined, 'none'].includes(document.cancellation_status)) {
    throw bad(`${label} document has an unresolved or completed cancellation`, 409);
  }
  if (!document.xml_payload || !document.mydata_response) throw bad(`${label} document is missing request/response evidence`, 409);
}

async function submissionHashes(document) {
  const pdfArtifact = await getFiscalPdfArtifact(document.id);
  if (!pdfArtifact) throw bad('Verified sandbox document is missing its archived PDF artifact', 409);
  if (Number(pdfArtifact.company_id) !== Number(document.company_id)
      || String(pdfArtifact.mydata_mark) !== String(document.mydata_mark)) {
    throw bad('Archived sandbox PDF does not match the document fiscal identity', 409);
  }
  return {
    xml_sha256: sha256(document.xml_payload),
    send_response_sha256: sha256(document.mydata_response),
    uid_sha256: sha256(document.mydata_uid),
    pdf_sha256: pdfArtifact.pdf_sha256,
  };
}

async function buildArtifact(companyId, input) {
  const capability = String(input.capability || '');
  const documentId = Number(input.document_id);
  if (!CAPABILITY_ORDER.includes(capability)) throw bad(`Unknown sandbox capability: ${capability}`);
  if (!Number.isInteger(documentId) || documentId <= 0) throw bad('A valid document_id is required');
  const document = await getDocumentById(documentId);

  if ([CAPABILITIES.STAY_TPY, CAPABILITIES.STAY_APY].includes(capability)) {
    const primaryType = capability === CAPABILITIES.STAY_TPY ? '2.1' : '11.2';
    const pairedId = Number(input.paired_document_id);
    if (!Number.isInteger(pairedId) || pairedId <= 0 || pairedId === documentId) throw bad('A distinct paired TAKK document is required');
    const paired = await getDocumentById(pairedId);
    assertSandboxSubmission(document, companyId, [primaryType], 'Primary');
    assertSandboxSubmission(paired, companyId, ['8.2'], 'TAKK');
    if (String(document.reservation_id) !== String(paired.reservation_id)) throw bad('Primary and TAKK evidence must belong to the same reservation', 409);
    return {
      capability, document_id: document.id, paired_document_id: paired.id, related_document_id: null,
      document_type: document.document_type, reservation_id: document.reservation_id,
      invoice_mark: String(document.mydata_mark), paired_mark: String(paired.mydata_mark), cancellation_mark: null,
      evidence_json: JSON.stringify({ primary: await submissionHashes(document), takk: await submissionHashes(paired) }),
    };
  }

  if ([CAPABILITIES.CREDIT_TPY, CAPABILITIES.CREDIT_APY].includes(capability)) {
    const creditType = capability === CAPABILITIES.CREDIT_TPY ? '5.1' : '11.4';
    const originalType = capability === CAPABILITIES.CREDIT_TPY ? '2.1' : '11.2';
    assertSandboxSubmission(document, companyId, [creditType], 'Credit');
    const original = await getDocumentById(document.related_document_id);
    if (!original || Number(original.company_id) !== Number(companyId) || original.document_type !== originalType) {
      throw bad(`Credit ${creditType} must reference an original ${originalType} of the same company`, 409);
    }
    assertSandboxSubmission(original, companyId, [originalType], 'Original');
    if (!original.mydata_mark || String(document.correlated_mark) !== String(original.mydata_mark)) {
      throw bad('Credit correlated MARK does not match its original document', 409);
    }
    return {
      capability, document_id: document.id, paired_document_id: null, related_document_id: original.id,
      document_type: document.document_type, reservation_id: document.reservation_id,
      invoice_mark: String(document.mydata_mark), paired_mark: null, cancellation_mark: null,
      evidence_json: JSON.stringify({ credit: await submissionHashes(document), original_mark: String(original.mydata_mark) }),
    };
  }

  if (!document) throw bad('Cancellation document not found', 404);
  if (Number(document.company_id) !== Number(companyId)) throw bad('Cancellation document belongs to another company', 409);
  if (document.target_environment !== 'sandbox' || document.mydata_environment !== 'sandbox') throw bad('Cancellation evidence is not bound to sandbox', 409);
  if (document.status !== 'cancelled' || document.cancellation_status !== 'cancelled'
      || document.cancellation_verification_status !== 'verified'
      || !document.mydata_mark || !document.cancellation_mark) {
    throw bad('Cancellation evidence must have verified invoice and cancellation MARKs', 409);
  }
  if (!document.cancellation_verification_response) {
    throw bad('Cancellation evidence is missing the RequestTransmittedDocs verification response', 409);
  }
  return {
    capability, document_id: document.id, paired_document_id: null,
    related_document_id: document.related_document_id || null,
    document_type: document.document_type, reservation_id: document.reservation_id,
    invoice_mark: String(document.mydata_mark), paired_mark: null,
    cancellation_mark: String(document.cancellation_mark),
    evidence_json: JSON.stringify({
      xml_sha256: sha256(document.xml_payload),
      send_response_sha256: sha256(document.mydata_response),
      // A network-ambiguous CancelInvoice may have no response body even though
      // RequestTransmittedDocs later proves the cancellation authoritatively.
      cancel_response_sha256: document.cancellation_response ? sha256(document.cancellation_response) : null,
      cancellation_verification_sha256: sha256(document.cancellation_verification_response),
      uid_sha256: sha256(document.mydata_uid),
    }),
  };
}

async function createAcceptanceRun(payload) {
  if ((process.env.MYDATA_ENV || 'sandbox') !== 'sandbox') throw bad('Sandbox acceptance can only be recorded while MYDATA_ENV=sandbox', 409);
  const companyId = Number(payload.company_id);
  const approvedBy = String(payload.approved_by || '').trim();
  const inputs = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  if (!Number.isInteger(companyId) || companyId <= 0) throw bad('A valid company_id is required');
  if (!approvedBy || approvedBy.length > 200) throw bad('approved_by must contain 1-200 characters');
  if (!inputs.length) throw bad('At least one acceptance artifact is required');
  const capabilities = inputs.map((item) => String(item.capability || ''));
  if (new Set(capabilities).size !== capabilities.length) throw bad('A capability may appear only once per acceptance run');
  const company = await getCompanyById(companyId);
  if (!company || !company.active) throw bad('Active company not found', 404);
  const artifacts = [];
  for (const input of inputs) artifacts.push(await buildArtifact(companyId, input));
  return insertAcceptanceRun({
    company_id: company.id,
    issuer_vat: company.vat_number,
    credential_binding_sha256: companyCredentialBinding(company),
    contract_version: ACCEPTANCE_CONTRACT_VERSION,
    approved_by: approvedBy,
    approval_notes: payload.approval_notes ? String(payload.approval_notes).slice(0, 4000) : null,
  }, artifacts);
}

async function getAcceptanceMatrices(companies) {
  const ids = companies.map((company) => Number(company.id));
  const [runs, legacy] = await Promise.all([
    listAcceptanceRuns(ids.length === 1 ? { companyId: ids[0] } : {}),
    listLegacyAcceptanceEvidence(ids),
  ]);
  const matrices = [];
  for (const company of companies) {
    const required = await deriveRequiredCapabilities(company.id);
    const binding = companyCredentialBinding(company);
    const accepted = new Set();
    for (const run of runs) {
      if (Number(run.company_id) !== Number(company.id) || run.issuer_vat !== company.vat_number
          || run.credential_binding_sha256 !== binding || run.contract_version !== ACCEPTANCE_CONTRACT_VERSION) continue;
      for (const artifact of run.artifacts) accepted.add(artifact.capability);
    }
    for (const signoff of legacy) {
      if (Number(signoff.company_id) === Number(company.id) && signoff.issuer_vat === company.vat_number
          && signoff.credential_binding_sha256 === binding) {
        accepted.add(signoff.primary_type === '2.1' ? CAPABILITIES.STAY_TPY : CAPABILITIES.STAY_APY);
      }
    }
    const acceptedList = CAPABILITY_ORDER.filter((capability) => accepted.has(capability));
    matrices.push({
      companyId: Number(company.id), companyName: company.company_name,
      required, accepted: acceptedList,
      missing: required.filter((capability) => !accepted.has(capability)),
      credentialBinding: binding,
      contractVersion: ACCEPTANCE_CONTRACT_VERSION,
    });
  }
  return matrices;
}

async function getAcceptanceMatrix(companyId) {
  const company = await getCompanyById(companyId);
  if (!company) throw bad('Company not found', 404);
  return (await getAcceptanceMatrices([company]))[0];
}

module.exports = {
  ACCEPTANCE_CONTRACT_VERSION,
  CAPABILITIES,
  requiredCapabilityKeys,
  deriveRequiredCapabilities,
  createAcceptanceRun,
  getAcceptanceMatrix,
  getAcceptanceMatrices,
  listAcceptanceRuns,
};

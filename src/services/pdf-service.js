'use strict';

const { getDocumentById } = require('../repositories/fiscal-documents');
const { getCompanyById } = require('../repositories/companies');
const { getListingById } = require('../repositories/listings');
const { createDocumentPdf } = require('../pdf/document-pdf');
const { calculateClimateFeePerNight } = require('../mydata-xml');
const { getFiscalPdfArtifact, insertFiscalPdfArtifactOnce } = require('../repositories/fiscal-pdf-artifacts');

function displayDate(value) {
  const [year, month, day] = String(value || '').slice(0, 10).split('-');
  return day && month && year ? `${day}/${month}/${year}` : String(value || '');
}

function sourceOf(document) {
  try { return JSON.parse(document.source_payload || '{}'); } catch { return {}; }
}

function stayLines(document, source, listing) {
  const nights = Number(source.nights || 1);
  const room = source.listingNickname || source.listingName || source.listingId || '';
  const prefix = room ? `${room} - ` : '';
  if (document.document_type === '8.2') {
    const climateConfig = source.climateSnapshot || listing;
    const frozenLines = climateConfig?.unified_takk_policy?.fee_lines;
    const lines = Array.isArray(frozenLines) ? frozenLines.map((line) => {
      const shown = displayDate(line.date);
      const amount = Number(line.amount ?? (Number(line.cents) / 100));
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Frozen TAKK PDF fee line is invalid');
      return { date: shown, description: `${prefix}Τέλος ανθεκτικότητας ${shown}`, charge: amount };
    }) : Array.from({ length: nights }, (_, index) => {
      const date = new Date(`${source.checkIn}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + index);
      const shown = displayDate(date.toISOString());
      const amount = Number(calculateClimateFeePerNight(date.toISOString().slice(0, 10), climateConfig).toFixed(2));
      return { date: shown, description: `${prefix}Τέλος ανθεκτικότητας ${shown}`, charge: amount };
    });
    const lineTotal = Number(lines.reduce((sum, line) => sum + line.charge, 0).toFixed(2));
    if (lineTotal !== Number(Number(document.gross_value).toFixed(2))) {
      throw new Error('TAKK PDF nightly breakdown does not match the transmitted fiscal total');
    }
    return lines;
  }
  if (['5.1', '11.4'].includes(document.document_type)) {
    return [{ date: displayDate(document.issue_date), description: 'Πιστωτικό διαμονής', credit: Number(document.gross_value) }];
  }
  const total = Number(document.gross_value);
  return Array.from({ length: nights }, (_, index) => {
    const date = new Date(`${source.checkIn}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    const value = index === nights - 1
      ? Number((total - Number((total / nights).toFixed(2)) * (nights - 1)).toFixed(2))
      : Number((total / nights).toFixed(2));
    return { date: displayDate(date.toISOString()), description: `${prefix}Υπηρεσίες διαμονής ${displayDate(date.toISOString())}`, vat: '13%', charge: value };
  });
}

function assertDocumentCanHavePdf(document, { allowPendingVerification = false, mark } = {}) {
  if (!document) { const error = new Error('Fiscal document not found'); error.status = 404; throw error; }
  if (document.status !== 'sent' || ![null, undefined, 'none'].includes(document.cancellation_status)) {
    const error = new Error('PDF is unavailable for unsent documents or while cancellation is unresolved'); error.status = 409; throw error;
  }
  const verified = document.verification_status === 'verified'
    || (allowPendingVerification && mark && String(mark) === String(document.mydata_mark));
  if (!document.mydata_mark || !verified) {
    const error = new Error('PDF is available only after myDATA MARK verification'); error.status = 409; throw error;
  }
}

async function buildLiveFiscalDocumentPdfData(document, evidence = {}) {
  const [company, listing] = await Promise.all([getCompanyById(document.company_id), getListingById(document.listing_id)]);
  if (!company || !listing) {
    const error = new Error('Fiscal PDF issuer or listing snapshot source is unavailable'); error.status = 409; throw error;
  }
  const source = sourceOf(document);
  const guest = source.guest || {};
  const isB2B = ['2.1', '5.1'].includes(document.document_type);
  const billingSnapshot = source.billingSnapshot || {};
  const recipient = isB2B
    ? {
        name: billingSnapshot.invoice_counterpart_name || listing.invoice_counterpart_name,
        vat: billingSnapshot.invoice_counterpart_vat_number || listing.invoice_counterpart_vat_number,
        country: billingSnapshot.invoice_counterpart_country || listing.invoice_counterpart_country,
        branch: billingSnapshot.invoice_counterpart_branch ?? listing.invoice_counterpart_branch ?? 0,
      }
    : { name: guest.fullName || guest.name || [guest.firstName, guest.lastName].filter(Boolean).join(' ') || 'Ιδιώτης πελάτης' };
  return {
    documentType: document.document_type,
    brandName: company.pdf_brand_name || company.company_name,
    brandTagline: company.pdf_activity || 'Υπηρεσίες τουριστικού καταλύματος',
    issuer: {
      name: company.company_name,
      activity: company.pdf_activity || 'ΤΟΥΡΙΣΤΙΚΟ ΚΑΤΑΛΥΜΑ',
      address: company.pdf_address,
      vat: company.vat_number,
      taxOffice: company.pdf_tax_office,
      phone: company.pdf_phone,
      email: company.pdf_email,
    },
    recipient,
    stay: {
      guest: recipient.name,
      room: listing.listing_id_guesty,
      checkIn: displayDate(source.checkIn),
      checkOut: displayDate(source.checkOut),
      board: 'RO',
    },
    series: document.series,
    number: document.aa,
    issueDate: displayDate(document.issue_date),
    mark: document.mydata_mark,
    uid: evidence.uid || document.mydata_uid,
    qrUrl: evidence.qrUrl || document.mydata_qr_url,
    lines: stayLines(document, { ...source, listingId: listing.listing_id_guesty }, listing),
    netValue: Number(document.net_value),
    vatRate: 13,
    vatValue: Number(document.vat_amount),
    total: Number(document.gross_value),
    creditTotal: ['5.1', '11.4'].includes(document.document_type) ? Number(document.gross_value) : 0,
    balance: ['5.1', '11.4'].includes(document.document_type) ? -Number(document.gross_value) : Number(document.gross_value),
  };
}

async function prepareFiscalDocumentPdfArtifact(documentId, evidence = {}) {
  const document = await getDocumentById(documentId);
  assertDocumentCanHavePdf(document, {
    allowPendingVerification: evidence.verified === true,
    mark: evidence.mark,
  });
  const renderSnapshot = await buildLiveFiscalDocumentPdfData(document, evidence);
  const pdfBytes = await createDocumentPdf([renderSnapshot]);
  return {
    documentId: document.id,
    companyId: document.company_id,
    mark: document.mydata_mark,
    uid: evidence.uid || document.mydata_uid || null,
    pdfBytes,
    renderSnapshot,
    renderVersion: 'fiscal-pdf-v1',
  };
}

async function archiveVerifiedFiscalDocumentPdf(documentId) {
  const prepared = await prepareFiscalDocumentPdfArtifact(documentId);
  return insertFiscalPdfArtifactOnce(prepared);
}

async function archivedArtifact(documentId) {
  const document = await getDocumentById(documentId);
  assertDocumentCanHavePdf(document);
  const artifact = await getFiscalPdfArtifact(documentId);
  if (!artifact) {
    const error = new Error('PDF has not been archived yet'); error.status = 409; throw error;
  }
  if (Number(artifact.company_id) !== Number(document.company_id)
      || String(artifact.mydata_mark) !== String(document.mydata_mark)) {
    const error = new Error('Archived PDF fiscal identity does not match the document'); error.status = 409; throw error;
  }
  return artifact;
}

async function buildFiscalDocumentPdfData(documentId) {
  const artifact = await archivedArtifact(documentId);
  try { return JSON.parse(artifact.render_snapshot); } catch {
    const error = new Error('Archived PDF render snapshot is invalid'); error.status = 500; throw error;
  }
}

async function renderFiscalDocumentPdf(documentId) {
  return (await archivedArtifact(documentId)).pdf_bytes;
}

module.exports = {
  renderFiscalDocumentPdf,
  buildFiscalDocumentPdfData,
  prepareFiscalDocumentPdfArtifact,
  archiveVerifiedFiscalDocumentPdf,
};

'use strict';

function conflict(message) { return Object.assign(new Error(message), { status: 409 }); }
function dateOnly(value) { return String(value || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] || ''; }
function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) : null;
}

function assertSameFiscalIdentity(document, invoice, returnedUid = null) {
  const header = invoice?.invoiceHeader || {};
  const summary = invoice?.invoiceSummary || {};
  const differences = [];
  if (String(header.series || '') !== String(document.series)) differences.push('series');
  if (Number(header.aa) !== Number(document.aa)) differences.push('aa');
  if (String(header.invoiceType || '') !== String(document.document_type)) differences.push('invoiceType');
  if (dateOnly(header.issueDate) !== dateOnly(document.issue_date)) differences.push('issueDate');
  if (cents(summary.totalGrossValue) !== cents(document.gross_value)) differences.push('totalGrossValue');
  const expectedUid = document.mydata_uid ? String(document.mydata_uid) : null;
  const actualUid = (returnedUid || invoice?.uid) ? String(returnedUid || invoice.uid) : null;
  if (expectedUid && actualUid !== expectedUid) differences.push('uid');
  if (differences.length) throw conflict(`The supplied MARK belongs to a different fiscal document (${differences.join(', ')})`);
}

module.exports = { assertSameFiscalIdentity };

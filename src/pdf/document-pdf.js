'use strict';

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('fs');

function resolveFont(configured, candidates, label) {
  const selected = [configured, ...candidates].filter(Boolean).find((fontPath) => fs.existsSync(fontPath));
  if (!selected) throw new Error(`${label} font was not found; configure the PDF font path`);
  return selected;
}

const FONT = resolveFont(process.env.PDF_FONT_REGULAR, [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
], 'Regular PDF');
const FONT_BOLD = resolveFont(process.env.PDF_FONT_BOLD, [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
], 'Bold PDF');
const PAGE = { width: 595.28, height: 841.89, margin: 48 };

function money(value) {
  return Number(value || 0).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function hasAmount(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function drawRule(doc, y) {
  doc.strokeColor('#C7CED5').lineWidth(0.6).moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).stroke();
}

function drawText(doc, text, x, y, options = {}) {
  doc.fillColor(options.color || '#17212B').font(options.bold ? FONT_BOLD : FONT).fontSize(options.size || 10)
    .text(String(text || ''), x, y, { width: options.width, align: options.align || 'left', lineGap: 1 });
}

function addPage(doc, data) {
  const right = PAGE.width - PAGE.margin;
  const titles = {
    '8.2': 'Τέλος ανθεκτικότητας στην κλιματική κρίση',
    '2.1': 'Τιμολόγιο Παροχής Υπηρεσιών',
    '5.1': 'Πιστωτικό Τιμολόγιο Παροχής Υπηρεσιών',
    '11.4': 'Πιστωτικό Στοιχείο Λιανικής',
    '11.2': 'Απόδειξη Παροχής Υπηρεσιών',
  };
  const title = titles[data.documentType] || 'Φορολογικό παραστατικό';

  // Intentionally neutral: the live product replaces this small wordmark with tenant branding.
  drawText(doc, data.brandName || 'HOSPITALITY BRIDGE', PAGE.margin, 52, { size: 21, bold: true, color: '#174C63' });
  drawText(doc, data.brandTagline || 'Accommodation services', PAGE.margin, 79, { size: 9, color: '#51717D' });

  const issuer = data.issuer || {};
  const issuerLines = [issuer.name, issuer.activity, issuer.address, issuer.vat && `ΑΦΜ: ${issuer.vat}${issuer.taxOffice ? ` - ΔΟΥ: ${issuer.taxOffice}` : ''}`, issuer.phone, issuer.email]
    .filter(Boolean).join('\n');
  drawText(doc, issuerLines, 325, 49, { size: 9.5, width: 222, align: 'right' });
  drawRule(doc, 123);

  const recipient = data.recipient || {};
  drawText(doc, [recipient.name, recipient.vat, recipient.address, recipient.city, recipient.country].filter(Boolean).join('\n'), PAGE.margin, 145, { size: 10, width: 225 });
  const stay = data.stay || {};
  drawText(doc, ['Guest', 'Room', 'Check-In', 'Check-Out', 'Board'].join('\n'), 320, 145, { size: 10, bold: true, width: 72 });
  drawText(doc, [stay.guest, stay.room, stay.checkIn, stay.checkOut, stay.board].map((value) => `: ${value || '-'}`).join('\n'), 395, 145, { size: 10, width: 150 });

  const issued = data.issueDate || '-';
  const documentNumber = [data.series, data.number].filter(Boolean).join(' / ') || '-';
  drawText(doc, `${title} - Invoice : ${documentNumber}`, PAGE.margin, 253, {
    size: data.documentType === '8.2' ? 11.5 : 13,
    bold: true,
    width: 375,
  });
  drawText(doc, issued, 430, 253, { size: 11, align: 'right', width: 117 });
  drawText(doc, `MARK : ${data.mark || '-'}`, PAGE.margin, 274, { size: 9.5 });
  drawRule(doc, 301);

  const columns = { date: 54, description: 130, vat: 390, charges: 445, credit: 507 };
  drawText(doc, 'Date', columns.date, 311, { size: 9, bold: true });
  drawText(doc, 'Description', columns.description, 311, { size: 9, bold: true });
  drawText(doc, 'VAT', columns.vat, 311, { size: 9, bold: true, width: 36, align: 'right' });
  drawText(doc, 'Charges', columns.charges, 311, { size: 9, bold: true, width: 55, align: 'right' });
  drawText(doc, 'Credit', columns.credit, 311, { size: 9, bold: true, width: 40, align: 'right' });
  drawRule(doc, 329);

  let y = 338;
  for (const line of data.lines || []) {
    drawText(doc, line.date, columns.date, y, { size: 9 });
    drawText(doc, line.description, columns.description, y, { size: 9, width: 270 });
    drawText(doc, line.vat || '', columns.vat, y, { size: 9, width: 36, align: 'right' });
    drawText(doc, hasAmount(line.charge) ? money(line.charge) : '-', columns.charges, y, { size: 9, width: 55, align: 'right' });
    drawText(doc, hasAmount(line.credit) ? `-${money(line.credit)}` : '-', columns.credit, y, { size: 9, width: 40, align: 'right' });
    y += 19;
  }
  drawRule(doc, y + 2);
  drawText(doc, 'Total', columns.description, y + 10, { size: 10, bold: true });
  drawText(doc, money(data.total), columns.charges, y + 10, { size: 10, bold: true, width: 55, align: 'right' });
  drawText(doc, hasAmount(data.creditTotal) && Number(data.creditTotal) !== 0 ? `-${money(data.creditTotal)}` : '-', columns.credit, y + 10, { size: 10, bold: true, width: 40, align: 'right' });

  const detailsY = y + 66;
  drawText(doc, 'Amounts in Euro', PAGE.margin, detailsY, { size: 11, bold: true });
  if (data.note) drawText(doc, data.note, PAGE.margin, detailsY + 18, { size: 9.5 });
  drawText(doc, 'Balance', 410, detailsY, { size: 11, bold: true });
  const balance = hasAmount(data.balance) ? Number(data.balance) : Number(data.total || 0) - Number(data.creditTotal || 0);
  drawText(doc, money(balance), 502, detailsY, { size: 11, width: 43, align: 'right' });

  if (data.documentType !== '8.2') {
    drawRule(doc, detailsY + 51);
    drawText(doc, 'Value', 77, detailsY + 60, { size: 9, bold: true });
    drawText(doc, 'VAT', 178, detailsY + 60, { size: 9, bold: true });
    drawText(doc, 'VAT Value', 258, detailsY + 60, { size: 9, bold: true });
    drawText(doc, 'Total', 370, detailsY + 60, { size: 9, bold: true });
    drawRule(doc, detailsY + 78);
    drawText(doc, money(data.netValue), 77, detailsY + 85, { size: 10 });
    drawText(doc, `${data.vatRate || 13} %`, 178, detailsY + 85, { size: 10 });
    drawText(doc, money(data.vatValue), 258, detailsY + 85, { size: 10 });
    drawText(doc, money(data.total), 370, detailsY + 85, { size: 10 });
  }

  const footerY = data.documentType === '8.2' ? detailsY + 55 : detailsY + 135;
  drawRule(doc, footerY);
  drawText(doc, `Πάροχος    ΑΑΔΕ\nURL        mydatapi.aade.gr\nMARK       ${data.mark || '-'}\nUID        ${data.uid || '-'}`, PAGE.margin + 10, footerY + 10, { size: 8.7 });
  if (data.qrBuffer) {
    doc.image(data.qrBuffer, 475, footerY + 9, { width: 58, height: 58 });
  } else {
    drawText(doc, 'QR\nmyDATA', 474, footerY + 16, { size: 11, bold: true, color: '#174C63', width: 55, align: 'center' });
  }
}

async function createDocumentPdf(documents) {
  const preparedDocuments = await Promise.all(documents.map(async (data) => ({
    ...data,
    qrBuffer: data.qrUrl ? await QRCode.toBuffer(data.qrUrl, { type: 'png', width: 180, margin: 1 }) : null,
  })));
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: 'Guesty myDATA document' } });
    const chunks = [];
    pdf.on('data', (chunk) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    for (const data of preparedDocuments) {
      pdf.addPage({ size: 'A4', margin: 0 });
      pdf.x = 0;
      pdf.y = 0;
      addPage(pdf, data);
    }
    pdf.end();
  });
}

module.exports = { createDocumentPdf };

'use strict';

const fs = require('fs');
const path = require('path');
const { createDocumentPdf } = require('../src/pdf/document-pdf');

const issuer = {
  name: 'EXAMPLE HOSPITALITY Μ.Ι.Κ.Ε.',
  activity: 'ΤΟΥΡΙΣΤΙΚΑ ΚΑΤΑΛΥΜΑΤΑ',
  address: 'Θήρα - 84700',
  vat: '099999999',
  taxOffice: 'Θήρας',
  phone: '22860 00000',
  email: 'invoices@example-hospitality.gr',
};

const commonStay = { guest: 'Abbi Haines', room: 'APTSUP', checkIn: '18/06/2026', checkOut: '20/06/2026', board: 'RO' };

async function main() {
  const outputDir = path.resolve(__dirname, '..', 'output', 'pdf');
  fs.mkdirSync(outputDir, { recursive: true });
  const pdf = await createDocumentPdf([
    {
      documentType: '2.1', brandName: 'EXAMPLE HOSPITALITY', brandTagline: 'Accommodation services', issuer,
      recipient: { name: 'Airbnb Ireland UC', vat: 'IE9827384L', address: 'The Watermarque Building, South Lotts Road', city: 'Dublin', country: 'Ireland' },
      stay: commonStay, series: 'ΤΠΥ', number: '87', issueDate: '20/06/2026 09:20', mark: '400014147148628', uid: '6156A61FBBCD669B745A09FB61DB5528ADB3831F',
      lines: [
        { date: '18/06/2026', description: 'APTSUP - Arrangement 18/06/2026', vat: '13%', charge: 201 },
        { date: '19/06/2026', description: 'APTSUP - Arrangement 19/06/2026', vat: '13%', charge: 201 },
        { date: '20/06/2026', description: 'Bank Transfer', credit: 402 },
      ],
      netValue: 355.75, vatRate: 13, vatValue: 46.25, total: 402, creditTotal: 402, balance: 0, note: 'Περιλαμβάνεται Δημοτικός Φόρος 0.50 %',
    },
    {
      documentType: '8.2', brandName: 'EXAMPLE HOSPITALITY', brandTagline: 'Accommodation services', issuer,
      recipient: { name: 'Abbi Haines' }, stay: commonStay, series: 'ΤΑΚΚ', number: '246', issueDate: '20/06/2026 09:20', mark: '400014147148847', uid: '5A561CA22A6458E1C2B6F8F1089ED2BC73885C1E',
      lines: [
        { date: '18/06/2026', description: 'APTSUP - Τέλος ανθεκτικότητας 18/06/2026', charge: 2 },
        { date: '19/06/2026', description: 'APTSUP - Τέλος ανθεκτικότητας 19/06/2026', charge: 2 },
        { date: '20/06/2026', description: 'Bank Transfer', credit: 4 },
      ],
      total: 4, creditTotal: 4, balance: 0,
    },
  ]);
  const outputFile = path.join(outputDir, 'tpy-takk-layout-example.pdf');
  fs.writeFileSync(outputFile, pdf);
  console.log(outputFile);
}

main().catch((error) => { console.error(error); process.exit(1); });

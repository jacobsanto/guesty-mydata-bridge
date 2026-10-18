'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateMyDataXML, generateClimateFeeXML, generateCreditXML } = require('../src/mydata-xml');

const schemas = [
  {
    label: 'AADE production v2.0.1 (official)',
    file: path.resolve(__dirname, '..', 'docs', 'aade-xsd', 'v2.0.1', 'InvoicesDoc-v2.0.1.xsd'),
  },
  {
    label: 'AADE sandbox v2.0.2 (preofficial)',
    file: path.resolve(__dirname, '..', 'docs', 'aade-xsd', 'v2.0.2-preofficial', 'InvoicesDoc-v2.0.2.xsd'),
  },
];
const issuer = { vat_number: '109262634', invoice_series: 'A', property_type: 'apartment' };
const counterpart = { vatNumber: 'IE9827384L', country: 'IE', name: 'Airbnb Ireland UC' };
const stay = { checkIn: '2026-06-18', checkOut: '2026-06-20', nights: 2 };
const samples = {
  'TPY-2.1': generateMyDataXML({ ...stay, financials: { totalGross: 402 }, invoiceCounterpart: counterpart }, { ...issuer, default_invoice_type: '2.1' }, 87),
  'APY-11.2': generateMyDataXML({ ...stay, financials: { totalGross: 278 } }, { ...issuer, default_invoice_type: '11.2' }, 165),
  'TAKK-8.2': generateClimateFeeXML(stay, {
    ...issuer, climate_fee_series: 'TAKK', climate_fee_high: 2, climate_fee_low: 0.5,
    climate_fee_high_category: 24, climate_fee_low_category: 10,
  }, 246),
  'Credit-5.1': generateCreditXML({ invoiceType: '5.1', grossValue: 113, issueDate: '2026-06-21', series: 'TPY-CR', correlatedMark: '400014147148628' }, {
    ...issuer, invoice_counterpart_vat_number: counterpart.vatNumber,
    invoice_counterpart_country: counterpart.country, invoice_counterpart_name: counterpart.name,
  }, 1),
  'Credit-11.4': generateCreditXML({ invoiceType: '11.4', grossValue: 113, issueDate: '2026-06-21', series: 'APY-RL', correlatedMark: '400014147148628' }, issuer, 1),
};

for (const schema of schemas) {
  if (!fs.existsSync(schema.file)) throw new Error(`AADE XSD not found: ${schema.file}`);
}
const probe = spawnSync('xmllint', ['--version'], { encoding: 'utf8' });
if (probe.error?.code === 'ENOENT') throw new Error('xmllint is required for XSD validation');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mydata-xsd-'));
let failed = false;
try {
  for (const schema of schemas) {
    for (const [name, xml] of Object.entries(samples)) {
      const file = path.join(tempDir, `${name}.xml`);
      fs.writeFileSync(file, xml);
      const result = spawnSync('xmllint', ['--noout', '--schema', schema.file, file], { encoding: 'utf8' });
      if (result.status === 0) {
        console.log(`✅ ${name} validates against ${schema.label}`);
      } else {
        failed = true;
        console.error(`❌ ${name} against ${schema.label}\n${result.stderr || result.stdout}`);
      }
    }
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
if (failed) process.exit(1);

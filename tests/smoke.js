'use strict';

/**
 * Smoke test — τρέχει offline, δεν στέλνει τίποτα στην ΑΑΔΕ.
 * Ελέγχει:
 *  1. Database init + tenant insert/query
 *  2. XML generation (σωστή δομή + υπολογισμός κλιματικού τέλους)
 *  3. Idempotency check
 */

require('dotenv').config();
process.env.DB_PATH = '/tmp/bridge_test.db'; // isolated test DB

const {
  initSchema,
  getTenantByListingId,
  findInvoiceByReservationId,
  createInvoiceRecord,
  db,
} = require('../src/database');
const { generateMyDataXML, calculateClimateFeePerNight } = require('../src/mydata-xml');

// ─── Mock Data ────────────────────────────────────────────────────────────────

const MOCK_TENANT = {
  listing_id_guesty: 'lst_TEST001',
  company_name: 'Βίλα Αφροδίτη Μ.Ι.Κ.Ε.',
  vat_number: '012345678',
  aade_user_id: 'test_user_api',
  aade_subscription_key: 'test_subscription_key_abc123',
  property_type: 'villa',
  invoice_series: 'A',
  invoice_counter: 0,
  active: true,
};

const MOCK_RESERVATION = {
  reservationId: 'res_SMOKE001',
  listingId: 'lst_TEST001',
  status: 'checked_out',
  checkIn: '2025-07-10',   // High season → βίλα → €15/βράδυ
  checkOut: '2025-07-15',
  nights: 5,
  financials: {
    totalGross: 800.00,
  },
};

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

async function run() {
  console.log('\n🧪 Guesty→myDATA Bridge — Smoke Tests\n');

  // ── Test 1: Database init ─────────────────────────────────────────────────
  console.log('📦 Test 1: Database schema init');
  await initSchema();
  const hasTenants = await db.schema.hasTable('tenants');
  const hasInvoices = await db.schema.hasTable('invoices');
  assert(hasTenants, 'Πίνακας tenants δημιουργήθηκε');
  assert(hasInvoices, 'Πίνακας invoices δημιουργήθηκε');

  // ── Test 2: Tenant insert & query ────────────────────────────────────────
  console.log('\n👤 Test 2: Tenant insert & lookup');
  await db('tenants').insert(MOCK_TENANT);
  const tenant = await getTenantByListingId('lst_TEST001');
  assert(tenant !== null, 'Tenant βρέθηκε');
  assert(tenant?.vat_number === '012345678', `ΑΦΜ σωστό: ${tenant?.vat_number}`);
  assert(tenant?.property_type === 'villa', `property_type: ${tenant?.property_type}`);

  // ── Test 3: Κλιματικό Τέλος ──────────────────────────────────────────────
  console.log('\n🌡️  Test 3: Κλιματικό Τέλος υπολογισμός');
  const feeHighVilla   = calculateClimateFeePerNight('2025-07-10', 'villa');
  const feeLowVilla    = calculateClimateFeePerNight('2025-01-15', 'villa');
  const feeHighApt     = calculateClimateFeePerNight('2025-08-01', 'apartment');
  const feeLowApt      = calculateClimateFeePerNight('2025-12-01', 'apartment');
  assert(feeHighVilla === 15.00, `Villa high season: €${feeHighVilla} (expected €15)`);
  assert(feeLowVilla  ===  4.00, `Villa low season: €${feeLowVilla} (expected €4)`);
  assert(feeHighApt   === 10.00, `Apartment high season: €${feeHighApt} (expected €10)`);
  assert(feeLowApt    ===  1.50, `Apartment low season: €${feeLowApt} (expected €1.50)`);

  // ── Test 4: XML generation ───────────────────────────────────────────────
  console.log('\n📄 Test 4: XML generation');
  const xml = generateMyDataXML(MOCK_RESERVATION, tenant, 1);
  assert(typeof xml === 'string', 'XML παράχθηκε');
  assert(xml.includes('<vatNumber>012345678</vatNumber>'), 'ΑΦΜ στο XML');
  assert(xml.includes('<invoiceType>11.1</invoiceType>'), 'invoiceType 11.1');
  assert(xml.includes('<vatCategory>7</vatCategory>'), 'vatCategory 7 (0% ΦΠΑ)');
  assert(xml.includes('<feesPercentCategory>9</feesPercentCategory>'), 'feesPercentCategory 9 (κλιματικό)');
  assert(xml.includes('<totalGrossValue>875.00</totalGrossValue>'), 'totalGrossValue: €800 + €75 κλιματικό');
  assert(xml.includes('<invoiceSummary>'), 'invoiceSummary υπάρχει');
  console.log('\n  📋 XML preview (πρώτες 400 χαρακτήρες):');
  console.log('  ' + xml.substring(0, 400).replace(/\n/g, '\n  '));

  // ── Test 5: Idempotency ──────────────────────────────────────────────────
  console.log('\n🔁 Test 5: Idempotency');
  await createInvoiceRecord({
    reservation_id: 'res_SMOKE001',
    listing_id_guesty: 'lst_TEST001',
    vat_number: '012345678',
    invoice_series: 'A',
    invoice_aa: 1,
    net_value: 800.00,
    climate_fee: 75.00,
    total_gross: 875.00,
    status: 'sent',
    mydata_mark: 'MARK_TEST_123456',
  });
  const existing = await findInvoiceByReservationId('res_SMOKE001');
  assert(existing !== null, 'Εγγραφή invoice βρέθηκε');
  assert(existing?.mydata_mark === 'MARK_TEST_123456', `MARK σωστό: ${existing?.mydata_mark}`);
  assert(existing?.status === 'sent', `Status: ${existing?.status}`);

  // ── Results ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(45)}`);
  console.log(`✅ Passed: ${passed} | ❌ Failed: ${failed}`);

  await db.destroy();

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('\n🎉 Όλα τα tests πέρασαν! Το bridge είναι έτοιμο.\n');
  }
}

run().catch((err) => {
  console.error('\n💥 Smoke test crash:', err.message);
  process.exit(1);
});

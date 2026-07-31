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
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fs = require('fs');
const crypto = require('crypto');
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const {
  initSchema,
  getTenantByListingId,
  findInvoiceByReservationId,
  createInvoiceRecord,
  db,
} = require('../src/database');
const { generateMyDataXML, generateClimateFeeXML, generateCreditXML, calculateClimateFeePerNight } = require('../src/mydata-xml');
const { encryptSecret, decryptSecret, reencryptSecret, decryptCompanySecret } = require('../src/security/credentials');
const { handleCreateListing } = require('../src/services/listing-service');
const { handleCreateCompany, handleUpdateCompany } = require('../src/services/company-service');
const { prepareReservationDocuments } = require('../src/services/document-service');
const { executeDailyClose } = require('../src/services/daily-close-service');
const { cancelFiscalDocument, reconcileFiscalDocumentCancellation, resolveCancellationFailure } = require('../src/services/cancellation-service');
const { normalizeGuestyReservation } = require('../src/guesty/normalizer');
const { createCreditDocument } = require('../src/services/credit-service');
const { renderFiscalDocumentPdf, buildFiscalDocumentPdfData } = require('../src/services/pdf-service');
const { handleCreateBillingRule } = require('../src/services/billing-rule-service');
const { scheduledBusinessDate, runScheduledDailyClose } = require('../src/services/daily-close-scheduler');
const { beginRun, finishRun, listRuns, listRunItems } = require('../src/repositories/daily-close');
const { testCompanyMyDataConnection, testConfiguredGuestyConnection } = require('../src/services/connection-service');
const { getReadiness } = require('../src/services/readiness-service');
const { stageReservation, applyFiscalOverride, reopenForReissue, resolveCancellationReview, materializeDueReservations } = require('../src/services/reservation-service');
const { verifyGuestySignature } = require('../src/guesty-webhook');
const { buildCancelInvoiceRequest, buildConnectionTestRequest } = require('../src/mydata-client');
const { credentialFingerprint } = require('../src/guesty/client');
const { getIntegrationToken, saveIntegrationToken } = require('../src/repositories/integration-tokens');
const {
  createNextFinancialProfileVersion, recordCalibrationSample,
  approveFinancialProfile, updateDraftFinancialProfile, getApprovedFinancialProfile,
} = require('../src/repositories/financial-profiles');
const { reconcileUncertainTransmission } = require('../src/services/transmission-reconciliation-service');
const { runGuestyReconciliation } = require('../src/services/guesty-reconciliation-service');
const { createSandboxSignoff } = require('../src/services/sandbox-signoff-service');
const { applyFinancialProfile, calibrateProfile, listObservedChannels } = require('../src/services/financial-profile-service');
const { evaluateFolio } = require('../src/services/financial-rule-engine');
const { claimDocument } = require('../src/repositories/fiscal-documents');

// ─── Mock Data ────────────────────────────────────────────────────────────────

const MOCK_TENANT = {
  listing_id_guesty: 'lst_TEST001',
  company_name: 'Βίλα Αφροδίτη Μ.Ι.Κ.Ε.',
  vat_number: '044800455',
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
  financialProfile: {
    status: 'matched', id: 1, version: 1,
    configHash: 'a'.repeat(64), evidenceHash: 'b'.repeat(64), evidence: [],
  },
  invoiceCounterpart: {
    vatNumber: 'IE9827384L',
    country: 'IE',
    branch: 0,
    name: 'Airbnb Ireland UC',
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
  assert(tenant?.vat_number === '044800455', `ΑΦΜ σωστό: ${tenant?.vat_number}`);
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
  const xml = generateMyDataXML(MOCK_RESERVATION, { ...tenant, default_invoice_type: '2.1' }, 1);
  assert(typeof xml === 'string', 'XML παράχθηκε');
  assert(xml.includes('<vatNumber>044800455</vatNumber>'), 'ΑΦΜ στο XML');
  assert(xml.includes('<invoiceType>2.1</invoiceType>'), 'invoiceType 2.1 (Τιμολόγιο Παροχής)');
  assert(xml.includes('<vatCategory>2</vatCategory>'), 'vatCategory 2 (13% ΦΠΑ)');
  assert(xml.includes('<vatAmount>92.04</vatAmount>'), 'VAT 13% υπολογίζεται από Guesty gross amount');
  assert(xml.includes('<vatNumber>IE9827384L</vatNumber>'), 'OTA counterpart περιλαμβάνεται στο XML');
  assert(xml.includes('<icls:classificationType>E3_561_007</icls:classificationType>'), 'E3_561_007 για έσοδα υπηρεσιών OTA');
  assert(!xml.includes('<feesPercentCategory>'), 'δεν ενσωματώνεται κλιματικό τέλος σε 11.x');
  assert(xml.includes('<totalGrossValue>800.00</totalGrossValue>'), 'totalGrossValue διατηρεί το Guesty gross amount');
  assert(!xml.includes('<correlatedInvoices>'), 'Guesty reservation id δεν γράφεται ως AADE MARK');
  assert(xml.includes('<invoiceSummary>'), 'invoiceSummary υπάρχει');
  assert(xml.includes('<paymentMethodDetails>') && xml.includes('<type>1</type>'), 'διαβιβάζεται επαγγελματικός λογαριασμός πληρωμών ημεδαπής');
  console.log('\n  📋 XML preview (πρώτες 400 χαρακτήρες):');
  console.log('  ' + xml.substring(0, 400).replace(/\n/g, '\n  '));

  let blockedMissingCounterpart = false;
  try {
    generateMyDataXML({ ...MOCK_RESERVATION, invoiceCounterpart: undefined }, { ...tenant, default_invoice_type: '2.1' }, 2);
  } catch (error) {
    blockedMissingCounterpart = error.message.includes('invoiceCounterpart');
  }
  assert(blockedMissingCounterpart, '2.1 μπλοκάρεται όταν λείπει ο OTA αντισυμβαλλόμενος');

  const configuredClimateFee = calculateClimateFeePerNight('2025-07-10', {
    property_type: 'apartment', climate_fee_high: 22.00, climate_fee_low: 6.00,
  });
  assert(configuredClimateFee === 22.00, 'ΤΑΚ υπερισχύει από τη ρύθμιση του συγκεκριμένου καταλύματος');

  const climateXml = generateClimateFeeXML(MOCK_RESERVATION, {
    ...tenant,
    climate_fee_high: 2.00,
    climate_fee_low: 0.50,
    climate_fee_high_category: 27,
    climate_fee_low_category: 30,
  }, 252);
  assert(climateXml.includes('<invoiceType>8.2</invoiceType>'), 'ΤΑΚΚ δημιουργείται ως χωριστό παραστατικό 8.2');
  assert(climateXml.includes('<otherTaxesPercentCategory>27</otherTaxesPercentCategory>'), 'ΤΑΚΚ χρησιμοποιεί την ανά-κατάλυμα AADE κατηγορία');
  assert(climateXml.includes('<totalOtherTaxesAmount>10.00</totalOtherTaxesAmount>'), 'ΤΑΚΚ αθροίζει τις νύχτες χωριστά από την ΑΠΥ/ΤΠΥ');
  const retailXml = generateMyDataXML({ ...MOCK_RESERVATION, invoiceCounterpart: undefined }, { ...tenant, default_invoice_type: '11.2' }, 3);
  assert(retailXml.includes('<icls:classificationType>E3_561_003</icls:classificationType>'), 'ΑΠΥ λιανικής χρησιμοποιεί E3_561_003');

  // ── Test 5: Idempotency ──────────────────────────────────────────────────
  console.log('\n🔁 Test 5: Idempotency');
  await createInvoiceRecord({
    reservation_id: 'res_SMOKE001',
    listing_id_guesty: 'lst_TEST001',
    vat_number: '044800455',
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

  // ── Test 6: Credential encryption ───────────────────────────────────────
  console.log('\n🔐 Test 6: Credential encryption');
  const encrypted = encryptSecret('aade_subscription_key_123');
  assert(encrypted.startsWith('enc:v1:'), 'credential αποθηκεύεται κρυπτογραφημένο');
  assert(decryptSecret(encrypted) === 'aade_subscription_key_123', 'credential αποκρυπτογραφείται μόνο για κλήση ΑΑΔΕ');
  const originalEncryptionKey = process.env.DATA_ENCRYPTION_KEY;
  const rotatedEncryptionKey = Buffer.alloc(32, 8).toString('base64');
  process.env.DATA_ENCRYPTION_KEY_PREVIOUS = originalEncryptionKey;
  process.env.DATA_ENCRYPTION_KEY = rotatedEncryptionKey;
  assert(decryptSecret(encrypted) === 'aade_subscription_key_123', 'κατά την περιστροφή το προηγούμενο κλειδί αποκρυπτογραφεί μόνο προσωρινά');
  const reencrypted = reencryptSecret(encrypted);
  delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
  assert(decryptSecret(reencrypted) === 'aade_subscription_key_123' && reencrypted !== encrypted, 'migration επανακρυπτογραφεί με το νέο κλειδί πριν αφαιρεθεί το προηγούμενο');
  process.env.DATA_ENCRYPTION_KEY = originalEncryptionKey;

  let rejectedInvalidIssuerVat = false;
  try {
    await handleCreateCompany({
      company_name: 'Invalid VAT Company', vat_number: '987654321',
      aade_user_id: 'invalid_user', aade_subscription_key: 'invalid_key',
    });
  } catch (error) { rejectedInvalidIssuerVat = error.status === 400 && error.message.includes('valid 9-digit'); }
  assert(rejectedInvalidIssuerVat, 'η εταιρεία απορρίπτεται όταν το ελληνικό ΑΦΜ έχει λάθος ψηφίο ελέγχου');

  const securedCompany = await handleCreateCompany({
    company_name: 'Secured Company Μ.Ι.Κ.Ε.',
    vat_number: '109262634',
    aade_user_id: 'secured_user',
    aade_subscription_key: 'secured_key',
    invoice_series: 'B',
  });
  const securedRow = await db('companies').where({ id: securedCompany.id }).first();
  assert(securedRow.aade_subscription_key.startsWith('enc:v2:'), 'admin company key δεν μένει plaintext και δεσμεύεται στο ΑΦΜ/πεδίο');
  assert(decryptCompanySecret(securedRow, 'aade_subscription_key') === 'secured_key', 'το company-bound credential αποκρυπτογραφείται μόνο στο σωστό tenant context');
  let crossFieldSwapBlocked = false;
  try { decryptCompanySecret({ ...securedRow, aade_subscription_key: securedRow.aade_user_id }, 'aade_subscription_key'); } catch { crossFieldSwapBlocked = true; }
  assert(crossFieldSwapBlocked, 'αντιγραφή ciphertext από AADE user στο subscription-key πεδίο απορρίπτεται');
  let crossTenantSwapBlocked = false;
  try { decryptCompanySecret({ ...securedRow, vat_number: MOCK_TENANT.vat_number }, 'aade_subscription_key'); } catch { crossTenantSwapBlocked = true; }
  assert(crossTenantSwapBlocked, 'αντιγραφή ciphertext σε διαφορετικό ΑΦΜ απορρίπτεται');

  // ── Test 7: Listing mapping guard ────────────────────────────────────────
  console.log('\n🏠 Test 7: Listing mapping guard');
  let rejectedUnknownCompany = false;
  try {
    await handleCreateListing({
      company_id: 99999,
      listing_id_guesty: 'lst_UNKNOWN_COMPANY',
      property_type: 'villa',
      climate_fee_high: 15,
      climate_fee_low: 4,
      climate_fee_high_category: 27,
      climate_fee_low_category: 30,
    });
  } catch (error) {
    rejectedUnknownCompany = error.status === 404;
  }
  assert(rejectedUnknownCompany, 'listing δεν μπορεί να αντιστοιχιστεί σε ανύπαρκτη εταιρεία');
  let rejectedMissingClimateConfig = false;
  try {
    await handleCreateListing({ company_id: securedCompany.id, listing_id_guesty: 'lst_NO_TAKK_CONFIG', property_type: 'apartment' });
  } catch (error) { rejectedMissingClimateConfig = error.status === 400 && error.message.includes('climate_fee_high'); }
  assert(rejectedMissingClimateConfig, 'κάθε κατάλυμα απαιτεί ρητή ρύθμιση ΤΑΚΚ πριν ενεργοποιηθεί');
  let rejectedInvalidGreekCounterpart = false;
  try {
    await handleCreateListing({
      company_id: securedCompany.id, listing_id_guesty: 'lst_BAD_COUNTERPART', property_type: 'apartment',
      default_invoice_type: '2.1', invoice_counterpart_vat_number: '123456780', invoice_counterpart_country: 'GR',
      climate_fee_high: 2, climate_fee_low: 0.5, climate_fee_high_category: 24, climate_fee_low_category: 10,
    });
  } catch (error) { rejectedInvalidGreekCounterpart = error.status === 400 && error.message.includes('checksum'); }
  assert(rejectedInvalidGreekCounterpart, 'το ελληνικό ΑΦΜ αντισυμβαλλομένου ελέγχεται πριν δημιουργηθεί ΤΠΥ');
  let rejectedInvalidBranches = 0;
  for (const [index, branch] of [-1, 1.5, '1e2', 2147483648].entries()) {
    try {
      await handleCreateListing({
        company_id: securedCompany.id, listing_id_guesty: `lst_BAD_BRANCH_${index}`, property_type: 'apartment',
        default_invoice_type: '2.1', invoice_counterpart_vat_number: 'IE9827384L', invoice_counterpart_country: 'IE',
        invoice_counterpart_branch: branch,
        climate_fee_high: 2, climate_fee_low: 0.5, climate_fee_high_category: 24, climate_fee_low_category: 10,
      });
    } catch (error) { if (error.status === 400) rejectedInvalidBranches += 1; }
  }
  assert(rejectedInvalidBranches === 4, 'το υποκατάστημα αντισυμβαλλομένου δέχεται μόνο ακέραιο AADE branch 0–2147483647');
  let rejectedShortTermTakkCategory = false;
  try {
    await handleCreateListing({
      company_id: securedCompany.id, listing_id_guesty: 'lst_SHORT_TERM_CATEGORY', property_type: 'apartment',
      climate_fee_high: 2, climate_fee_low: 0.5, climate_fee_high_category: 25, climate_fee_low_category: 28,
    });
  } catch (error) { rejectedShortTermTakkCategory = error.status === 400; }
  assert(rejectedShortTermTakkCategory, 'οι κατηγορίες ΤΑΚΚ βραχυχρόνιας μίσθωσης αποκλείονται από τα δικά μας καταλύματα');

  // ── Test 8: Fiscal document queue ───────────────────────────────────────
  console.log('\n🧾 Test 8: ΑΠΥ/ΤΠΥ + χωριστό ΤΑΚΚ στην ουρά');
  const securedListing = await handleCreateListing({
    company_id: securedCompany.id,
    listing_id_guesty: 'lst_QUEUE_TEST',
    property_type: 'apartment',
    default_invoice_type: '2.1',
    invoice_counterpart_vat_number: 'IE9827384L',
    invoice_counterpart_country: 'IE',
    invoice_counterpart_name: 'Airbnb Ireland UC',
    invoice_counterpart_branch: 59,
    climate_fee_high: 2,
    climate_fee_low: 0.5,
    climate_fee_high_category: 24,
    climate_fee_low_category: 10,
    climate_fee_series: 'TAKK',
  });
  const billingContext = {
    ...securedRow,
    company_id: securedCompany.id,
    listing_id: securedListing.id,
    listing_id_guesty: securedListing.listing_id_guesty,
    default_invoice_type: securedListing.default_invoice_type,
    invoice_counterpart_vat_number: securedListing.invoice_counterpart_vat_number,
    invoice_counterpart_country: securedListing.invoice_counterpart_country,
    invoice_counterpart_name: securedListing.invoice_counterpart_name,
    invoice_counterpart_branch: securedListing.invoice_counterpart_branch,
    property_type: securedListing.property_type,
    climate_fee_high: securedListing.climate_fee_high,
    climate_fee_low: securedListing.climate_fee_low,
    climate_fee_high_category: securedListing.climate_fee_high_category,
    climate_fee_low_category: securedListing.climate_fee_low_category,
    climate_fee_series: securedListing.climate_fee_series,
  };
  const queuedReservation = {
    ...MOCK_RESERVATION,
    reservationId: 'res_QUEUE001',
    listingId: 'lst_QUEUE_TEST',
    invoiceCounterpart: undefined,
    stayEvidence: {
      reservationListingId: 'lst_QUEUE_TEST', folioListingId: 'lst_QUEUE_TEST',
      lineListingIds: [], stayIndexes: [], singleStayConfirmed: true,
    },
  };
  await stageReservation(queuedReservation, billingContext);
  const firstQueue = await prepareReservationDocuments(queuedReservation, billingContext);
  const secondQueue = await prepareReservationDocuments(queuedReservation, billingContext);
  await db('reservation_snapshots').where({ reservation_id: queuedReservation.reservationId }).update({ materialized_at: db.fn.now() });
  const queuedRows = await db('fiscal_documents').where({ reservation_id: 'res_QUEUE001' }).orderBy('id');
  assert(queuedRows.length === 2, 'μία κράτηση δημιουργεί ακριβώς δύο παραστατικά');
  assert(queuedRows.some((row) => row.document_type === '2.1'), 'το κύριο παραστατικό είναι ΤΠΥ 2.1');
  assert(queuedRows.find((row) => row.document_type === '2.1').xml_payload.includes('<branch>59</branch>'), 'το ΤΠΥ διατηρεί το ρυθμισμένο υποκατάστημα αντισυμβαλλομένου');
  assert(queuedRows.every((row) => row.target_environment === 'sandbox'), 'κάθε queued παραστατικό δεσμεύεται αμετάβλητα στο sandbox περιβάλλον δημιουργίας');
  const targetGuardPreviousEnv = process.env.MYDATA_ENV;
  process.env.MYDATA_ENV = 'production';
  const crossEnvironmentClaim = await claimDocument(queuedRows[0].id);
  if (targetGuardPreviousEnv === undefined) delete process.env.MYDATA_ENV; else process.env.MYDATA_ENV = targetGuardPreviousEnv;
  assert(crossEnvironmentClaim === null, 'sandbox queued παραστατικό δεν μπορεί να γίνει claim από production runtime');
  assert(queuedRows.some((row) => row.document_type === '8.2'), 'το ΤΑΚΚ είναι ανεξάρτητο 8.2');
  assert(firstQueue.primary.created && firstQueue.climate.created, 'η πρώτη παραλαβή δημιουργεί τα παραστατικά');
  assert(!secondQueue.primary.created && !secondQueue.climate.created, 'duplicate Guesty event δεν διπλοεκδίδει');

  // ── Test 9: Daily close ─────────────────────────────────────────────────
  console.log('\n🌙 Test 9: Ημερήσιο κλείσιμο και επιβεβαίωση MARK');
  let sentCalls = 0;
  const fakeSender = async () => {
    sentCalls += 1;
    return { mark: `40000000000000${sentCalls}`, uid: `UID_${sentCalls}`, qrUrl: `https://example.test/qr/${sentCalls}`, raw: { ok: true } };
  };
  let verificationCalls = 0;
  const fakeVerifier = async (mark) => {
    verificationCalls += 1;
    return { verified: true, mark };
  };
  const closeRun = await executeDailyClose({
    companyId: securedCompany.id,
    businessDate: '2025-07-15',
    sender: fakeSender,
    verifier: fakeVerifier,
  });
  const sentRows = await db('fiscal_documents').where({ reservation_id: 'res_QUEUE001', status: 'sent' });
  assert(closeRun.status === 'completed' && closeRun.sent_count === 2, 'το κλείσιμο έστειλε και τα δύο παραστατικά');
  assert(sentRows.length === 2 && sentRows.every((row) => row.mydata_mark && row.mydata_uid), 'αποθηκεύτηκαν MARK και UID ανά παραστατικό');
  assert(sentRows.every((row) => row.verification_status === 'verified') && verificationCalls === 2, 'κάθε MARK επιβεβαιώθηκε μέσω RequestTransmittedDocs');
  const closeHistory = await listRuns({ companyId: securedCompany.id });
  const closeItems = await listRunItems(closeRun.id);
  assert(closeHistory[0].business_date === '2025-07-15' && closeItems.length === 2, 'το ιστορικό κλεισίματος διατηρεί αποτέλεσμα ανά παραστατικό');
  await executeDailyClose({ companyId: securedCompany.id, businessDate: '2025-07-15', sender: fakeSender, verifier: fakeVerifier });
  assert(sentCalls === 2, 'δεύτερο κλείσιμο δεν ξαναστέλνει επιβεβαιωμένα παραστατικά');

  // ── Test 10: Cancellation lifecycle ─────────────────────────────────────
  console.log('\n↩️  Test 10: Ακύρωση διαβιβασμένου MARK');
  const documentToCancel = sentRows.find((row) => row.document_type === '8.2');
  let cancelledMarkInput = null;
  let cancellationCalls = 0;
  const canceller = async (mark) => {
    cancellationCalls += 1;
    cancelledMarkInput = mark;
    await Promise.resolve();
    return { cancellationMark: '900000000000001' };
  };
  const concurrentCancellations = await Promise.allSettled([
    cancelFiscalDocument({ documentId: documentToCancel.id, canceller }),
    cancelFiscalDocument({ documentId: documentToCancel.id, canceller }),
  ]);
  const cancelled = concurrentCancellations.find((result) => result.status === 'fulfilled')?.value;
  assert(cancelledMarkInput === documentToCancel.mydata_mark, 'η ΑΑΔΕ ακύρωση λαμβάνει το MARK του αρχικού παραστατικού');
  assert(cancelled.status === 'cancelled' && cancelled.cancellation_mark === '900000000000001', 'αποθηκεύεται το cancellation MARK');
  assert(cancellationCalls === 1, 'δύο ταυτόχρονες ακυρώσεις στέλνουν μόνο ένα CancelInvoice');
  const verifiedCancellation = await reconcileFiscalDocumentCancellation({
    documentId: documentToCancel.id,
    verifier: async (invoiceMark) => ({
      verified: true, invoiceMark, cancellationMark: '900000000000001', raw: { cancellationMark: '900000000000001' },
    }),
  });
  assert(verifiedCancellation.cancellation_verification_status === 'verified', 'το cancellation MARK επιβεβαιώνεται χωριστά με RequestTransmittedDocs');

  // ── Test 11: Official Guesty payload normalization ──────────────────────
  console.log('\n🔌 Test 11: Κανονικοποίηση επίσημου Guesty webhook payload');
  const normalizedGuesty = normalizeGuestyReservation({
    event: 'reservation.new',
    reservation: {
      _id: '65f2d1599824d7e6ff852881',
      listingId: 'lst_QUEUE_TEST',
      status: 'confirmed',
      source: 'airbnb2',
      checkInDateLocalized: '2025-07-10',
      checkOutDateLocalized: '2025-07-12',
      fiscalCurrency: 'EUR',
      fiscalFolioOverview: { reservationId: '65f2d1599824d7e6ff852881', listingId: 'lst_QUEUE_TEST', platform: 'airbnb2', source: 'airbnb2', currency: 'EUR' },
      fiscalInvoiceItems: [
        { id: 'af-webhook', normalType: 'AF', title: 'Accommodation fare', totalPrice: 246.02, listingId: 'lst_QUEUE_TEST', stayIndex: 0 },
        { id: 'vat-webhook', normalType: 'VAT', title: 'VAT', totalPrice: 31.98, listingId: 'lst_QUEUE_TEST', stayIndex: 0 },
        { id: 'ct-webhook', normalType: 'CT', title: 'LOCAL_TAX', totalPrice: 4, listingId: 'lst_QUEUE_TEST', stayIndex: 0 },
      ],
      money: {
        currency: 'EUR',
        invoiceItems: [
          { title: 'Accommodation fare', amount: 246.02, isTax: false },
          { title: 'VAT', amount: 31.98, isTax: true },
          { title: 'LOCAL_TAX', amount: 4, isTax: true },
        ],
      },
    },
  });
  assert(normalizedGuesty.nights === 2, 'οι νύχτες προκύπτουν από localized ημερομηνίες');
  assert(normalizedGuesty.financials.totalGross === 278, 'το φορολογητέο gross περιλαμβάνει ΦΠΑ αλλά όχι το χωριστό ΤΑΚΚ');
  assert(normalizedGuesty.stayEvidence.singleStayConfirmed === true, 'reservation, folio και line evidence επιβεβαιώνουν ρητά ένα fiscal stay');
  const normalizedWhitespaceChannel = normalizeGuestyReservation({
    ...normalizedGuesty,
    _id: 'res_CHANNEL_SPACE',
    reservationId: 'res_CHANNEL_SPACE',
    checkInDateLocalized: normalizedGuesty.checkIn,
    checkOutDateLocalized: normalizedGuesty.checkOut,
    fiscalCurrency: 'EUR',
    fiscalFolioOverview: {
      reservationId: 'res_CHANNEL_SPACE', listingId: normalizedGuesty.listingId,
      platform: ' Booking   Engine ', source: ' Direct   Web ', currency: 'EUR',
    },
    fiscalInvoiceItems: normalizedGuesty.fiscalInvoiceItems,
  });
  assert(normalizedWhitespaceChannel.platformKey === 'booking engine' && normalizedWhitespaceChannel.sourceKey === 'direct web', 'τα Guesty platform/source canonicalize με τον ίδιο τρόπο σε onboarding και issuance');
  const authoritativeFolio = normalizeGuestyReservation({
    _id: 'res_FOLIO_PRIORITY', listingId: 'lst_QUEUE_TEST', status: 'confirmed',
    checkInDateLocalized: '2025-07-10', checkOutDateLocalized: '2025-07-12', fiscalCurrency: 'EUR',
    financials: { totalGross: 999 },
    fiscalFolioOverview: { reservationId: 'res_FOLIO_PRIORITY', listingId: 'lst_QUEUE_TEST', platform: 'airbnb2', source: 'airbnb2', currency: 'EUR' },
    fiscalInvoiceItems: [
      { id: 'af', normalType: 'AF', totalPrice: 246.02 },
      { id: 'vat', normalType: 'VAT', totalPrice: 31.98 },
      { id: 'ct', normalType: 'CT', totalPrice: 4 },
    ],
  });
  assert(authoritativeFolio.financials.totalGross === 278 && authoritativeFolio.financials.amountSource === 'guest_folio_invoice_items', 'το Guest Folio υπερισχύει από ευρύτερο financials.totalGross');
  let emptyFolioBlocked = false;
  try {
    normalizeGuestyReservation({
      _id: 'res_EMPTY_FOLIO', listingId: 'lst_QUEUE_TEST', status: 'confirmed',
      checkInDateLocalized: '2025-07-10', checkOutDateLocalized: '2025-07-12', fiscalCurrency: 'EUR',
      fiscalFolioOverview: { reservationId: 'res_EMPTY_FOLIO', listingId: 'lst_QUEUE_TEST', platform: 'airbnb2', source: 'airbnb2', currency: 'EUR' },
      financials: { totalGross: 999 }, fiscalInvoiceItems: [],
    });
  } catch (error) { emptyFolioBlocked = error.message.includes('invoice items are empty'); }
  assert(emptyFolioBlocked, 'κενό authoritative Guest Folio οδηγεί σε review και όχι σε έκδοση λανθασμένου ποσού');
  let inconsistentNightsBlocked = false;
  try {
    normalizeGuestyReservation({
      _id: 'res_BAD_NIGHTS', listingId: 'lst_QUEUE_TEST', status: 'confirmed', nights: 3,
      checkInDateLocalized: '2025-07-10', checkOutDateLocalized: '2025-07-12', fiscalCurrency: 'EUR',
      fiscalFolioOverview: { reservationId: 'res_BAD_NIGHTS', listingId: 'lst_QUEUE_TEST', platform: 'manual', source: 'manual', currency: 'EUR' },
      fiscalInvoiceItems: [{ id: 'bad-nights-af', normalType: 'AF', totalPrice: 113 }],
    });
  } catch (error) { inconsistentNightsBlocked = error.message.includes('nights do not match'); }
  assert(inconsistentNightsBlocked, 'ασυμφωνία Guesty nights και localized ημερομηνιών μπλοκάρει και το ΤΑΚΚ');

  // ── Test 12: Credit document ────────────────────────────────────────────
  console.log('\n🧮 Test 12: Συσχετιζόμενο πιστωτικό ΤΠΥ');
  const originalTpy = sentRows.find((row) => row.document_type === '2.1');
  let definitiveFailure;
  let cancellationFailureRecorded = false;
  try {
    await cancelFiscalDocument({ documentId: originalTpy.id, canceller: async () => {
      throw new Error('explicit AADE rejection');
    } });
  } catch {
    definitiveFailure = await db('fiscal_documents').where({ id: originalTpy.id }).first();
    cancellationFailureRecorded = definitiveFailure.status === 'sent' && definitiveFailure.cancellation_status === 'failed'
      && !definitiveFailure.cancellation_retryable && !definitiveFailure.cancellation_uncertain;
  }
  assert(cancellationFailureRecorded, 'αποτυχία CancelInvoice κρατά το αρχικό παραστατικό sent και απαιτεί επίλυση πριν από πιστωτικό');
  const resolutionKey = 'smoke-retain-active-001';
  const resolution = await resolveCancellationFailure({
    documentId: originalTpy.id,
    decision: 'retain_active',
    reason: 'Ο λογιστής επιβεβαίωσε ότι το αρχικό παραμένει ενεργό',
    resolvedBy: 'Smoke Test Accountant',
    expectedUpdatedAt: definitiveFailure.updated_at,
    idempotencyKey: resolutionKey,
    adminKeyFingerprint: 'a'.repeat(64),
    verifier: async (invoiceMark) => ({ verified: false, notFound: true, invoiceMark }),
  });
  const idempotentResolution = await resolveCancellationFailure({
    documentId: originalTpy.id,
    decision: 'retain_active',
    reason: 'Ο λογιστής επιβεβαίωσε ότι το αρχικό παραμένει ενεργό',
    resolvedBy: 'Smoke Test Accountant',
    expectedUpdatedAt: definitiveFailure.updated_at,
    idempotencyKey: resolutionKey,
    adminKeyFingerprint: 'a'.repeat(64),
    verifier: async () => { throw new Error('idempotent resolution must not recheck myDATA'); },
  });
  assert(resolution.document.status === 'sent' && resolution.document.cancellation_status === 'none'
    && resolution.event.decision === 'retain_active' && idempotentResolution.idempotent,
  'οριστική απόρριψη CancelInvoice επιλύεται μόνο με fresh myDATA check και append-only idempotent audit event');
  let invalidCreditInputBlocked = 0;
  for (const input of [
    { grossValue: 1.001, issueDate: '2025-07-16', reference: 'bad-decimals' },
    { grossValue: 1, issueDate: '2025-02-30', reference: 'bad-date' },
    { grossValue: 1, issueDate: '2025-07-16', reference: 'X'.repeat(81) },
  ]) {
    try { await createCreditDocument({ documentId: originalTpy.id, ...input }); } catch (error) { if (error.status === 400) invalidCreditInputBlocked += 1; }
  }
  assert(invalidCreditInputBlocked === 3, 'πιστωτικό απορρίπτει υποδεκαδικά λεπτά, ανύπαρκτη ημερομηνία και υπερβολική αναφορά');
  const creditResult = await createCreditDocument({
    documentId: originalTpy.id,
    grossValue: 113,
    issueDate: '2025-07-16',
    reference: 'refund-1',
  });
  assert(creditResult.document.document_type === '5.1', 'το πιστωτικό ΤΠΥ έχει τύπο 5.1');
  assert(creditResult.document.correlated_mark === originalTpy.mydata_mark, 'το πιστωτικό αποθηκεύει το MARK συσχέτισης');
  assert(creditResult.document.xml_payload.includes(`<correlatedInvoices>${originalTpy.mydata_mark}</correlatedInvoices>`), 'το XML 5.1 περιέχει το αρχικό MARK');
  assert(creditResult.document.xml_payload.includes('<branch>59</branch>'), 'το πιστωτικό 5.1 κληρονομεί το υποκατάστημα του αρχικού ΤΠΥ');
  const creditSource = JSON.parse(creditResult.document.source_payload);
  assert(creditSource.billingSnapshot?.invoice_counterpart_vat_number === 'IE9827384L', 'το πιστωτικό διατηρεί το fiscal snapshot του αρχικού ΤΠΥ');
  assert(creditSource.billingSnapshot?.invoice_counterpart_branch === 59, 'το fiscal snapshot παγώνει το υποκατάστημα πριν από μεταγενέστερες αλλαγές ρυθμίσεων');

  // ── Test 13: PDF only after MARK ────────────────────────────────────────
  console.log('\n🖨️  Test 13: Τελικό PDF μετά το MARK');
  const pdfBuffer = await renderFiscalDocumentPdf(originalTpy.id);
  assert(Buffer.isBuffer(pdfBuffer) && pdfBuffer.subarray(0, 4).toString() === '%PDF', 'παράγεται έγκυρο PDF για επιβεβαιωμένο παραστατικό');
  await handleUpdateCompany(securedCompany.id, {
    pdf_brand_name: 'TEST STAY', pdf_activity: 'ΕΝΟΙΚΙΑΖΟΜΕΝΑ ΔΩΜΑΤΙΑ',
    pdf_address: 'Θήρα 84700', pdf_tax_office: 'Θήρας', pdf_phone: '2286000000', pdf_email: 'billing@example.test',
  });
  const pdfData = await buildFiscalDocumentPdfData(originalTpy.id);
  assert(pdfData.brandName === 'TEST STAY' && pdfData.issuer.address === 'Θήρα 84700', 'το PDF χρησιμοποιεί το branded προφίλ της εταιρείας');
  assert(pdfData.recipient.vat === 'IE9827384L', 'το ΤΠΥ PDF κρατά τον αντισυμβαλλόμενο του billing snapshot');
  assert(pdfData.creditTotal === 0 && pdfData.balance === Number(originalTpy.gross_value), 'το PDF δεν επινοεί εξόφληση όταν δεν υπάρχει πληροφορία πληρωμής');
  assert(pdfData.lines.every((line) => !Object.hasOwn(line, 'credit')), 'οι πραγματικές γραμμές PDF δεν προσθέτουν πλασματική πίστωση');
  const seasonalDocuments = await prepareReservationDocuments({
    ...queuedReservation,
    reservationId: 'res_SEASONAL_TAKK_PDF',
    checkIn: '2025-10-31', checkOut: '2025-11-02', nights: 2,
  }, billingContext);
  const seasonalTakkId = seasonalDocuments.climate.document.id;
  await db('fiscal_documents').where({ id: seasonalTakkId }).update({
    status: 'sent', verification_status: 'verified', mydata_mark: '400000000099901', mydata_uid: 'UID-SEASONAL-TAKK',
  });
  const seasonalTakkPdf = await buildFiscalDocumentPdfData(seasonalTakkId);
  assert(seasonalTakkPdf.lines.map((line) => line.charge).join(',') === '2,0.5' && seasonalTakkPdf.total === 2.5, 'το ΤΑΚΚ PDF κρατά το πραγματικό υψηλό/χαμηλό ποσό κάθε νύχτας όταν αλλάζει περίοδος');
  await db('fiscal_documents').where({ reservation_id: 'res_SEASONAL_TAKK_PDF' }).update({ status: 'cancelled', cancellation_status: 'cancelled' });
  let blockedPendingPdf = false;
  try { await renderFiscalDocumentPdf(creditResult.document.id); } catch (error) { blockedPendingPdf = error.status === 409; }
  assert(blockedPendingPdf, 'δεν εκδίδεται τελικό PDF πριν επιστρέψει MARK');

  // ── Test 14: Verification retry never resubmits ─────────────────────────
  console.log('\n🔎 Test 14: Retry επιβεβαίωσης χωρίς διπλή διαβίβαση');
  let creditSendCalls = 0;
  const creditSender = async () => {
    creditSendCalls += 1;
    return { mark: '400000000000101', uid: 'UID_CREDIT_1', raw: { ok: true } };
  };
  const failedVerificationRun = await executeDailyClose({
    companyId: securedCompany.id,
    businessDate: '2025-07-16',
    sender: creditSender,
    verifier: async (mark) => ({ verified: false, mark }),
  });
  assert(failedVerificationRun.status === 'failed' && failedVerificationRun.failed_count === 1 && creditSendCalls === 1, 'αποτυχία verification κρατά το κλείσιμο ανοικτό χωρίς απώλεια του MARK');
  await executeDailyClose({
    companyId: securedCompany.id,
    businessDate: '2025-07-16',
    sender: creditSender,
    verifier: async (mark) => ({ verified: true, mark }),
  });
  const verifiedCredit = await db('fiscal_documents').where({ id: creditResult.document.id }).first();
  assert(creditSendCalls === 1 && verifiedCredit.verification_status === 'verified', 'το επόμενο κλείσιμο επαληθεύει χωρίς να ξαναστείλει το πιστωτικό');
  let excessiveCreditBlocked = false;
  try {
    await createCreditDocument({ documentId: originalTpy.id, grossValue: 700, issueDate: '2025-07-17', reference: 'refund-too-large' });
  } catch (error) { excessiveCreditBlocked = error.status === 409; }
  assert(excessiveCreditBlocked, 'το σωρευτικό ποσό πιστωτικών δεν ξεπερνά το αρχικό παραστατικό');
  const concurrentCredits = await Promise.allSettled([
    createCreditDocument({ documentId: originalTpy.id, grossValue: 400, issueDate: '2025-07-18', reference: 'concurrent-a' }),
    createCreditDocument({ documentId: originalTpy.id, grossValue: 400, issueDate: '2025-07-18', reference: 'concurrent-b' }),
  ]);
  const concurrentSuccesses = concurrentCredits.filter((result) => result.status === 'fulfilled').length;
  const creditedAfterRace = await db('fiscal_documents').where({ related_document_id: originalTpy.id }).whereNot({ status: 'cancelled' }).sum({ total: 'gross_value' }).first();
  assert(concurrentSuccesses === 1 && Number(creditedAfterRace.total) === 513, 'ταυτόχρονα πιστωτικά σειριοποιούνται και δεν υπερβαίνουν το αρχικό ποσό');

  // ── Test 15: Per-channel APY/TPY rules ──────────────────────────────────
  console.log('\n🧭 Test 15: ΑΠΥ/ΤΠΥ ανά Guesty source στο ίδιο κατάλυμα');
  let rejectedLongSeries = false;
  try {
    await handleCreateBillingRule({ listing_id: securedListing.id, guesty_platform: 'manual', guesty_source: 'bad-series', invoice_type: '11.2', series: 'X'.repeat(51) });
  } catch (error) { rejectedLongSeries = error.status === 400 && error.message.includes('<= 50'); }
  assert(rejectedLongSeries, 'η σειρά παραστατικού ελέγχεται πριν δεσμευτεί ΑΑ');
  let rejectedUnknownCountry = false;
  try {
    await handleCreateBillingRule({
      listing_id: securedListing.id, guesty_platform: 'manual', guesty_source: 'bad-country', invoice_type: '2.1',
      counterpart_vat_number: 'IE9827384L', counterpart_country: 'ZZ', counterpart_name: 'Invalid Country',
    });
  } catch (error) { rejectedUnknownCountry = error.status === 400 && error.message.includes('accepted by AADE'); }
  assert(rejectedUnknownCountry, 'η χώρα αντισυμβαλλομένου περιορίζεται στους κωδικούς που δέχεται η ΑΑΔΕ');
  await handleCreateBillingRule({ listing_id: securedListing.id, guesty_platform: 'manual', guesty_source: 'manual', invoice_type: '11.2', series: 'APY' });
  await handleCreateBillingRule({
    listing_id: securedListing.id, guesty_platform: 'bookingcom', guesty_source: 'manual', invoice_type: '2.1', series: 'TPY-BOOKING',
    counterpart_vat_number: 'IE9827384L', counterpart_country: 'IE', counterpart_name: 'OTA Counterpart',
  });
  const directDocuments = await prepareReservationDocuments({
    ...queuedReservation,
    reservationId: 'res_DIRECT001',
    platform: 'manual',
    platformKey: 'manual',
    source: 'manual',
    sourceKey: 'manual',
    invoiceCounterpart: undefined,
  }, billingContext);
  assert(directDocuments.primary.document.document_type === '11.2' && directDocuments.primary.document.series === 'APY', 'direct/manual κράτηση εκδίδει ΑΠΥ 11.2');
  assert(directDocuments.primary.document.xml_payload.includes('E3_561_003'), 'η ΑΠΥ του καναλιού χρησιμοποιεί χαρακτηρισμό λιανικής E3_561_003');
  const sameSourceDifferentPlatform = await prepareReservationDocuments({
    ...queuedReservation,
    reservationId: 'res_SAME_SOURCE_DIFFERENT_PLATFORM',
    platform: 'bookingcom', platformKey: 'bookingcom', source: 'manual', sourceKey: 'manual',
    invoiceCounterpart: undefined,
  }, billingContext);
  assert(sameSourceDifferentPlatform.primary.document.document_type === '2.1' && sameSourceDifferentPlatform.primary.document.series === 'TPY-BOOKING', 'ίδιο source σε διαφορετικό platform επιλύεται με ανεξάρτητο κανόνα ΑΠΥ/ΤΠΥ');
  const otaDocuments = await prepareReservationDocuments({
    ...queuedReservation,
    reservationId: 'res_OTA002',
    platform: 'airbnb2',
    platformKey: 'airbnb2',
    source: 'airbnb2',
    sourceKey: 'airbnb2',
    invoiceCounterpart: undefined,
  }, billingContext);
  assert(otaDocuments.primary.document.document_type === '2.1', 'OTA κράτηση χρησιμοποιεί το fallback ΤΠΥ 2.1 με αντισυμβαλλόμενο');

  const folioNormalized = normalizeGuestyReservation({
    _id: 'res_FOLIO001', listingId: 'lst_QUEUE_TEST', status: 'confirmed',
    checkInDateLocalized: '2025-07-10', checkOutDateLocalized: '2025-07-12', fiscalCurrency: 'EUR',
    fiscalFolioOverview: { reservationId: 'res_FOLIO001', listingId: 'lst_QUEUE_TEST', platform: 'airbnb2', source: 'airbnb2', currency: 'EUR' },
    fiscalInvoiceItems: [
      { id: 'af-final', normalType: 'AF', totalPrice: 246.02 },
      { id: 'vat-final', normalType: 'VAT', totalPrice: 31.98 },
      { id: 'ct-final', normalType: 'CT', totalPrice: 4 },
    ],
  });
  assert(folioNormalized.financials.totalGross === 278, 'Guest Folio εξαιρεί city/local taxes και κρατά μόνο υπηρεσίες + VAT');
  const retailCreditXml = generateCreditXML({ invoiceType: '11.4', grossValue: 113, issueDate: '2025-07-17', series: 'APY-RL', correlatedMark: '1' }, { vat_number: '109262634' }, 1);
  assert(retailCreditXml.includes('E3_561_003'), 'πιστωτικό λιανικής 11.4 χρησιμοποιεί E3_561_003');
  assert(retailCreditXml.includes('<correlatedInvoices>1</correlatedInvoices>'), 'πιστωτικό λιανικής 11.4 συσχετίζεται με MARK του αρχικού παραστατικού');

  // ── Test 16: Automatic daily close scheduler ────────────────────────────
  console.log('\n⏰ Test 16: Αυτόματο κλείσιμο ημέρας');
  let invalidBusinessDateBlocked = false;
  try { await executeDailyClose({ companyId: securedCompany.id, businessDate: '2025-02-30' }); } catch (error) { invalidBusinessDateBlocked = error.status === 400; }
  assert(invalidBusinessDateBlocked, 'το ημερήσιο κλείσιμο απορρίπτει ανύπαρκτη ημερομηνία');
  const exclusiveRun = await beginRun(securedCompany.id, '2024-12-31');
  let overlappingRunBlocked = false;
  try { await beginRun(securedCompany.id, '2024-12-31'); } catch (error) { overlappingRunBlocked = error.status === 409; }
  assert(overlappingRunBlocked, 'δύο ταυτόχρονα κλεισίματα της ίδιας εταιρείας/ημέρας αποκλείονται');
  await finishRun(exclusiveRun.id, { total: 0, sent: 0, failed: 0 }, exclusiveRun.lease_token);
  const crashedRun = await beginRun(securedCompany.id, '2024-12-30', { leaseSeconds: 30 });
  await db('daily_close_runs').where({ id: crashedRun.id }).update({ lease_expires_at_ms: Date.now() - 1000 });
  const recoveredRun = await beginRun(securedCompany.id, '2024-12-30', { leaseSeconds: 30 });
  let staleWorkerFinishBlocked = false;
  try { await finishRun(crashedRun.id, { total: 0, sent: 0, failed: 0 }, crashedRun.lease_token); } catch (error) { staleWorkerFinishBlocked = error.status === 409; }
  assert(recoveredRun.lease_token !== crashedRun.lease_token && staleWorkerFinishBlocked, 'λήξη lease επιτρέπει crash recovery αλλά ο παλιός worker δεν μπορεί να ολοκληρώσει το run');
  await finishRun(recoveredRun.id, { total: 0, sent: 0, failed: 0 }, recoveredRun.lease_token);
  assert(scheduledBusinessDate(new Date('2025-07-15T20:56:00Z'), 'Europe/Athens', '23:55') === '2025-07-15', 'μετά την ώρα κλεισίματος επιλέγεται η σημερινή business date');
  assert(scheduledBusinessDate(new Date('2025-07-15T17:00:00Z'), 'Europe/Athens', '23:55') === '2025-07-14', 'πριν την ώρα κλεισίματος καλύπτεται η προηγούμενη ημέρα');
  let schedulerExecutions = 0;
  const scheduledResults = await runScheduledDailyClose({
    now: new Date('2025-07-15T20:56:00Z'), timeZone: 'Europe/Athens', closeTime: '23:55',
    runLookup: async () => null,
    executor: async () => { schedulerExecutions += 1; return { status: 'completed' }; },
  });
  assert(schedulerExecutions === 1 && scheduledResults[0].status === 'completed', 'ο scheduler εκτελεί κλείσιμο για κάθε ενεργή εταιρεία');
  await runScheduledDailyClose({
    now: new Date('2025-07-15T20:57:00Z'), timeZone: 'Europe/Athens', closeTime: '23:55',
    runLookup: async () => ({ status: 'completed' }),
    dueWorkLookup: async () => false,
    executor: async () => { schedulerExecutions += 1; return { status: 'completed' }; },
  });
  assert(schedulerExecutions === 1, 'ολοκληρωμένο ημερήσιο κλείσιμο δεν επανεκτελείται');
  await runScheduledDailyClose({
    now: new Date('2025-07-15T20:58:00Z'), timeZone: 'Europe/Athens', closeTime: '23:55',
    runLookup: async () => ({ status: 'completed' }),
    dueWorkLookup: async () => true,
    executor: async () => { schedulerExecutions += 1; return { status: 'completed' }; },
  });
  assert(schedulerExecutions === 2, 'νέα due κράτηση μετά από completed κλείσιμο ανοίγει ξανά την εκτέλεση');
  const previousMyDataEnv = process.env.MYDATA_ENV;
  const previousProductionEnabled = process.env.MYDATA_PRODUCTION_ENABLED;
  process.env.MYDATA_ENV = 'production';
  process.env.MYDATA_PRODUCTION_ENABLED = 'true';
  let missingSignoffBlocked = false;
  try { await executeDailyClose({ companyId: securedCompany.id, businessDate: '2025-07-15' }); } catch (error) { missingSignoffBlocked = error.status === 503 && error.message.includes('sandbox'); }
  assert(missingSignoffBlocked, 'ο production guard μπλοκάρει αποστολή χωρίς εγκεκριμένο sandbox ζεύγος ΑΠΥ/ΤΠΥ + ΤΑΚΚ');
  if (previousMyDataEnv === undefined) delete process.env.MYDATA_ENV; else process.env.MYDATA_ENV = previousMyDataEnv;
  if (previousProductionEnabled === undefined) delete process.env.MYDATA_PRODUCTION_ENABLED; else process.env.MYDATA_PRODUCTION_ENABLED = previousProductionEnabled;

  // ── Test 17: Read-only connection checks ────────────────────────────────
  console.log('\n🩺 Test 17: Έλεγχοι σύνδεσης χωρίς έκδοση');
  const cancelRequest = buildCancelInvoiceRequest('400014070151557', {
    aade_user_id: 'test-user', aade_subscription_key: 'test-key',
  });
  assert(cancelRequest.url.endsWith('/CancelInvoice') && cancelRequest.data === null && cancelRequest.config.params.mark === '400014070151557', 'το CancelInvoice είναι POST χωρίς XML body και με MARK ως query parameter');
  const connectionRequest = buildConnectionTestRequest({
    aade_user_id: 'test-user', aade_subscription_key: 'test-key',
  });
  assert(connectionRequest.url.endsWith('/RequestTransmittedDocs') && JSON.stringify(connectionRequest.config.params) === JSON.stringify({ mark: '0' }), 'ο read-only έλεγχος myDATA χρησιμοποιεί μόνο το υποχρεωτικό mark χωρίς ασαφές date format');
  const myDataConnection = await testCompanyMyDataConnection(securedCompany.id, async (context) => ({
    success: context.aade_user_id === 'secured_user' && context.aade_subscription_key === 'secured_key',
  }));
  const guestyConnection = await testConfiguredGuestyConnection(async () => ({ success: true }));
  assert(myDataConnection.success, 'ο έλεγχος myDATA χρησιμοποιεί αποκρυπτογραφημένα credentials μόνο στη μνήμη');
  assert(guestyConnection.success, 'ο έλεγχος Guesty OAuth δεν δημιουργεί παραστατικό');
  const guestyFingerprint = credentialFingerprint('offline-client-id');
  await saveIntegrationToken('guesty', guestyFingerprint, 'offline-access-token', Date.now() + 3600000);
  const storedGuestyToken = await getIntegrationToken('guesty', guestyFingerprint, 300000);
  const rawGuestyToken = await db('integration_tokens').where({ provider: 'guesty' }).first();
  assert(storedGuestyToken?.value === 'offline-access-token' && rawGuestyToken.encrypted_access_token.startsWith('enc:v2:'), 'το Guesty OAuth token επιβιώνει restart μόνο σε provider-bound κρυπτογραφημένη μορφή');
  const readiness = await getReadiness();
  assert(readiness.checks.some((check) => check.key === 'guesty' && check.status === 'success') && readiness.checks.some((check) => check.key === `mydata:${securedCompany.id}:sandbox` && check.environment === 'sandbox'), 'το production preflight κρατά πρόσφατη απόδειξη Guesty/myDATA sandbox connection check');
  assert(!readiness.productionReady && readiness.productionIssues.some((item) => item.code === 'sandbox_signoff'), 'το production preflight μπλοκάρει χωρίς sandbox sign-off MARK');
  await handleUpdateCompany(securedCompany.id, { aade_subscription_key: 'rotated_secured_key' });
  const readinessAfterRotation = await getReadiness();
  assert(!readinessAfterRotation.checks.some((check) => check.key === `mydata:${securedCompany.id}:sandbox`), 'η περιστροφή credentials ακυρώνει αυτόματα το παλιό myDATA connection evidence');
  await initSchema();
  const encryptedLegacyTenant = await db('tenants').where({ listing_id_guesty: 'lst_TEST001' }).first();
  assert(encryptedLegacyTenant.aade_subscription_key.startsWith('enc:v1:'), 'legacy tenant credentials κρυπτογραφούνται αυτόματα στη migration');

  // ── Test 18: Staging prevents stale confirmed invoices ──────────────────
  console.log('\n🗂️  Test 18: Staging κράτησης έως το ημερήσιο κλείσιμο');
  await db('financial_profiles').insert({
    listing_id: securedListing.id, platform_key: 'manual', source_key: 'manual', version: 1,
    status: 'approved', currency: 'EUR', strategy: 'folio_rules',
    line_rules: JSON.stringify([{ normalType: 'AF', action: 'include', allowBroad: true }]),
    tolerance: 0, minimum_samples: 1, config_hash: 'c'.repeat(64), approved_by: 'smoke-test', approved_at: db.fn.now(),
  });
  const stagedBaseCore = {
    ...queuedReservation,
    reservationId: 'res_STAGED001',
    platform: 'manual',
    platformKey: 'manual',
    source: 'manual',
    sourceKey: 'manual',
    status: 'confirmed',
  };
  const stagedAmount = (base, totalGross) => {
    const invoiceItems = [{
      id: `${base.reservationId}-af`, normalType: 'AF', totalPrice: totalGross,
      listingId: base.listingId, stayIndex: 0,
    }];
    return {
      ...base,
      fiscalInvoiceItems: invoiceItems,
      financials: { totalGross, invoiceItems },
      stayEvidence: {
        reservationListingId: base.listingId, folioListingId: base.listingId,
        lineListingIds: [base.listingId], stayIndexes: [0],
        allLinesAllocated: true, singleStayConfirmed: true,
      },
    };
  };
  const stagedBase = stagedAmount(stagedBaseCore, 200);
  await stageReservation(stagedBase, billingContext);
  assert((await db('fiscal_documents').where({ reservation_id: 'res_STAGED001' })).length === 0, 'confirmed webhook δεν δεσμεύει ΑΑ ούτε παγώνει ποσό');
  await stageReservation(stagedAmount(stagedBase, 226), billingContext);
  const overrideBase = stagedAmount({ ...stagedBase, reservationId: 'res_OVERRIDE001' }, 339);
  await stageReservation(overrideBase, billingContext);
  let rejectedInvalidOverrideVat = false;
  try {
    await applyFiscalOverride('res_OVERRIDE001', {
      invoice_type: '2.1', counterpart_vat_number: '123456780', counterpart_country: 'GR', counterpart_name: 'Invalid Greek VAT',
    });
  } catch (error) { rejectedInvalidOverrideVat = error.status === 400 && error.message.includes('checksum'); }
  assert(rejectedInvalidOverrideVat, 'το override ΤΠΥ απορρίπτει λανθασμένο ελληνικό ΑΦΜ πριν την έκδοση');
  await applyFiscalOverride('res_OVERRIDE001', {
    invoice_type: '2.1', series: 'CORP', counterpart_vat_number: '099999999', counterpart_country: 'GR', counterpart_name: 'Corporate Guest AE', counterpart_branch: 7,
  });
  // A later Guesty refresh must update the amount while preserving the explicit
  // operator choice made before fiscal materialization.
  await stageReservation(stagedAmount(overrideBase, 452), billingContext);
  const reissueBase = stagedAmount({ ...stagedBase, reservationId: 'res_REISSUE001' }, 300);
  await stageReservation(reissueBase, billingContext);
  const unknownChannel = stagedAmount({
    ...stagedBase, reservationId: 'res_UNKNOWN_CHANNEL', platform: 'new-ota', platformKey: 'new-ota', source: 'new-ota', sourceKey: 'new-ota',
  }, 226);
  await stageReservation(unknownChannel, billingContext);
  await materializeDueReservations(securedCompany.id, '2025-07-15', { useGuestyRefresh: false });
  const stagedDocuments = await db('fiscal_documents').where({ reservation_id: 'res_STAGED001' });
  assert(stagedDocuments.length === 2 && stagedDocuments.find((row) => row.document_type === '11.2').gross_value === 226, 'το κλείσιμο χρησιμοποιεί το τελευταίο Guesty ποσό και δημιουργεί ΑΠΥ + ΤΑΚΚ');
  const overrideDocuments = await db('fiscal_documents').where({ reservation_id: 'res_OVERRIDE001' });
  const overridePrimary = overrideDocuments.find((row) => row.document_type === '2.1');
  assert(overridePrimary?.series === 'CORP' && overridePrimary.gross_value === 452 && overridePrimary.xml_payload.includes('099999999') && overridePrimary.xml_payload.includes('<branch>7</branch>'), 'μεμονωμένη κράτηση μπορεί να γίνει ΤΠΥ με δική της σειρά/αντισυμβαλλόμενο/υποκατάστημα');
  const unknownSnapshot = await db('reservation_snapshots').where({ reservation_id: 'res_UNKNOWN_CHANNEL' }).first();
  assert(Boolean(unknownSnapshot.requires_review) && (await db('fiscal_documents').where({ reservation_id: 'res_UNKNOWN_CHANNEL' })).length === 0, 'άγνωστο κανάλι μπαίνει σε review χωρίς ΑΠΥ/ΤΠΥ, ΤΑΚΚ ή δέσμευση ΑΑ');
  let materializedOverrideBlocked = false;
  try { await applyFiscalOverride('res_OVERRIDE001', { invoice_type: '11.2' }); } catch (error) { materializedOverrideBlocked = error.status === 409; }
  assert(materializedOverrideBlocked, 'η εξαίρεση ΑΠΥ/ΤΠΥ κλειδώνει μόλις δεσμευτεί ΑΑ');
  await stageReservation(stagedAmount(reissueBase, 360), billingContext);
  const oldRevisionDocuments = await db('fiscal_documents').where({ reservation_id: 'res_REISSUE001' });
  for (const document of oldRevisionDocuments) await cancelFiscalDocument({ documentId: document.id });
  await reopenForReissue('res_REISSUE001', { resolution: 'Guesty amount corrected before transmission' });
  await materializeDueReservations(securedCompany.id, '2025-07-15', { useGuestyRefresh: false });
  const allRevisionDocuments = await db('fiscal_documents').where({ reservation_id: 'res_REISSUE001' }).orderBy('id');
  const newRevisionPrimary = allRevisionDocuments.find((row) => row.document_key.endsWith(':primary:r1'));
  assert(allRevisionDocuments.length === 4 && oldRevisionDocuments.every((old) => allRevisionDocuments.find((row) => row.id === old.id).status === 'cancelled') && newRevisionPrimary?.gross_value === 360, 'μετά την ακύρωση παλιών παραστατικών η νέα revision παίρνει νέους ΑΑ και το διορθωμένο ποσό');
  const reviewedSnapshot = await stageReservation(stagedAmount(stagedBase, 339), billingContext);
  assert(Boolean(reviewedSnapshot.requires_review), 'μεταβολή μετά το materialization επισημαίνεται για έλεγχο');
  const sameTotalNoShow = await stageReservation({
    ...stagedAmount(stagedBase, 339), guestStayStatus: 'no_show',
  }, billingContext);
  assert(Boolean(sameTotalNoShow.requires_review), 'ίδιο ποσό με μεταβολή Guesty σε no-show παραμένει μπλοκαρισμένο για έλεγχο');
  await stageReservation(stagedAmount({ ...stagedBase, status: 'canceled' }, 339), billingContext);
  const cancelledPending = await db('fiscal_documents').where({ reservation_id: 'res_STAGED001', status: 'cancelled' });
  assert(cancelledPending.length === 2, 'ακύρωση πριν τη διαβίβαση ακυρώνει τα pending παραστατικά τοπικά');
  const resolvedCancellation = await resolveCancellationReview('res_STAGED001', { resolution: 'Guesty cancellation reviewed and all documents cancelled' });
  assert(!Boolean(resolvedCancellation.requires_review) && resolvedCancellation.reviewed_at, 'ακυρωμένη κράτηση κλείνει το review μόνο όταν όλα τα παραστατικά είναι cancelled');
  const failedMaterializationRun = await executeDailyClose({
    companyId: securedCompany.id,
    businessDate: '2025-01-01',
    sender: async () => { throw new Error('must not send'); },
    verifier: async () => ({ verified: true }),
    materializer: async () => [{ reservationId: 'broken', error: 'missing fiscal setup' }],
  });
  assert(failedMaterializationRun.status === 'failed' && failedMaterializationRun.failed_count === 1, 'σφάλμα materialization αποτυγχάνει το κλείσιμο αντί να δηλώνει ψευδώς completed');

  // ── Test 19: Guesty Svix signature ──────────────────────────────────────
  console.log('\n🛡️  Test 19: Guesty Svix webhook signature');
  const previousWebhookSecret = process.env.GUESTY_WEBHOOK_SECRET;
  const webhookKey = Buffer.alloc(32, 9);
  process.env.GUESTY_WEBHOOK_SECRET = `whsec_${webhookKey.toString('base64')}`;
  const webhookBody = JSON.stringify({ event: 'reservation.new', reservation: { _id: 'abc' } });
  const webhookId = 'msg_test_1';
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const webhookSignature = crypto.createHmac('sha256', webhookKey).update(`${webhookId}.${webhookTimestamp}.${webhookBody}`).digest('base64');
  const signedRequest = { rawBody: webhookBody, headers: { 'svix-id': webhookId, 'svix-timestamp': webhookTimestamp, 'svix-signature': `v1,${webhookSignature}` } };
  assert(verifyGuestySignature(signedRequest), 'έγκυρη Svix υπογραφή γίνεται αποδεκτή');
  assert(!verifyGuestySignature({ ...signedRequest, rawBody: `${webhookBody}x` }), 'αλλοιωμένο payload απορρίπτεται');
  if (previousWebhookSecret === undefined) delete process.env.GUESTY_WEBHOOK_SECRET;
  else process.env.GUESTY_WEBHOOK_SECRET = previousWebhookSecret;

  // ── Test 20: Production security boundaries ─────────────────────────────
  console.log('\n🔐 Test 20: Fail-closed auth, replay protection και ασφαλή fiscal DTO/PDF');
  const { adminAuth } = require('../src/middleware/admin-auth');
  const {
    claimGuestyWebhookEvent,
    completeGuestyWebhookEvent,
    releaseGuestyWebhookEvent,
  } = require('../src/repositories/integration-checks');
  const { listDocuments } = require('../src/repositories/fiscal-documents');
  const { listInvoices } = require('../src/repositories/invoices');
  const savedSecurityEnv = {
    nodeEnv: process.env.NODE_ENV,
    adminToken: process.env.ADMIN_API_TOKEN,
    allowInsecureDev: process.env.ALLOW_INSECURE_DEV,
    webhookSecret: process.env.GUESTY_WEBHOOK_SECRET,
  };
  const authResult = () => {
    const result = { statusCode: null, body: null, next: false };
    const req = { get: () => '' };
    const res = {
      status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; return this; },
    };
    adminAuth(req, res, () => { result.next = true; });
    return result;
  };
  delete process.env.ADMIN_API_TOKEN;
  delete process.env.ALLOW_INSECURE_DEV;
  process.env.NODE_ENV = 'development';
  assert(authResult().statusCode === 503, 'το admin API αποτυγχάνει κλειστά χωρίς token ακόμη και σε development');
  process.env.ALLOW_INSECURE_DEV = 'true';
  assert(authResult().next, 'μόνο ρητό ALLOW_INSECURE_DEV επιτρέπει auth bypass εκτός production');
  process.env.NODE_ENV = 'production';
  assert(authResult().statusCode === 503, 'το ALLOW_INSECURE_DEV δεν παρακάμπτει ποτέ production admin auth');

  delete process.env.GUESTY_WEBHOOK_SECRET;
  delete process.env.ALLOW_INSECURE_DEV;
  process.env.NODE_ENV = 'development';
  let unsignedWebhookBlocked = false;
  try { verifyGuestySignature({ rawBody: '{}', headers: {} }); } catch { unsignedWebhookBlocked = true; }
  assert(unsignedWebhookBlocked, 'unsigned Guesty webhook απορρίπτεται χωρίς ρητό insecure development mode');
  process.env.ALLOW_INSECURE_DEV = 'true';
  assert(verifyGuestySignature({ rawBody: '{}', headers: {} }), 'το unsigned webhook bypass απαιτεί ρητό ALLOW_INSECURE_DEV');
  process.env.GUESTY_WEBHOOK_SECRET = `whsec_${webhookKey.toString('base64')}`;
  const nonNumericTimestamp = 'not-a-timestamp';
  const nonNumericSignature = crypto.createHmac('sha256', webhookKey)
    .update(`${webhookId}.${nonNumericTimestamp}.${webhookBody}`).digest('base64');
  assert(!verifyGuestySignature({
    rawBody: webhookBody,
    headers: { 'svix-id': webhookId, 'svix-timestamp': nonNumericTimestamp, 'svix-signature': `v1,${nonNumericSignature}` },
  }), 'Svix timestamp απορρίπτεται αν δεν είναι αυστηρά αριθμητικό');

  assert(await claimGuestyWebhookEvent('security-test-event'), 'το πρώτο durable webhook claim γίνεται δεκτό');
  assert(!await claimGuestyWebhookEvent('security-test-event'), 'δεύτερο claim του ίδιου event απορρίπτεται ως replay');
  await releaseGuestyWebhookEvent('security-test-event');
  assert(await claimGuestyWebhookEvent('security-test-event'), 'αποτυχημένο webhook claim μπορεί να αποδεσμευτεί για ασφαλές retry');
  await completeGuestyWebhookEvent('security-test-event');
  assert(!await claimGuestyWebhookEvent('security-test-event'), 'ολοκληρωμένο webhook παραμένει durable replay-protected');

  const fiscalDtos = await listDocuments();
  assert(fiscalDtos.length > 0 && fiscalDtos.every((row) => !Object.hasOwn(row, 'xml_payload') && !Object.hasOwn(row, 'source_payload') && !Object.hasOwn(row, 'mydata_response')), 'η λίστα fiscal documents δεν εκθέτει XML, Guesty payload ή raw myDATA response');
  const invoiceDtos = await listInvoices();
  assert(invoiceDtos.every((row) => !Object.hasOwn(row, 'xml_payload')), 'η λίστα legacy invoices δεν εκθέτει XML payload');

  const verifiedPdf = await renderFiscalDocumentPdf(verifiedCredit.id);
  assert(Buffer.isBuffer(verifiedPdf), 'verified sent παραστατικό παραμένει διαθέσιμο ως PDF');
  await db('fiscal_documents').where({ id: verifiedCredit.id }).update({ status: 'cancelled', cancellation_status: 'cancelled' });
  let cancelledPdfBlocked = false;
  try { await renderFiscalDocumentPdf(verifiedCredit.id); } catch (error) { cancelledPdfBlocked = error.status === 409; }
  assert(cancelledPdfBlocked, 'ακυρωμένο παραστατικό δεν παράγει κανονικό PDF');

  const restoreEnv = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  restoreEnv('NODE_ENV', savedSecurityEnv.nodeEnv);
  restoreEnv('ADMIN_API_TOKEN', savedSecurityEnv.adminToken);
  restoreEnv('ALLOW_INSECURE_DEV', savedSecurityEnv.allowInsecureDev);
  restoreEnv('GUESTY_WEBHOOK_SECRET', savedSecurityEnv.webhookSecret);

  // ── Test 21: Versioned financial profile approval lifecycle ─────────────
  console.log('\n🧩 Test 21: Versioned calibration και έγκριση profile ποσών');
  const draftProfile = await createNextFinancialProfileVersion({
    listing_id: securedListing.id, platform_key: 'bookingcom', source_key: 'booking.com',
    strategy: 'folio_rules', currency: 'EUR', tolerance: 0.01, minimum_samples: 3,
    line_rules: [
      { normalType: 'AF', title: 'room charge', action: 'include' },
      { normalType: 'CT', title: 'city tax', action: 'exclude' },
    ],
  });
  const calibrationResult = evaluateFolio({
    profile: { ...draftProfile, approved: true },
    invoiceItems: [
      { id: 'cal-af', normalType: 'AF', title: 'Room charge', totalPrice: 485.91 },
      { id: 'cal-ct', normalType: 'CT', title: 'City tax', totalPrice: 8 },
    ],
  });
  for (let sampleIndex = 1; sampleIndex <= 3; sampleIndex += 1) {
    await recordCalibrationSample(draftProfile.id, {
      reservation_id: `cal-booking-${sampleIndex}`, expected_amount: 485.90, computed_amount: 485.91,
      channel_key: 'bookingcom', currency: 'EUR', line_evidence: calibrationResult.evidence,
    });
  }
  const approvedProfile = await approveFinancialProfile(draftProfile.id, { approvedBy: 'smoke-accountant', notes: 'verified sample' });
  assert(approvedProfile.status === 'approved', 'draft profile εγκρίνεται μόνο μετά από επιτυχημένο calibration');
  let unsafeSampleCountBlocked = false;
  try {
    await createNextFinancialProfileVersion({
      listing_id: securedListing.id, platform_key: 'unsafe', source_key: 'one-sample',
      strategy: 'folio_rules', currency: 'EUR', tolerance: 0, minimum_samples: 1,
      line_rules: [{ normalType: 'AF', title: 'room charge', action: 'include' }],
    });
  } catch (error) { unsafeSampleCountBlocked = error.message.includes('at least 3'); }
  assert(unsafeSampleCountBlocked, 'κανένα profile δεν μπορεί να εγκριθεί με λιγότερα από τρία πραγματικά δείγματα');
  const broadDraft = await createNextFinancialProfileVersion({
    listing_id: securedListing.id, platform_key: 'unsafe', source_key: 'broad',
    strategy: 'folio_rules', currency: 'EUR', tolerance: 0, minimum_samples: 3,
    line_rules: [{ normalType: 'AF', action: 'include', allowBroad: true }],
  });
  for (let sampleIndex = 1; sampleIndex <= 3; sampleIndex += 1) {
    await recordCalibrationSample(broadDraft.id, {
      reservation_id: `cal-broad-${sampleIndex}`, expected_amount: 100, computed_amount: 100,
      channel_key: 'unsafe', currency: 'EUR', line_evidence: [],
    });
  }
  let broadApprovalBlocked = false;
  try { await approveFinancialProfile(broadDraft.id, { approvedBy: 'smoke-accountant' }); } catch (error) { broadApprovalBlocked = error.message.includes('Broad include'); }
  assert(broadApprovalBlocked, 'broad include κανόνας δεν εγκρίνεται ακόμη και αν τα συνολικά ποσά των samples συμφωνούν');
  const calibrationRaw = {
    _id: 'cal-no-show', listingId: securedListing.listing_id_guesty, status: 'confirmed',
    checkInDateLocalized: '2026-07-01', checkOutDateLocalized: '2026-07-02', fiscalCurrency: 'EUR',
    guestStay: { status: 'no_show' },
    fiscalFolioOverview: {
      reservationId: 'cal-no-show', listingId: securedListing.listing_id_guesty,
      platform: 'unsafe', source: 'broad', currency: 'EUR',
    },
    fiscalInvoiceItems: [{ id: 'cal-no-show-af', normalType: 'AF', totalPrice: 100 }],
  };
  let noShowCalibrationBlocked = false;
  try {
    await calibrateProfile(broadDraft.id, { reservation_id: 'cal-no-show', expected_amount: 100 }, { fetcher: async () => calibrationRaw });
  } catch (error) { noShowCalibrationBlocked = error.status === 409 && error.message.includes('no_show'); }
  assert(noShowCalibrationBlocked, 'no-show ή μη εκδόσιμο Guesty stay δεν μπορεί να χρησιμοποιηθεί ως calibration sample');
  const observedChannelSamples = await listObservedChannels();
  assert(observedChannelSamples.some((channel) => channel.sample_reservation_id && Array.isArray(channel.observed_lines)), 'το admin onboarding επιστρέφει ασφαλές δείγμα Guest Folio ανά παρατηρημένο platform/source');
  assert((await getApprovedFinancialProfile(securedListing.id, 'bookingcom', 'booking.com')).id === approvedProfile.id, 'η εγκεκριμένη έκδοση επιλύεται με ακριβές listing/platform/source');
  let approvedMutationBlocked = false;
  try { await updateDraftFinancialProfile(approvedProfile.id, { tolerance: 1 }); } catch (error) { approvedMutationBlocked = error.status === 409; }
  assert(approvedMutationBlocked, 'εγκεκριμένο profile είναι immutable και αλλάζει μόνο με νέα version');
  const bookingProfileReservation = {
    reservationId: 'res_PROFILE_GUARD', listingId: securedListing.listing_id_guesty,
    platform: 'bookingcom', platformKey: 'bookingcom', source: 'booking.com', sourceKey: 'booking.com',
    financials: { invoiceItems: [{ id: 'guard-af', normalType: 'AF', title: 'Room charge', totalPrice: 485.90 }] },
    fiscalInvoiceItems: [{ id: 'guard-af', normalType: 'AF', title: 'Room charge', totalPrice: 485.90 }],
    stayEvidence: {
      reservationListingId: securedListing.listing_id_guesty,
      folioListingId: securedListing.listing_id_guesty,
      lineListingIds: [], stayIndexes: [], singleStayConfirmed: true,
    },
  };
  let noShowBlocked = false;
  try { await applyFinancialProfile({ ...bookingProfileReservation, guestStayStatus: 'no_show' }, billingContext); } catch (error) { noShowBlocked = error.status === 409; }
  assert(noShowBlocked, 'no-show δεν κληρονομεί αυτόματα το κανονικό ποσό καναλιού');
  let splitStayBlocked = false;
  try {
    await applyFinancialProfile({
      ...bookingProfileReservation,
      fiscalInvoiceItems: [
        { id: 'guard-af-a', normalType: 'AF', totalPrice: 242.95, listingId: securedListing.listing_id_guesty, stayIndex: 0 },
        { id: 'guard-af-b', normalType: 'AF', totalPrice: 242.95, listingId: 'another-listing', stayIndex: 1 },
      ],
      stayEvidence: { ...bookingProfileReservation.stayEvidence, singleStayConfirmed: false },
    }, billingContext);
  } catch (error) { splitStayBlocked = error.status === 409; }
  assert(splitStayBlocked, 'split/relocated Guesty folio απαιτεί ρητή κατανομή ανά stay και δεν αθροίζεται αυτόματα');

  // ── Test 22: Uncertain transmission quarantine + MARK reconciliation ───
  console.log('\n📡 Test 22: Αβέβαιη μετάδοση χωρίς τυφλό retry');
  const uncertainBusinessDate = new Date().toISOString().slice(0, 10);
  const uncertainCheckIn = new Date(`${uncertainBusinessDate}T00:00:00.000Z`);
  uncertainCheckIn.setUTCDate(uncertainCheckIn.getUTCDate() - 1);
  const uncertainReservation = {
    ...queuedReservation,
    reservationId: 'res_UNCERTAIN001',
    checkIn: uncertainCheckIn.toISOString().slice(0, 10),
    checkOut: uncertainBusinessDate,
    nights: 1,
    financials: { totalGross: 113 },
  };
  await stageReservation(uncertainReservation, billingContext);
  await prepareReservationDocuments(uncertainReservation, billingContext);
  await db('reservation_snapshots').where({ reservation_id: uncertainReservation.reservationId }).update({ materialized_at: db.fn.now() });
  let uncertainSendCalls = 0;
  const uncertainSender = async () => {
    uncertainSendCalls += 1;
    const error = new Error('socket closed after request write');
    error.transmissionUncertain = true;
    throw error;
  };
  await executeDailyClose({
    companyId: securedCompany.id, businessDate: uncertainBusinessDate,
    sender: uncertainSender, verifier: async () => ({ verified: false }), materializer: async () => [],
  });
  const uncertainDocuments = await db('fiscal_documents').where({ reservation_id: uncertainReservation.reservationId }).orderBy('id');
  assert(uncertainDocuments.every((row) => row.status === 'failed' && Boolean(row.transmission_uncertain) && !Boolean(row.retryable)), 'network ambiguity μπαίνει σε quarantine και δεν χαρακτηρίζεται ασφαλές retry');
  let uncertainCancellationBlocked = false;
  try { await cancelFiscalDocument({ documentId: uncertainDocuments[0].id }); } catch (error) { uncertainCancellationBlocked = error.status === 409; }
  assert(uncertainCancellationBlocked, 'αβέβαιο παραστατικό δεν ακυρώνεται τοπικά πριν συμφωνηθεί με myDATA');
  const callsBeforeRetry = uncertainSendCalls;
  const blockedUncertainRun = await executeDailyClose({
    companyId: securedCompany.id, businessDate: uncertainBusinessDate,
    sender: uncertainSender, verifier: async () => ({ verified: false }), materializer: async () => [],
  });
  assert(uncertainSendCalls === callsBeforeRetry && ['failed', 'partial'].includes(blockedUncertainRun.status), 'επόμενο κλείσιμο δεν ξαναστέλνει αβέβαιη μετάδοση ούτε δηλώνει ψευδώς completed');
  for (let index = 0; index < uncertainDocuments.length; index += 1) {
    const document = uncertainDocuments[index];
    const mark = String(700000000000000n + BigInt(index + 1));
    const reconciled = await reconcileUncertainTransmission({
      documentId: document.id, mark,
      verifier: async () => ({
        verified: true, mark, uid: `UID-REC-${index + 1}`,
        raw: {
          uid: `UID-REC-${index + 1}`,
          invoiceHeader: { series: document.series, aa: document.aa, invoiceType: document.document_type, issueDate: String(document.issue_date).slice(0, 10) },
          invoiceSummary: { totalGrossValue: document.gross_value },
        },
      }),
    });
    assert(reconciled.status === 'sent' && reconciled.verification_status === 'verified' && reconciled.mydata_mark === mark, `το αβέβαιο ${document.document_type} συμφωνείται μόνο με ίδιο fiscal identity και MARK`);
  }
  const reconciledPair = await db('fiscal_documents').where({ reservation_id: uncertainReservation.reservationId }).orderBy('id');
  const signoff = await createSandboxSignoff({
    primary_document_id: reconciledPair.find((row) => ['2.1', '11.2'].includes(row.document_type)).id,
    takk_document_id: reconciledPair.find((row) => row.document_type === '8.2').id,
    approved_by: 'Smoke Test Accountant', approval_notes: 'Verified pair and PDFs',
  });
  assert(signoff.primary_mark && signoff.takk_mark && signoff.issuer_vat === securedCompany.vat_number
    && signoff.credential_binding_sha256.length === 64
    && signoff.primary_pdf_sha256.length === 64 && signoff.takk_pdf_sha256.length === 64
    && signoff.primary_xml_sha256.length === 64 && signoff.takk_xml_sha256.length === 64
    && signoff.primary_response_sha256.length === 64 && signoff.takk_response_sha256.length === 64
    && signoff.primary_uid_sha256.length === 64 && signoff.takk_uid_sha256.length === 64,
  'sandbox sign-off απαιτεί verified κύριο+ΤΑΚΚ και δεσμεύεται στο τρέχον ΑΦΜ/credentials');
  const cancellationTarget = reconciledPair.find((row) => row.document_type === '8.2');
  let cancellationUncertain = false;
  try {
    await cancelFiscalDocument({ documentId: cancellationTarget.id, canceller: async () => {
      const error = new Error('connection lost after CancelInvoice'); error.transmissionUncertain = true; throw error;
    } });
  } catch {
    cancellationUncertain = Boolean((await db('fiscal_documents').where({ id: cancellationTarget.id }).first()).cancellation_uncertain);
  }
  assert(cancellationUncertain, 'αβέβαιο CancelInvoice μπαίνει σε quarantine χωρίς blind retry');
  let cancellationRetryBlocked = false;
  try { await cancelFiscalDocument({ documentId: cancellationTarget.id, canceller: async () => ({ cancellationMark: 'must-not-run' }) }); } catch (error) { cancellationRetryBlocked = error.status === 409; }
  assert(cancellationRetryBlocked, 'η αβέβαιη ακύρωση δεν ξαναστέλνεται πριν από συμφωνία');
  const reconciledCancellation = await reconcileFiscalDocumentCancellation({
    documentId: cancellationTarget.id,
    verifier: async (invoiceMark) => ({ verified: true, invoiceMark, cancellationMark: '800000000000001' }),
  });
  assert(reconciledCancellation.status === 'cancelled' && reconciledCancellation.cancellation_mark === '800000000000001', 'RequestTransmittedDocs συμφωνεί την αβέβαιη ακύρωση με cancellation MARK');

  // ── Test 23: Guesty dropped-webhook reconciliation ─────────────────────
  console.log('\n🔄 Test 23: Guesty paginated backfill/cursor για χαμένο webhook');
  const recoveredId = 'res_DROPPED_WEBHOOK';
  const reconciliation = await runGuestyReconciliation({
    from: '2026-07-30T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z',
    searcher: async () => [recoveredId],
    fetcher: async () => ({
      _id: recoveredId, listingId: securedListing.listing_id_guesty, status: 'confirmed', source: 'manual',
      checkInDateLocalized: '2026-07-29', checkOutDateLocalized: '2026-07-30', fiscalCurrency: 'EUR',
      fiscalFolioOverview: { reservationId: recoveredId, listingId: securedListing.listing_id_guesty, platform: 'manual', source: 'manual', currency: 'EUR', updatedAt: '2026-07-30T12:00:00.000Z' },
      fiscalInvoiceItems: [{ id: 'recovered-af', normalType: 'AF', title: 'Accommodation fare', totalPrice: 113, listingId: securedListing.listing_id_guesty, stayIndex: 0 }],
    }),
  });
  assert(reconciliation.discovered === 1 && reconciliation.staged === 1 && await db('reservation_snapshots').where({ reservation_id: recoveredId }).first(), 'χαμένο webhook ανακαλύπτεται από lastUpdatedAt backfill και γίνεται stage');
  assert((await db('sync_cursors').where({ provider: 'guesty', cursor_key: 'reservations_last_updated' }).first()).cursor_value === '2026-07-31T00:00:00.000Z', 'ο Guesty cursor προχωρά μόνο μετά από πλήρη επιτυχία');

  // ── Results ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(45)}`);
  console.log(`✅ Passed: ${passed} | ❌ Failed: ${failed}`);

  await db.destroy();

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('\n🎉 Όλα τα offline tests πέρασαν. Απαιτείται ακόμη πραγματικό Guesty + myDATA sandbox sign-off.\n');
  }
}

run().catch((err) => {
  console.error('\n💥 Smoke test crash:', err.message);
  process.exit(1);
});

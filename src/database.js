'use strict';

require('dotenv').config();
const knex = require('knex');
const { insertedId } = require('./database-utils');
const { encryptSecret, reencryptSecret, isEncrypted, companySecretContext } = require('./security/credentials');
const { databaseConfig } = require('./config/runtime');

// -------------------------------------------------------------------
// Knex config — SQLite τώρα, PostgreSQL με 1 αλλαγή στο DB_CLIENT
// Για PostgreSQL: DB_CLIENT=pg, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
// -------------------------------------------------------------------
const db = knex(databaseConfig());

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------
async function hasColumn(tableName, columnName) {
  return db.schema.hasColumn(tableName, columnName);
}

async function ensureColumn(tableName, columnName, builder) {
  const exists = await hasColumn(tableName, columnName);
  if (!exists) {
    await db.schema.alterTable(tableName, (t) => builder(t));
    console.log(`✅ Προστέθηκε στήλη: ${tableName}.${columnName}`);
  }
}

async function ensureUniqueIndex(tableName, indexName, columns) {
  const identifiers = [tableName, indexName, ...columns];
  if (!identifiers.every((value) => /^[a-z0-9_]+$/.test(value))) {
    throw new Error('Unsafe database identifier while ensuring a unique index');
  }
  const duplicate = await db(tableName)
    .select(columns)
    .count({ duplicate_count: '*' })
    .groupBy(columns)
    .havingRaw('COUNT(*) > 1')
    .first();
  if (duplicate) {
    throw new Error(`Cannot create ${indexName}: duplicate fiscal identity rows must be resolved first`);
  }
  const quotedColumns = columns.map((column) => `"${column}"`).join(', ');
  await db.raw(`CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${tableName}" (${quotedColumns})`);
}

async function reconcileDocumentSequences() {
  const maxima = await db('fiscal_documents')
    .select('company_id', 'document_type', 'series')
    .max({ last_number: 'aa' })
    .groupBy('company_id', 'document_type', 'series');
  for (const row of maxima) {
    const identity = {
      company_id: row.company_id,
      document_type: row.document_type,
      series: row.series,
    };
    const lastNumber = Number(row.last_number);
    await db('document_sequences').insert({ ...identity, last_number: lastNumber })
      .onConflict(['company_id', 'document_type', 'series']).ignore();
    await db('document_sequences').where(identity).where('last_number', '<', lastNumber).update({
      last_number: lastNumber,
      updated_at: db.fn.now(),
    });
  }
}

// -------------------------------------------------------------------
// Schema — normalized model
// companies: 1 row per legal entity / ΑΦΜ
// listings: 1 row per Guesty listing, mapped to company
// invoices: invoice transmission history
// -------------------------------------------------------------------
let schemaInitPromise = null;

async function initSchema() {
  if (schemaInitPromise) return schemaInitPromise;
  schemaInitPromise = runSchemaInitialization();
  try {
    return await schemaInitPromise;
  } finally {
    schemaInitPromise = null;
  }
}

async function runSchemaInitialization() {
  if (db.client.config.client !== 'pg') return initializeSchemaObjects();
  const connection = await db.client.acquireConnection();
  try {
    await db.raw('SELECT pg_advisory_lock(?)', [1732584194]).connection(connection);
    return await initializeSchemaObjects();
  } finally {
    try { await db.raw('SELECT pg_advisory_unlock(?)', [1732584194]).connection(connection); } finally {
      await db.client.releaseConnection(connection);
    }
  }
}

async function initializeSchemaObjects() {
  await ensureCompaniesTable();
  await ensureListingsTable();
  await ensureListingBillingRulesTable();
  await ensureListingChannelBillingRulesTable();
  await ensureFinancialProfilesTables();
  await ensureReservationSnapshotsTable();
  await ensureLegacyTenantsTable();
  await ensureInvoicesTable();
  await ensureFiscalDocumentsTable();
  await ensureDocumentSequencesTable();
  await ensureDailyCloseTables();
  await ensureIntegrationChecksTable();
  await ensureIntegrationTokensTable();
  await ensureSandboxSignoffsTable();
  await ensureSyncCursorsTable();
  await ensureUniqueIndex(
    'fiscal_documents',
    'fiscal_documents_company_type_series_aa_uq',
    ['company_id', 'document_type', 'series', 'aa'],
  );
  await ensureUniqueIndex(
    'document_sequences',
    'document_sequences_company_type_series_uq',
    ['company_id', 'document_type', 'series'],
  );
  await ensureUniqueIndex(
    'daily_close_runs',
    'daily_close_runs_company_date_uq',
    ['company_id', 'business_date'],
  );
  // An upgraded database can already contain documents while its sequence
  // table is absent or behind. Reconcile to the highest issued AA before any
  // worker is allowed to materialize another fiscal document.
  await reconcileDocumentSequences();
  await migrateLegacyTenantsToNormalizedModel();
  await migrateCredentialsToEncryptedStorage();
}

async function ensureSyncCursorsTable() {
  if (await db.schema.hasTable('sync_cursors')) return;
  await db.schema.createTable('sync_cursors', (t) => {
    t.string('provider', 40).notNullable();
    t.string('cursor_key', 80).notNullable();
    t.text('cursor_value').notNullable();
    t.timestamps(true, true);
    t.primary(['provider', 'cursor_key']);
  });
  console.log('✅ Δημιουργήθηκε πίνακας: sync_cursors');
}

async function ensureSandboxSignoffsTable() {
  if (await db.schema.hasTable('sandbox_signoffs')) {
    await ensureColumn('sandbox_signoffs', 'issuer_vat', (t) => t.string('issuer_vat', 9).nullable());
    await ensureColumn('sandbox_signoffs', 'credential_binding_sha256', (t) => t.string('credential_binding_sha256', 64).nullable());
    await ensureColumn('sandbox_signoffs', 'primary_xml_sha256', (t) => t.string('primary_xml_sha256', 64).nullable());
    await ensureColumn('sandbox_signoffs', 'takk_xml_sha256', (t) => t.string('takk_xml_sha256', 64).nullable());
    await ensureColumn('sandbox_signoffs', 'primary_response_sha256', (t) => t.string('primary_response_sha256', 64).nullable());
    await ensureColumn('sandbox_signoffs', 'takk_response_sha256', (t) => t.string('takk_response_sha256', 64).nullable());
    await ensureColumn('sandbox_signoffs', 'primary_uid_sha256', (t) => t.string('primary_uid_sha256', 64).nullable());
    await ensureColumn('sandbox_signoffs', 'takk_uid_sha256', (t) => t.string('takk_uid_sha256', 64).nullable());
    return;
  }
  await db.schema.createTable('sandbox_signoffs', (t) => {
    t.increments('id').primary();
    t.integer('company_id').unsigned().notNullable();
    t.string('reservation_id', 120).notNullable();
    t.string('issuer_vat', 9).notNullable();
    t.string('credential_binding_sha256', 64).notNullable();
    t.integer('primary_document_id').unsigned().notNullable();
    t.integer('takk_document_id').unsigned().notNullable();
    t.string('primary_mark', 30).notNullable();
    t.string('takk_mark', 30).notNullable();
    t.string('primary_pdf_sha256', 64).notNullable();
    t.string('takk_pdf_sha256', 64).notNullable();
    t.string('primary_xml_sha256', 64).notNullable();
    t.string('takk_xml_sha256', 64).notNullable();
    t.string('primary_response_sha256', 64).notNullable();
    t.string('takk_response_sha256', 64).notNullable();
    t.string('primary_uid_sha256', 64).nullable();
    t.string('takk_uid_sha256', 64).nullable();
    t.string('approved_by', 200).notNullable();
    t.text('approval_notes').nullable();
    t.timestamp('approved_at').notNullable().defaultTo(db.fn.now());
    t.timestamps(true, true);
    t.unique(['company_id', 'reservation_id']);
    t.unique(['primary_document_id']);
    t.unique(['takk_document_id']);
    t.foreign('company_id').references('companies.id').onDelete('RESTRICT');
    t.foreign('primary_document_id').references('fiscal_documents.id').onDelete('RESTRICT');
    t.foreign('takk_document_id').references('fiscal_documents.id').onDelete('RESTRICT');
  });
  console.log('✅ Δημιουργήθηκε πίνακας: sandbox_signoffs');
}

async function ensureIntegrationChecksTable() {
  if (await db.schema.hasTable('integration_checks')) return;
  await db.schema.createTable('integration_checks', (t) => {
    t.increments('id').primary();
    t.string('check_key', 120).notNullable().unique();
    t.string('status', 20).notNullable();
    t.string('environment', 30).nullable();
    t.text('message').nullable();
    t.timestamp('checked_at').notNullable().defaultTo(db.fn.now());
    t.timestamps(true, true);
  });
  console.log('✅ Δημιουργήθηκε πίνακας: integration_checks');
}

async function ensureIntegrationTokensTable() {
  if (await db.schema.hasTable('integration_tokens')) return;
  await db.schema.createTable('integration_tokens', (t) => {
    t.string('provider', 40).primary();
    t.string('credential_fingerprint', 64).notNullable();
    t.text('encrypted_access_token').notNullable();
    t.timestamp('expires_at').notNullable();
    t.timestamps(true, true);
  });
  console.log('✅ Δημιουργήθηκε πίνακας: integration_tokens');
}

async function ensureReservationSnapshotsTable() {
  if (await db.schema.hasTable('reservation_snapshots')) {
    await ensureColumn('reservation_snapshots', 'invoice_type_override', (t) => t.string('invoice_type_override', 4).nullable());
    await ensureColumn('reservation_snapshots', 'invoice_series_override', (t) => t.string('invoice_series_override', 50).nullable());
    await ensureColumn('reservation_snapshots', 'counterpart_vat_override', (t) => t.string('counterpart_vat_override', 30).nullable());
    await ensureColumn('reservation_snapshots', 'counterpart_country_override', (t) => t.string('counterpart_country_override', 2).nullable());
    await ensureColumn('reservation_snapshots', 'counterpart_name_override', (t) => t.string('counterpart_name_override', 200).nullable());
    await ensureColumn('reservation_snapshots', 'fiscal_revision', (t) => t.integer('fiscal_revision').notNullable().defaultTo(0));
    await ensureColumn('reservation_snapshots', 'review_resolution', (t) => t.text('review_resolution').nullable());
    await ensureColumn('reservation_snapshots', 'reviewed_at', (t) => t.timestamp('reviewed_at').nullable());
    await ensureColumn('reservation_snapshots', 'platform_key', (t) => t.string('platform_key', 100).nullable());
    await ensureColumn('reservation_snapshots', 'source_key', (t) => t.string('source_key', 100).nullable());
    await ensureColumn('reservation_snapshots', 'financial_status', (t) => t.string('financial_status', 30).notNullable().defaultTo('pending'));
    await ensureColumn('reservation_snapshots', 'financial_profile_id', (t) => t.integer('financial_profile_id').unsigned().nullable());
    await ensureColumn('reservation_snapshots', 'financial_profile_version', (t) => t.integer('financial_profile_version').unsigned().nullable());
    await ensureColumn('reservation_snapshots', 'financial_profile_hash', (t) => t.string('financial_profile_hash', 64).nullable());
    await ensureColumn('reservation_snapshots', 'financial_evidence', (t) => t.text('financial_evidence').nullable());
    await ensureColumn('reservation_snapshots', 'financial_error', (t) => t.text('financial_error').nullable());
    await ensureColumn('reservation_snapshots', 'generation', (t) => t.integer('generation').notNullable().defaultTo(1));
    return;
  }
  await db.schema.createTable('reservation_snapshots', (t) => {
    t.increments('id').primary();
    t.string('reservation_id', 120).notNullable().unique();
    t.integer('company_id').unsigned().notNullable();
    t.integer('listing_id').unsigned().notNullable();
    t.string('listing_id_guesty', 120).notNullable();
    t.string('status', 40).nullable();
    t.string('source', 100).nullable();
    t.date('check_in').notNullable();
    t.date('check_out').notNullable().index();
    t.string('payload_hash', 64).notNullable();
    t.text('normalized_payload').notNullable();
    t.string('invoice_type_override', 4).nullable();
    t.string('invoice_series_override', 50).nullable();
    t.string('counterpart_vat_override', 30).nullable();
    t.string('counterpart_country_override', 2).nullable();
    t.string('counterpart_name_override', 200).nullable();
    t.integer('fiscal_revision').notNullable().defaultTo(0);
    t.text('review_resolution').nullable();
    t.timestamp('reviewed_at').nullable();
    t.string('platform_key', 100).nullable();
    t.string('source_key', 100).nullable();
    t.string('financial_status', 30).notNullable().defaultTo('pending');
    t.integer('financial_profile_id').unsigned().nullable();
    t.integer('financial_profile_version').unsigned().nullable();
    t.string('financial_profile_hash', 64).nullable();
    t.text('financial_evidence').nullable();
    t.text('financial_error').nullable();
    t.integer('generation').notNullable().defaultTo(1);
    t.timestamp('materialized_at').nullable();
    t.boolean('requires_review').notNullable().defaultTo(false);
    t.text('last_error').nullable();
    t.timestamps(true, true);
    t.foreign('company_id').references('companies.id').onDelete('RESTRICT');
    t.foreign('listing_id').references('listings.id').onDelete('RESTRICT');
  });
  console.log('✅ Δημιουργήθηκε πίνακας: reservation_snapshots');
}

async function ensureFinancialProfilesTables() {
  if (!await db.schema.hasTable('financial_profiles')) {
    await db.schema.createTable('financial_profiles', (t) => {
      t.increments('id').primary();
      t.integer('listing_id').unsigned().notNullable();
      t.string('platform_key', 100).notNullable();
      t.string('source_key', 100).notNullable();
      t.integer('version').unsigned().notNullable();
      t.enum('status', ['draft', 'approved', 'suspended']).notNullable().defaultTo('draft').index();
      t.string('currency', 3).notNullable().defaultTo('EUR');
      t.enum('strategy', ['folio_rules', 'reservation_total']).notNullable();
      t.text('line_rules').notNullable().defaultTo('[]');
      t.decimal('tolerance', 12, 2).notNullable().defaultTo(0);
      t.integer('minimum_samples').unsigned().notNullable().defaultTo(3);
      t.string('config_hash', 64).notNullable();
      t.string('approved_by', 200).nullable();
      t.text('approval_notes').nullable();
      t.timestamp('approved_at').nullable();
      t.timestamps(true, true);
      t.unique(['listing_id', 'platform_key', 'source_key', 'version']);
      t.foreign('listing_id').references('listings.id').onDelete('CASCADE');
    });
    console.log('✅ Δημιουργήθηκε πίνακας: financial_profiles');
  }

  if (!await db.schema.hasTable('financial_calibration_samples')) {
    await db.schema.createTable('financial_calibration_samples', (t) => {
      t.increments('id').primary();
      t.integer('profile_id').unsigned().notNullable();
      t.string('reservation_id', 120).notNullable();
      t.decimal('expected_amount', 12, 2).notNullable();
      t.decimal('computed_amount', 12, 2).notNullable();
      t.decimal('delta_amount', 12, 2).notNullable();
      t.boolean('passed').notNullable();
      t.string('channel_key', 100).notNullable();
      t.string('currency', 3).notNullable();
      t.text('line_evidence').notNullable().defaultTo('[]');
      t.string('payload_hash', 64).notNullable();
      t.timestamp('captured_at').notNullable().defaultTo(db.fn.now());
      t.timestamps(true, true);
      t.unique(['profile_id', 'reservation_id']);
      t.foreign('profile_id').references('financial_profiles.id').onDelete('CASCADE');
    });
    console.log('✅ Δημιουργήθηκε πίνακας: financial_calibration_samples');
  }
}

async function ensureListingBillingRulesTable() {
  if (await db.schema.hasTable('listing_billing_rules')) {
    await ensureColumn('listing_billing_rules', 'series', (t) => t.string('series', 50).nullable());
    return;
  }
  await db.schema.createTable('listing_billing_rules', (t) => {
    t.increments('id').primary();
    t.integer('listing_id').unsigned().notNullable();
    t.string('guesty_source', 100).notNullable();
    t.string('invoice_type', 4).notNullable();
    t.string('series', 50).nullable();
    t.string('counterpart_vat_number', 30).nullable();
    t.string('counterpart_country', 2).nullable();
    t.string('counterpart_name', 200).nullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.unique(['listing_id', 'guesty_source']);
    t.foreign('listing_id').references('listings.id').onDelete('CASCADE');
  });
  console.log('✅ Δημιουργήθηκε πίνακας: listing_billing_rules');
}

async function ensureListingChannelBillingRulesTable() {
  if (await db.schema.hasTable('listing_channel_billing_rules')) return;
  await db.schema.createTable('listing_channel_billing_rules', (t) => {
    t.increments('id').primary();
    t.integer('listing_id').unsigned().notNullable();
    t.string('guesty_platform', 100).notNullable();
    t.string('guesty_source', 100).notNullable();
    t.string('invoice_type', 4).notNullable();
    t.string('series', 50).nullable();
    t.string('counterpart_vat_number', 30).nullable();
    t.string('counterpart_country', 2).nullable();
    t.string('counterpart_name', 200).nullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.unique(['listing_id', 'guesty_platform', 'guesty_source']);
    t.foreign('listing_id').references('listings.id').onDelete('CASCADE');
  });
  console.log('✅ Δημιουργήθηκε πίνακας: listing_channel_billing_rules');
}

async function ensureCompaniesTable() {
  const exists = await db.schema.hasTable('companies');
  if (!exists) {
    await db.schema.createTable('companies', (t) => {
      t.increments('id').primary();
      t.string('company_name').notNullable();
      t.string('vat_number', 9).notNullable().unique();
      t.string('aade_user_id').notNullable();
      t.string('aade_subscription_key').notNullable();
      t.string('invoice_series').notNullable().defaultTo('A');
      t.integer('invoice_counter').notNullable().defaultTo(0);
      t.string('pdf_brand_name', 200).nullable();
      t.string('pdf_activity', 200).nullable();
      t.string('pdf_address', 300).nullable();
      t.string('pdf_tax_office', 100).nullable();
      t.string('pdf_phone', 50).nullable();
      t.string('pdf_email', 200).nullable();
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);
    });
    console.log('✅ Δημιουργήθηκε πίνακας: companies');
    return;
  }

  await ensureColumn('companies', 'pdf_brand_name', (t) => t.string('pdf_brand_name', 200).nullable());
  await ensureColumn('companies', 'pdf_activity', (t) => t.string('pdf_activity', 200).nullable());
  await ensureColumn('companies', 'pdf_address', (t) => t.string('pdf_address', 300).nullable());
  await ensureColumn('companies', 'pdf_tax_office', (t) => t.string('pdf_tax_office', 100).nullable());
  await ensureColumn('companies', 'pdf_phone', (t) => t.string('pdf_phone', 50).nullable());
  await ensureColumn('companies', 'pdf_email', (t) => t.string('pdf_email', 200).nullable());
}

async function ensureListingsTable() {
  const exists = await db.schema.hasTable('listings');
  if (!exists) {
    await db.schema.createTable('listings', (t) => {
      t.increments('id').primary();
      t.integer('company_id').unsigned().notNullable();
      t.string('listing_id_guesty').notNullable().unique();
      t.enum('property_type', ['villa', 'apartment']).notNullable().defaultTo('apartment');
      t.string('default_invoice_type', 4).notNullable().defaultTo('11.2');
      t.string('invoice_counterpart_vat_number', 30).nullable();
      t.string('invoice_counterpart_country', 2).nullable();
      t.string('invoice_counterpart_name', 200).nullable();
      t.decimal('climate_fee_high', 10, 2).nullable();
      t.decimal('climate_fee_low', 10, 2).nullable();
      t.integer('climate_fee_high_category').nullable();
      t.integer('climate_fee_low_category').nullable();
      t.string('climate_fee_series', 50).notNullable().defaultTo('TAKK');
      t.integer('payment_method_type').notNullable().defaultTo(1);
      t.string('payment_method_info', 200).nullable();
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);
      t.foreign('company_id').references('companies.id').onDelete('CASCADE');
    });
    console.log('✅ Δημιουργήθηκε πίνακας: listings');
    return;
  }

  await ensureColumn('listings', 'default_invoice_type', (t) => t.string('default_invoice_type', 4).notNullable().defaultTo('11.2'));
  await ensureColumn('listings', 'invoice_counterpart_vat_number', (t) => t.string('invoice_counterpart_vat_number', 30).nullable());
  await ensureColumn('listings', 'invoice_counterpart_country', (t) => t.string('invoice_counterpart_country', 2).nullable());
  await ensureColumn('listings', 'invoice_counterpart_name', (t) => t.string('invoice_counterpart_name', 200).nullable());
  await ensureColumn('listings', 'climate_fee_high', (t) => t.decimal('climate_fee_high', 10, 2).nullable());
  await ensureColumn('listings', 'climate_fee_low', (t) => t.decimal('climate_fee_low', 10, 2).nullable());
  await ensureColumn('listings', 'climate_fee_high_category', (t) => t.integer('climate_fee_high_category').nullable());
  await ensureColumn('listings', 'climate_fee_low_category', (t) => t.integer('climate_fee_low_category').nullable());
  await ensureColumn('listings', 'climate_fee_series', (t) => t.string('climate_fee_series', 50).notNullable().defaultTo('TAKK'));
  await ensureColumn('listings', 'payment_method_type', (t) => t.integer('payment_method_type').notNullable().defaultTo(1));
  await ensureColumn('listings', 'payment_method_info', (t) => t.string('payment_method_info', 200).nullable());
}

// Προσωρινά το κρατάμε για backward compatibility / migration μόνο.
async function ensureLegacyTenantsTable() {
  const exists = await db.schema.hasTable('tenants');
  if (!exists) {
    await db.schema.createTable('tenants', (t) => {
      t.increments('id').primary();
      t.string('listing_id_guesty').notNullable().unique();
      t.string('company_name').notNullable();
      t.string('vat_number', 9).notNullable();
      t.string('aade_user_id').notNullable();
      t.string('aade_subscription_key').notNullable();
      t.enum('property_type', ['villa', 'apartment']).notNullable().defaultTo('apartment');
      t.string('invoice_series').notNullable().defaultTo('A');
      t.integer('invoice_counter').notNullable().defaultTo(0);
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);
    });
    console.log('✅ Δημιουργήθηκε legacy πίνακας: tenants');
  }
}

async function ensureInvoicesTable() {
  const exists = await db.schema.hasTable('invoices');
  if (!exists) {
    await db.schema.createTable('invoices', (t) => {
      t.increments('id').primary();
      t.integer('company_id').unsigned().nullable();
      t.integer('listing_id').unsigned().nullable();
      t.string('reservation_id').notNullable().unique();
      t.string('listing_id_guesty').notNullable();
      t.string('vat_number', 9).notNullable();
      t.string('invoice_series').notNullable();
      t.integer('invoice_aa').notNullable();
      t.decimal('net_value', 10, 2).notNullable();
      t.decimal('climate_fee', 10, 2).notNullable();
      t.decimal('total_gross', 10, 2).notNullable();
      t.string('mydata_mark');
      t.string('mydata_uid');
      t.enum('status', ['pending', 'sent', 'failed']).notNullable().defaultTo('pending');
      t.text('error_message');
      t.text('xml_payload');
      t.timestamp('sent_at');
      t.timestamps(true, true);
      t.foreign('company_id').references('companies.id').onDelete('SET NULL');
      t.foreign('listing_id').references('listings.id').onDelete('SET NULL');
    });
    console.log('✅ Δημιουργήθηκε πίνακας: invoices');
    return;
  }

  await ensureColumn('invoices', 'company_id', (t) => t.integer('company_id').unsigned().nullable());
  await ensureColumn('invoices', 'listing_id', (t) => t.integer('listing_id').unsigned().nullable());
}

async function ensureFiscalDocumentsTable() {
  const exists = await db.schema.hasTable('fiscal_documents');
  if (exists) {
    await ensureColumn('fiscal_documents', 'cancellation_mark', (t) => t.string('cancellation_mark', 30).nullable());
    await ensureColumn('fiscal_documents', 'cancelled_at', (t) => t.timestamp('cancelled_at').nullable());
    await ensureColumn('fiscal_documents', 'cancellation_status', (t) => t.string('cancellation_status', 20).notNullable().defaultTo('none'));
    await ensureColumn('fiscal_documents', 'cancellation_error', (t) => t.text('cancellation_error').nullable());
    await ensureColumn('fiscal_documents', 'cancellation_attempt_at', (t) => t.timestamp('cancellation_attempt_at').nullable());
    await ensureColumn('fiscal_documents', 'verification_status', (t) => t.string('verification_status', 20).notNullable().defaultTo('pending'));
    await ensureColumn('fiscal_documents', 'verified_at', (t) => t.timestamp('verified_at').nullable());
    await ensureColumn('fiscal_documents', 'verification_error', (t) => t.text('verification_error').nullable());
    await ensureColumn('fiscal_documents', 'retryable', (t) => t.boolean('retryable').notNullable().defaultTo(true));
    await ensureColumn('fiscal_documents', 'transmission_uncertain', (t) => t.boolean('transmission_uncertain').notNullable().defaultTo(false));
    await ensureColumn('fiscal_documents', 'transmission_token', (t) => t.string('transmission_token', 64).nullable());
    await ensureColumn('fiscal_documents', 'mydata_environment', (t) => t.string('mydata_environment', 20).nullable());
    await ensureColumn('fiscal_documents', 'cancellation_retryable', (t) => t.boolean('cancellation_retryable').notNullable().defaultTo(true));
    await ensureColumn('fiscal_documents', 'cancellation_uncertain', (t) => t.boolean('cancellation_uncertain').notNullable().defaultTo(false));
    return;
  }

  await db.schema.createTable('fiscal_documents', (t) => {
    t.increments('id').primary();
    t.string('document_key', 200).notNullable().unique();
    t.integer('company_id').unsigned().notNullable();
    t.integer('listing_id').unsigned().notNullable();
    t.string('reservation_id', 120).notNullable().index();
    t.string('document_kind', 30).notNullable();
    t.string('document_type', 10).notNullable();
    t.string('series', 50).notNullable();
    t.integer('aa').notNullable();
    t.date('issue_date').notNullable().index();
    t.integer('related_document_id').unsigned().nullable();
    t.string('correlated_mark', 30).nullable();
    t.decimal('net_value', 12, 2).notNullable().defaultTo(0);
    t.decimal('vat_amount', 12, 2).notNullable().defaultTo(0);
    t.decimal('other_taxes_amount', 12, 2).notNullable().defaultTo(0);
    t.decimal('gross_value', 12, 2).notNullable().defaultTo(0);
    t.enum('status', ['pending', 'transmitting', 'sent', 'failed', 'cancelled']).notNullable().defaultTo('pending').index();
    t.text('xml_payload').notNullable();
    t.text('source_payload').nullable();
    t.string('mydata_mark', 30).nullable();
    t.string('mydata_uid', 50).nullable();
    t.text('mydata_qr_url').nullable();
    t.string('cancellation_mark', 30).nullable();
    t.timestamp('cancelled_at').nullable();
    t.string('cancellation_status', 20).notNullable().defaultTo('none');
    t.text('cancellation_error').nullable();
    t.timestamp('cancellation_attempt_at').nullable();
    t.boolean('cancellation_retryable').notNullable().defaultTo(true);
    t.boolean('cancellation_uncertain').notNullable().defaultTo(false);
    t.string('verification_status', 20).notNullable().defaultTo('pending');
    t.timestamp('verified_at').nullable();
    t.text('verification_error').nullable();
    t.text('mydata_response').nullable();
    t.string('mydata_environment', 20).nullable();
    t.text('error_message').nullable();
    t.integer('attempt_count').notNullable().defaultTo(0);
    t.boolean('retryable').notNullable().defaultTo(true);
    t.boolean('transmission_uncertain').notNullable().defaultTo(false);
    t.string('transmission_token', 64).nullable();
    t.timestamp('last_attempt_at').nullable();
    t.timestamp('sent_at').nullable();
    t.timestamps(true, true);
    t.unique(['company_id', 'document_type', 'series', 'aa'], 'fiscal_documents_company_type_series_aa_uq');
    t.foreign('company_id').references('companies.id').onDelete('RESTRICT');
    t.foreign('listing_id').references('listings.id').onDelete('RESTRICT');
    t.foreign('related_document_id').references('fiscal_documents.id').onDelete('RESTRICT');
  });
  console.log('✅ Δημιουργήθηκε πίνακας: fiscal_documents');
}

async function ensureDocumentSequencesTable() {
  const exists = await db.schema.hasTable('document_sequences');
  if (exists) return;

  await db.schema.createTable('document_sequences', (t) => {
    t.increments('id').primary();
    t.integer('company_id').unsigned().notNullable();
    t.string('document_type', 10).notNullable();
    t.string('series', 50).notNullable();
    t.integer('last_number').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.unique(['company_id', 'document_type', 'series'], 'document_sequences_company_type_series_uq');
    t.foreign('company_id').references('companies.id').onDelete('CASCADE');
  });
  console.log('✅ Δημιουργήθηκε πίνακας: document_sequences');
}

async function ensureDailyCloseTables() {
  if (!await db.schema.hasTable('daily_close_runs')) {
    await db.schema.createTable('daily_close_runs', (t) => {
      t.increments('id').primary();
      t.integer('company_id').unsigned().notNullable();
      t.date('business_date').notNullable();
      t.enum('status', ['running', 'completed', 'partial', 'failed']).notNullable().defaultTo('running');
      t.integer('document_count').notNullable().defaultTo(0);
      t.integer('sent_count').notNullable().defaultTo(0);
      t.integer('failed_count').notNullable().defaultTo(0);
      t.integer('materialization_failure_count').notNullable().defaultTo(0);
      t.timestamp('started_at').notNullable().defaultTo(db.fn.now());
      t.timestamp('completed_at').nullable();
      t.string('lease_token', 64).nullable();
      t.timestamp('lease_expires_at').nullable();
      t.bigInteger('lease_expires_at_ms').nullable();
      t.timestamps(true, true);
      t.unique(['company_id', 'business_date'], 'daily_close_runs_company_date_uq');
      t.foreign('company_id').references('companies.id').onDelete('RESTRICT');
    });
    console.log('✅ Δημιουργήθηκε πίνακας: daily_close_runs');
  } else {
    await ensureColumn('daily_close_runs', 'lease_token', (t) => t.string('lease_token', 64).nullable());
    await ensureColumn('daily_close_runs', 'lease_expires_at', (t) => t.timestamp('lease_expires_at').nullable());
    await ensureColumn('daily_close_runs', 'lease_expires_at_ms', (t) => t.bigInteger('lease_expires_at_ms').nullable());
    await ensureColumn('daily_close_runs', 'materialization_failure_count', (t) => t.integer('materialization_failure_count').notNullable().defaultTo(0));
  }

  if (!await db.schema.hasTable('daily_close_items')) {
    await db.schema.createTable('daily_close_items', (t) => {
      t.increments('id').primary();
      t.integer('run_id').unsigned().notNullable();
      t.integer('document_id').unsigned().notNullable();
      t.string('result', 20).notNullable();
      t.text('message').nullable();
      t.timestamps(true, true);
      t.unique(['run_id', 'document_id']);
      t.foreign('run_id').references('daily_close_runs.id').onDelete('CASCADE');
      t.foreign('document_id').references('fiscal_documents.id').onDelete('RESTRICT');
    });
    console.log('✅ Δημιουργήθηκε πίνακας: daily_close_items');
  }
}

// -------------------------------------------------------------------
// Legacy migration: tenants -> companies + listings
// Safe to run multiple times.
// -------------------------------------------------------------------
async function migrateLegacyTenantsToNormalizedModel() {
  const tenantCountRow = await db('tenants').count({ count: '*' }).first();
  const legacyCount = Number(tenantCountRow?.count || 0);
  if (legacyCount === 0) return;

  const legacyTenants = await db('tenants').select('*').orderBy('id', 'asc');

  for (const tenant of legacyTenants) {
    let company = await db('companies')
      .where({ vat_number: tenant.vat_number })
      .first();

    if (!company) {
      const companyId = insertedId(await db('companies').insert({
        company_name: tenant.company_name,
        vat_number: tenant.vat_number,
        aade_user_id: encryptSecret(tenant.aade_user_id, companySecretContext(tenant, 'aade_user_id')),
        aade_subscription_key: encryptSecret(tenant.aade_subscription_key, companySecretContext(tenant, 'aade_subscription_key')),
        invoice_series: tenant.invoice_series || 'A',
        invoice_counter: tenant.invoice_counter || 0,
        active: tenant.active,
      }).returning('id'));
      company = await db('companies').where({ id: companyId }).first();
      console.log(`✅ Migrated company ${tenant.vat_number} από legacy tenants`);
    }

    const listing = await db('listings')
      .where({ listing_id_guesty: tenant.listing_id_guesty })
      .first();

    if (!listing) {
      await db('listings').insert({
        company_id: company.id,
        listing_id_guesty: tenant.listing_id_guesty,
        property_type: tenant.property_type || 'apartment',
        active: tenant.active,
      });
      console.log(`✅ Migrated listing ${tenant.listing_id_guesty} από legacy tenants`);
    }
  }
}

async function migrateCredentialsToEncryptedStorage() {
  for (const table of ['companies', 'tenants']) {
    const rows = await db(table).select('id', 'vat_number', 'aade_user_id', 'aade_subscription_key');
    for (const row of rows) {
      const updates = {};
      const contextFor = (field) => table === 'companies' ? companySecretContext(row, field) : null;
      if (row.aade_user_id) {
        const context = contextFor('aade_user_id');
        const encrypted = isEncrypted(row.aade_user_id) ? reencryptSecret(row.aade_user_id, context) : encryptSecret(row.aade_user_id, context);
        if (encrypted !== row.aade_user_id) updates.aade_user_id = encrypted;
      }
      if (row.aade_subscription_key) {
        const context = contextFor('aade_subscription_key');
        const encrypted = isEncrypted(row.aade_subscription_key) ? reencryptSecret(row.aade_subscription_key, context) : encryptSecret(row.aade_subscription_key, context);
        if (encrypted !== row.aade_subscription_key) updates.aade_subscription_key = encrypted;
      }
      if (Object.keys(updates).length) await db(table).where({ id: row.id }).update(updates);
    }
  }
  if (await db.schema.hasTable('integration_tokens')) {
    const tokens = await db('integration_tokens').select('provider', 'encrypted_access_token');
    for (const token of tokens) {
      const encrypted = reencryptSecret(token.encrypted_access_token, `integration-token:${token.provider}`);
      if (encrypted !== token.encrypted_access_token) {
        await db('integration_tokens').where({ provider: token.provider }).update({ encrypted_access_token: encrypted, updated_at: db.fn.now() });
      }
    }
  }
}

// -------------------------------------------------------------------
// Backward-compatible query exports
// Μέχρι το 2.2 κρατάμε το παλιό interface ώστε να συνεχίζει να ανογει ο server.
// -------------------------------------------------------------------

/**
 * Legacy-compatible tenant lookup based on normalized tables.
 * Επιστρέφει merged object shape για να μη σπάσει το current webhook.
 */
async function getTenantByListingId(listingId) {
  const row = await db('listings as l')
    .join('companies as c', 'l.company_id', 'c.id')
    .where({ 'l.listing_id_guesty': listingId, 'l.active': true, 'c.active': true })
    .select(
      'c.id as id',
      'l.id as listing_id',
      'l.listing_id_guesty',
      'c.company_name',
      'c.vat_number',
      'c.aade_user_id',
      'c.aade_subscription_key',
      'l.property_type',
      'c.invoice_series',
      'c.invoice_counter',
      'c.active'
    )
    .first();

  if (row) return row;

  // Fallback μόνο αν υπάρχουν legacy rows που δεν πέρασαν ακόμα στο normalized model.
  return db('tenants')
    .where({ listing_id_guesty: listingId, active: true })
    .first();
}

/**
 * Legacy-compatible increment — πλέον αυξάνει τον counter της εταιρείας.
 */
async function incrementInvoiceCounter(companyId) {
  const company = await db('companies').where({ id: companyId }).first('id');
  if (company) {
    await db('companies').where({ id: companyId }).increment('invoice_counter', 1);
    const row = await db('companies').where({ id: companyId }).first('invoice_counter');
    return row.invoice_counter;
  }

  // Fallback σε legacy tenant row αν χρειαστεί.
  await db('tenants').where({ id: companyId }).increment('invoice_counter', 1);
  const legacyRow = await db('tenants').where({ id: companyId }).first('invoice_counter');
  return legacyRow?.invoice_counter;
}

async function findInvoiceByReservationId(reservationId) {
  return db('invoices').where({ reservation_id: reservationId }).first();
}

async function createInvoiceRecord(data) {
  const id = insertedId(await db('invoices').insert(data).returning('id'));
  return id;
}

async function updateInvoiceRecord(invoiceId, updates) {
  await db('invoices').where({ id: invoiceId }).update({
    ...updates,
    updated_at: db.fn.now(),
  });
}

module.exports = {
  db,
  initSchema,
  getTenantByListingId,
  incrementInvoiceCounter,
  findInvoiceByReservationId,
  createInvoiceRecord,
  updateInvoiceRecord,
};

'use strict';

require('dotenv').config();
const knex = require('knex');
const path = require('path');

// -------------------------------------------------------------------
// Knex config — SQLite τώρα, PostgreSQL με 1 αλλαγή στο DB_CLIENT
// Για PostgreSQL: DB_CLIENT=pg, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
// -------------------------------------------------------------------
const db = knex({
  client: process.env.DB_CLIENT || 'better-sqlite3',
  connection: process.env.DB_CLIENT === 'pg'
    ? {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'guesty_mydata',
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      }
    : {
        filename: path.resolve(
          process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bridge.db')
        ),
      },
  useNullAsDefault: true,
  pool: process.env.DB_CLIENT === 'pg'
    ? { min: 2, max: 10 }
    : { min: 1, max: 1 },
});

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

// -------------------------------------------------------------------
// Schema — normalized model
// companies: 1 row per legal entity / ΑΦΜ
// listings: 1 row per Guesty listing, mapped to company
// invoices: invoice transmission history
// -------------------------------------------------------------------
async function initSchema() {
  await ensureCompaniesTable();
  await ensureListingsTable();
  await ensureLegacyTenantsTable();
  await ensureInvoicesTable();
  await migrateLegacyTenantsToNormalizedModel();
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
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);
    });
    console.log('✅ Δημιουργήθηκε πίνακας: companies');
  }
}

async function ensureListingsTable() {
  const exists = await db.schema.hasTable('listings');
  if (!exists) {
    await db.schema.createTable('listings', (t) => {
      t.increments('id').primary();
      t.integer('company_id').unsigned().notNullable();
      t.string('listing_id_guesty').notNullable().unique();
      t.enum('property_type', ['villa', 'apartment']).notNullable().defaultTo('apartment');
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);
      t.foreign('company_id').references('companies.id').onDelete('CASCADE');
    });
    console.log('✅ Δημιουργήθηκε πίνακας: listings');
  }
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
      const [companyId] = await db('companies').insert({
        company_name: tenant.company_name,
        vat_number: tenant.vat_number,
        aade_user_id: tenant.aade_user_id,
        aade_subscription_key: tenant.aade_subscription_key,
        invoice_series: tenant.invoice_series || 'A',
        invoice_counter: tenant.invoice_counter || 0,
        active: tenant.active,
      });
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
  const [id] = await db('invoices').insert(data);
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

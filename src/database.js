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
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'guesty_mydata',
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      }
    : {
        filename: path.resolve(
          process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bridge.db')
        ),
      },
  useNullAsDefault: true, // απαραίτητο για SQLite
  pool: process.env.DB_CLIENT === 'pg'
    ? { min: 2, max: 10 }
    : { min: 1, max: 1 },
});

// -------------------------------------------------------------------
// Schema — δημιουργία πινάκων αν δεν υπάρχουν
// -------------------------------------------------------------------
async function initSchema() {
  // tenants: ένα ΑΦΜ = ένα row, πολλά listing_ids μπορούν να δείχνουν σε αυτό
  const hasTenants = await db.schema.hasTable('tenants');
  if (!hasTenants) {
    await db.schema.createTable('tenants', (t) => {
      t.increments('id').primary();
      t.string('listing_id_guesty').notNullable().unique(); // FK από Guesty
      t.string('company_name').notNullable();
      t.string('vat_number', 9).notNullable();              // ΑΦΜ — 9 ψηφία
      t.string('aade_user_id').notNullable();
      t.string('aade_subscription_key').notNullable();
      t.enum('property_type', ['villa', 'apartment']).notNullable().defaultTo('apartment');
      t.string('invoice_series').notNullable().defaultTo('A');  // Σειρά παραστατικού
      t.integer('invoice_counter').notNullable().defaultTo(0);  // Αύξων αριθμός
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true); // created_at, updated_at
    });
    console.log('✅ Δημιουργήθηκε πίνακας: tenants');
  }

  // invoices: log κάθε επιτυχημένης / αποτυχημένης διαβίβασης
  const hasInvoices = await db.schema.hasTable('invoices');
  if (!hasInvoices) {
    await db.schema.createTable('invoices', (t) => {
      t.increments('id').primary();
      t.string('reservation_id').notNullable().unique(); // idempotency key
      t.string('listing_id_guesty').notNullable();
      t.string('vat_number', 9).notNullable();
      t.string('invoice_series').notNullable();
      t.integer('invoice_aa').notNullable();
      t.decimal('net_value', 10, 2).notNullable();
      t.decimal('climate_fee', 10, 2).notNullable();
      t.decimal('total_gross', 10, 2).notNullable();
      t.string('mydata_mark');          // MARK από ΑΑΔΕ — null αν αποτυχία
      t.string('mydata_uid');           // UID από ΑΑΔΕ
      t.enum('status', ['pending', 'sent', 'failed']).notNullable().defaultTo('pending');
      t.text('error_message');          // λεπτομέρειες σφάλματος
      t.text('xml_payload');            // αρχείο XML που στάλθηκε (για debugging)
      t.timestamp('sent_at');
      t.timestamps(true, true);
    });
    console.log('✅ Δημιουργήθηκε πίνακας: invoices');
  }
}

// -------------------------------------------------------------------
// Queries
// -------------------------------------------------------------------

/**
 * Επιστρέφει τον tenant βάσει listing_id του Guesty
 * @param {string} listingId
 * @returns {Promise<object|null>}
 */
async function getTenantByListingId(listingId) {
  return db('tenants')
    .where({ listing_id_guesty: listingId, active: true })
    .first();
}

/**
 * Αύξηση invoice counter (atomic) — επιστρέφει τον νέο αριθμό
 * @param {number} tenantId
 * @returns {Promise<number>}
 */
async function incrementInvoiceCounter(tenantId) {
  await db('tenants')
    .where({ id: tenantId })
    .increment('invoice_counter', 1);
  const row = await db('tenants').where({ id: tenantId }).first('invoice_counter');
  return row.invoice_counter;
}

/**
 * Ελέγχει αν η κράτηση έχει ήδη τιμολογηθεί (idempotency)
 * @param {string} reservationId
 * @returns {Promise<object|null>}
 */
async function findInvoiceByReservationId(reservationId) {
  return db('invoices').where({ reservation_id: reservationId }).first();
}

/**
 * Αποθηκεύει νέα εγγραφή invoice
 * @param {object} data
 * @returns {Promise<number>} — inserted id
 */
async function createInvoiceRecord(data) {
  const [id] = await db('invoices').insert(data);
  return id;
}

/**
 * Ενημερώνει εγγραφή invoice μετά την απάντηση της ΑΑΔΕ
 * @param {number} invoiceId
 * @param {object} updates
 */
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

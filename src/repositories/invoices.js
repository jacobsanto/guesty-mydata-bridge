'use strict';

const { db } = require('../database');

async function listInvoices(filters = {}) {
  const query = db('invoices as i')
    .leftJoin('companies as c', 'i.company_id', 'c.id')
    .leftJoin('listings as l', 'i.listing_id', 'l.id')
    .select(
      'i.*',
      'c.company_name',
      'c.vat_number as company_vat_number',
      'l.listing_id_guesty as mapped_listing_id_guesty'
    )
    .orderBy('i.id', 'desc');

  if (filters.status) {
    query.where('i.status', filters.status);
  }

  if (filters.companyId) {
    query.where('i.company_id', filters.companyId);
  }

  return query;
}

async function getInvoiceById(id) {
  return db('invoices').where({ id }).first();
}

async function getInvoiceByReservationId(reservationId) {
  return db('invoices').where({ reservation_id: reservationId }).first();
}

async function createInvoice(data) {
  const [id] = await db('invoices').insert(data);
  return getInvoiceById(id);
}

async function updateInvoice(id, data) {
  await db('invoices').where({ id }).update({
    ...data,
    updated_at: db.fn.now(),
  });
  return getInvoiceById(id);
}

module.exports = {
  listInvoices,
  getInvoiceById,
  getInvoiceByReservationId,
  createInvoice,
  updateInvoice,
};

'use strict';

const { db } = require('../database');

async function listCompanies() {
  return db('companies').select('*').orderBy('company_name', 'asc');
}

async function getCompanyById(id) {
  return db('companies').where({ id }).first();
}

async function getCompanyByVatNumber(vatNumber) {
  return db('companies').where({ vat_number: vatNumber }).first();
}

async function createCompany(data) {
  const [id] = await db('companies').insert(data);
  return getCompanyById(id);
}

async function updateCompany(id, data) {
  await db('companies').where({ id }).update({
    ...data,
    updated_at: db.fn.now(),
  });
  return getCompanyById(id);
}

async function incrementCompanyInvoiceCounter(companyId) {
  await db('companies').where({ id: companyId }).increment('invoice_counter', 1);
  const row = await db('companies').where({ id: companyId }).first('invoice_counter');
  return row?.invoice_counter;
}

module.exports = {
  listCompanies,
  getCompanyById,
  getCompanyByVatNumber,
  createCompany,
  updateCompany,
  incrementCompanyInvoiceCounter,
};

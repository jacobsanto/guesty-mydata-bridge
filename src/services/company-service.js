'use strict';

const {
  listCompanies,
  getCompanyById,
  getCompanyByVatNumber,
  createCompany,
  updateCompany,
} = require('../repositories/companies');

function sanitizeVatNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function validateVatNumber(vatNumber) {
  return /^\d{9}$/.test(vatNumber);
}

function redactSubscriptionKey(key) {
  if (!key) return null;
  const normalized = String(key);
  if (normalized.length <= 8) return '********';
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function serializeCompany(company, { includeSecrets = false } = {}) {
  if (!company) return null;

  return {
    id: company.id,
    company_name: company.company_name,
    vat_number: company.vat_number,
    aade_user_id: company.aade_user_id,
    aade_subscription_key: includeSecrets
      ? company.aade_subscription_key
      : redactSubscriptionKey(company.aade_subscription_key),
    invoice_series: company.invoice_series,
    invoice_counter: company.invoice_counter,
    active: company.active,
    created_at: company.created_at,
    updated_at: company.updated_at,
  };
}

function validateCreatePayload(payload) {
  const errors = [];
  const vatNumber = sanitizeVatNumber(payload.vat_number);

  if (!payload.company_name || !String(payload.company_name).trim()) {
    errors.push('company_name is required');
  }
  if (!validateVatNumber(vatNumber)) {
    errors.push('vat_number must be exactly 9 digits');
  }
  if (!payload.aade_user_id || !String(payload.aade_user_id).trim()) {
    errors.push('aade_user_id is required');
  }
  if (!payload.aade_subscription_key || !String(payload.aade_subscription_key).trim()) {
    errors.push('aade_subscription_key is required');
  }
  if (payload.invoice_series && String(payload.invoice_series).trim().length > 20) {
    errors.push('invoice_series must be <= 20 chars');
  }

  return {
    errors,
    normalized: {
      company_name: String(payload.company_name || '').trim(),
      vat_number: vatNumber,
      aade_user_id: String(payload.aade_user_id || '').trim(),
      aade_subscription_key: String(payload.aade_subscription_key || '').trim(),
      invoice_series: String(payload.invoice_series || 'A').trim() || 'A',
      active: payload.active === undefined ? true : Boolean(payload.active),
    },
  };
}

function validateUpdatePayload(payload) {
  const errors = [];
  const normalized = {};

  if ('company_name' in payload) {
    if (!String(payload.company_name || '').trim()) {
      errors.push('company_name cannot be empty');
    } else {
      normalized.company_name = String(payload.company_name).trim();
    }
  }

  if ('vat_number' in payload) {
    const vatNumber = sanitizeVatNumber(payload.vat_number);
    if (!validateVatNumber(vatNumber)) {
      errors.push('vat_number must be exactly 9 digits');
    } else {
      normalized.vat_number = vatNumber;
    }
  }

  if ('aade_user_id' in payload) {
    if (!String(payload.aade_user_id || '').trim()) {
      errors.push('aade_user_id cannot be empty');
    } else {
      normalized.aade_user_id = String(payload.aade_user_id).trim();
    }
  }

  if ('aade_subscription_key' in payload) {
    if (!String(payload.aade_subscription_key || '').trim()) {
      errors.push('aade_subscription_key cannot be empty');
    } else {
      normalized.aade_subscription_key = String(payload.aade_subscription_key).trim();
    }
  }

  if ('invoice_series' in payload) {
    const value = String(payload.invoice_series || '').trim();
    if (!value) {
      errors.push('invoice_series cannot be empty');
    } else if (value.length > 20) {
      errors.push('invoice_series must be <= 20 chars');
    } else {
      normalized.invoice_series = value;
    }
  }

  if ('active' in payload) {
    normalized.active = Boolean(payload.active);
  }

  return { errors, normalized };
}

async function handleListCompanies() {
  const companies = await listCompanies();
  return companies.map((company) => serializeCompany(company));
}

async function handleGetCompany(id, options = {}) {
  const company = await getCompanyById(id);
  if (!company) {
    const error = new Error('Company not found');
    error.status = 404;
    throw error;
  }
  return serializeCompany(company, options);
}

async function handleCreateCompany(payload) {
  const { errors, normalized } = validateCreatePayload(payload);
  if (errors.length > 0) {
    const error = new Error(errors.join('; '));
    error.status = 400;
    throw error;
  }

  const existing = await getCompanyByVatNumber(normalized.vat_number);
  if (existing) {
    const error = new Error(`Company with VAT ${normalized.vat_number} already exists`);
    error.status = 409;
    throw error;
  }

  const company = await createCompany(normalized);
  return serializeCompany(company);
}

async function handleUpdateCompany(id, payload) {
  const existing = await getCompanyById(id);
  if (!existing) {
    const error = new Error('Company not found');
    error.status = 404;
    throw error;
  }

  const { errors, normalized } = validateUpdatePayload(payload);
  if (errors.length > 0) {
    const error = new Error(errors.join('; '));
    error.status = 400;
    throw error;
  }

  if (normalized.vat_number && normalized.vat_number !== existing.vat_number) {
    const vatConflict = await getCompanyByVatNumber(normalized.vat_number);
    if (vatConflict && vatConflict.id !== existing.id) {
      const error = new Error(`Company with VAT ${normalized.vat_number} already exists`);
      error.status = 409;
      throw error;
    }
  }

  const updated = await updateCompany(id, normalized);
  return serializeCompany(updated);
}

module.exports = {
  handleListCompanies,
  handleGetCompany,
  handleCreateCompany,
  handleUpdateCompany,
  serializeCompany,
  redactSubscriptionKey,
};

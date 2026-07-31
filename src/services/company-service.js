'use strict';

const {
  listCompanies,
  getCompanyById,
  getCompanyByVatNumber,
  createCompany,
  updateCompany,
} = require('../repositories/companies');
const { encryptSecret, decryptCompanySecret, companySecretContext } = require('../security/credentials');
const { deleteIntegrationChecks } = require('../repositories/integration-checks');
const { hasValidGreekVatChecksum, normalizeGreekVat } = require('../validation/fiscal-fields');
const { db } = require('../database');

function sanitizeVatNumber(value) {
  return normalizeGreekVat(value);
}

function validateVatNumber(vatNumber) {
  return hasValidGreekVatChecksum(vatNumber);
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
    aade_user_id: redactSubscriptionKey(company.aade_user_id),
    aade_subscription_key: includeSecrets
      ? undefined
      : redactSubscriptionKey(company.aade_subscription_key),
    invoice_series: company.invoice_series,
    invoice_counter: company.invoice_counter,
    pdf_brand_name: company.pdf_brand_name,
    pdf_activity: company.pdf_activity,
    pdf_address: company.pdf_address,
    pdf_tax_office: company.pdf_tax_office,
    pdf_phone: company.pdf_phone,
    pdf_email: company.pdf_email,
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
    errors.push('vat_number must be a valid 9-digit Greek VAT number');
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
      pdf_brand_name: String(payload.pdf_brand_name || '').trim() || null,
      pdf_activity: String(payload.pdf_activity || '').trim() || null,
      pdf_address: String(payload.pdf_address || '').trim() || null,
      pdf_tax_office: String(payload.pdf_tax_office || '').trim() || null,
      pdf_phone: String(payload.pdf_phone || '').trim() || null,
      pdf_email: String(payload.pdf_email || '').trim() || null,
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
      errors.push('vat_number must be a valid 9-digit Greek VAT number');
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

  const profileLimits = {
    pdf_brand_name: 200,
    pdf_activity: 200,
    pdf_address: 300,
    pdf_tax_office: 100,
    pdf_phone: 50,
    pdf_email: 200,
  };
  for (const [field, maxLength] of Object.entries(profileLimits)) {
    if (!(field in payload)) continue;
    const value = String(payload[field] || '').trim();
    if (value.length > maxLength) errors.push(`${field} must be <= ${maxLength} chars`);
    else normalized[field] = value || null;
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

  const company = await createCompany({
    ...normalized,
    aade_user_id: encryptSecret(normalized.aade_user_id, companySecretContext(normalized, 'aade_user_id')),
    aade_subscription_key: encryptSecret(normalized.aade_subscription_key, companySecretContext(normalized, 'aade_subscription_key')),
  });
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
    const fiscalHistory = await db('fiscal_documents').where({ company_id: existing.id }).first('id');
    if (fiscalHistory) {
      const error = new Error('Company VAT cannot change after fiscal document history exists; create a new company tenant instead');
      error.status = 409;
      throw error;
    }
    const vatConflict = await getCompanyByVatNumber(normalized.vat_number);
    if (vatConflict && vatConflict.id !== existing.id) {
      const error = new Error(`Company with VAT ${normalized.vat_number} already exists`);
      error.status = 409;
      throw error;
    }
  }

  const credentials = {};
  const targetCompany = { ...existing, vat_number: normalized.vat_number || existing.vat_number };
  for (const field of ['aade_user_id', 'aade_subscription_key']) {
    if (normalized[field]) {
      credentials[field] = encryptSecret(normalized[field], companySecretContext(targetCompany, field));
    } else if (targetCompany.vat_number !== existing.vat_number) {
      credentials[field] = encryptSecret(decryptCompanySecret(existing, field), companySecretContext(targetCompany, field));
    }
  }
  const updated = await updateCompany(id, { ...normalized, ...credentials });
  if (Object.keys(credentials).length > 0) await deleteIntegrationChecks(`mydata:${id}:`);
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

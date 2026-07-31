'use strict';

const crypto = require('crypto');

const PREFIX_V1 = 'enc:v1';
const PREFIX_V2 = 'enc:v2';

function parseEncryptionKey(configured, name) {
  if (!configured) {
    throw new Error(`${name} is required before storing or using integration secrets`);
  }
  const key = Buffer.from(configured, 'base64');
  if (key.length !== 32) {
    throw new Error(`${name} must be a base64-encoded 32-byte key`);
  }
  return key;
}

function getEncryptionKey() {
  return parseEncryptionKey(process.env.DATA_ENCRYPTION_KEY, 'DATA_ENCRYPTION_KEY');
}

function decryptionKeys() {
  const keys = [getEncryptionKey()];
  if (process.env.DATA_ENCRYPTION_KEY_PREVIOUS) {
    const previous = parseEncryptionKey(process.env.DATA_ENCRYPTION_KEY_PREVIOUS, 'DATA_ENCRYPTION_KEY_PREVIOUS');
    if (!crypto.timingSafeEqual(keys[0], previous)) keys.push(previous);
  }
  return keys;
}

function encryptFresh(value, context = null) {
  const prefix = context ? PREFIX_V2 : PREFIX_V1;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  if (context) cipher.setAAD(Buffer.from(String(context), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${prefix}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function encryptSecret(value, context = null) {
  if (value === undefined || value === null || value === '') return value;
  if (isEncrypted(value)) return value;
  return encryptFresh(value, context);
}

function decryptWithKey(parts, key, context = null) {
  const prefix = `${parts[0]}:${parts[1]}`;
  const [, , ivValue, tagValue, ciphertextValue] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64'));
  if (prefix === PREFIX_V2) {
    if (!context) throw new Error('Authenticated secret context is required');
    decipher.setAAD(Buffer.from(String(context), 'utf8'));
  }
  decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function decryptSecret(value, context = null) {
  if (value === undefined || value === null || value === '') return value;
  const parts = String(value).split(':');
  const prefix = `${parts[0]}:${parts[1]}`;
  if (parts.length !== 5 || ![PREFIX_V1, PREFIX_V2].includes(prefix)) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Unencrypted integration secret found; migrate it before production use');
    }
    return value; // Allows controlled migration from the legacy development database.
  }

  let lastError;
  for (const key of decryptionKeys()) {
    try { return decryptWithKey(parts, key, context); } catch (error) { lastError = error; }
  }
  throw new Error(`Integration secret cannot be decrypted with the configured current or previous key: ${lastError?.message || 'authentication failed'}`);
}

function reencryptSecret(value, context = null) {
  if (value === undefined || value === null || value === '') return value;
  if (!isEncrypted(value)) return encryptFresh(value, context);
  const parts = String(value).split(':');
  const expectedPrefix = context ? PREFIX_V2 : PREFIX_V1;
  try {
    decryptWithKey(parts, getEncryptionKey(), context);
    if (`${parts[0]}:${parts[1]}` === expectedPrefix) return value;
  } catch {
    // Fall through to the current-key/current-format rewrite below.
  }
  const plaintext = decryptSecret(value, context);
  return encryptFresh(plaintext, context);
}

function isEncrypted(value) {
  return typeof value === 'string' && (value.startsWith(`${PREFIX_V1}:`) || value.startsWith(`${PREFIX_V2}:`));
}

function isContextBound(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX_V2}:`);
}

function companySecretContext(company, field) {
  const vat = String(company?.vat_number || '').trim();
  if (!vat || !['aade_user_id', 'aade_subscription_key'].includes(field)) {
    throw new Error('Company VAT and a supported credential field are required for secret context');
  }
  return `company:${vat}:${field}`;
}

function decryptCompanySecret(company, field) {
  return decryptSecret(company?.[field], companySecretContext(company, field));
}

module.exports = {
  encryptSecret,
  decryptSecret,
  reencryptSecret,
  isEncrypted,
  isContextBound,
  companySecretContext,
  decryptCompanySecret,
};

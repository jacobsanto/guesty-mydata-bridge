'use strict';

const {
  decryptCompanySecret, isEncrypted, isContextBound,
} = require('./credentials');

function credentialError(message, status = 409) {
  return Object.assign(new Error(message), { status, code: 'AADE_CREDENTIALS_NOT_READY' });
}

function hasStoredCredentials(company) {
  return Boolean(company?.aade_user_id && company?.aade_subscription_key);
}

function assertConfiguredAadeCredentials(company) {
  if (!company) throw credentialError('Company not found', 404);
  if (!hasStoredCredentials(company) || company.aade_credential_status === 'pending') {
    throw credentialError('AADE credentials are pending; configure both user id and subscription key first');
  }
  for (const field of ['aade_user_id', 'aade_subscription_key']) {
    if (!isEncrypted(company[field]) || !isContextBound(company[field])) {
      throw credentialError('AADE credentials are not stored with tenant-bound encryption');
    }
  }
  return {
    ...company,
    aade_user_id: decryptCompanySecret(company, 'aade_user_id'),
    aade_subscription_key: decryptCompanySecret(company, 'aade_subscription_key'),
  };
}

function assertVerifiedAadeCredentials(company) {
  const context = assertConfiguredAadeCredentials(company);
  if (company.aade_credential_status !== 'verified' || !company.aade_credentials_verified_at) {
    throw credentialError('AADE credentials must pass a myDATA sandbox connection test before fiscal issuance');
  }
  return context;
}

module.exports = {
  hasStoredCredentials,
  assertConfiguredAadeCredentials,
  assertVerifiedAadeCredentials,
};

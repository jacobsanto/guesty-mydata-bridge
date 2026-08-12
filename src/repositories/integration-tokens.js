'use strict';

const { db } = require('../database');
const { encryptSecret, decryptSecret } = require('../security/credentials');

async function getIntegrationToken(provider, credentialFingerprint, minimumTtlMs = 0, executor = db) {
  const row = await executor('integration_tokens').where({ provider, credential_fingerprint: credentialFingerprint }).first();
  if (!row || Date.parse(row.expires_at) <= Date.now() + minimumTtlMs) return null;
  return {
    value: decryptSecret(row.encrypted_access_token, `integration-token:${provider}`),
    expiresAt: Date.parse(row.expires_at),
  };
}

async function saveIntegrationToken(provider, credentialFingerprint, value, expiresAt, executor = db) {
  const row = {
    provider,
    credential_fingerprint: credentialFingerprint,
    encrypted_access_token: encryptSecret(value, `integration-token:${provider}`),
    expires_at: new Date(expiresAt).toISOString(),
    updated_at: db.fn.now(),
  };
  await executor('integration_tokens').insert(row).onConflict('provider').merge(row);
}

async function deleteIntegrationToken(provider, executor = db) {
  await executor('integration_tokens').where({ provider }).delete();
}

module.exports = { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken };

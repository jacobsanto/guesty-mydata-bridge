'use strict';

const crypto = require('crypto');
const { db } = require('../database');

const GUESTY_WEBHOOK_PREFIX = 'guesty_webhook:';

function webhookCheckKey(eventId) {
  const digest = crypto.createHash('sha256').update(String(eventId)).digest('hex');
  return `${GUESTY_WEBHOOK_PREFIX}${digest}`;
}

async function cleanupGuestyWebhookClaims(now = Date.now()) {
  // Knex/SQLite timestamps use `YYYY-MM-DD HH:mm:ss`; matching that shape also
  // remains a valid PostgreSQL timestamp input and avoids lexical misordering.
  const databaseTimestamp = (value) => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
  const processingBefore = databaseTimestamp(now - 10 * 60 * 1000);
  const processedBefore = databaseTimestamp(now - 24 * 60 * 60 * 1000);
  return db('integration_checks')
    .where('check_key', 'like', `${GUESTY_WEBHOOK_PREFIX}%`)
    .where((query) => query
      .where((stale) => stale.where({ status: 'processing' }).where('checked_at', '<', processingBefore))
      .orWhere((expired) => expired.where({ status: 'processed' }).where('checked_at', '<', processedBefore)))
    .delete();
}

async function claimGuestyWebhookEvent(eventId) {
  await cleanupGuestyWebhookClaims();
  const checkKey = webhookCheckKey(eventId);
  try {
    await db('integration_checks').insert({
      check_key: checkKey,
      status: 'processing',
      environment: 'guesty',
      message: null,
      checked_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    return true;
  } catch (error) {
    const duplicate = error.code === '23505' || String(error.code || '').startsWith('SQLITE_CONSTRAINT');
    if (duplicate) return false;
    throw error;
  }
}

async function completeGuestyWebhookEvent(eventId) {
  return db('integration_checks').where({ check_key: webhookCheckKey(eventId), status: 'processing' }).update({
    status: 'processed',
    checked_at: db.fn.now(),
    updated_at: db.fn.now(),
  });
}

async function releaseGuestyWebhookEvent(eventId) {
  return db('integration_checks').where({ check_key: webhookCheckKey(eventId), status: 'processing' }).delete();
}

async function recordIntegrationCheck(checkKey, status, environment = null, message = null) {
  const row = {
    check_key: checkKey,
    status,
    environment,
    message: message ? String(message).slice(0, 1000) : null,
    checked_at: db.fn.now(),
    updated_at: db.fn.now(),
  };
  await db('integration_checks').insert(row).onConflict('check_key').merge(row);
  return db('integration_checks').where({ check_key: checkKey }).first();
}

async function listIntegrationChecks() {
  return db('integration_checks').select('*').orderBy('check_key');
}

async function deleteIntegrationChecks(prefix) {
  return db('integration_checks').where('check_key', 'like', `${prefix}%`).delete();
}

module.exports = {
  recordIntegrationCheck,
  listIntegrationChecks,
  deleteIntegrationChecks,
  claimGuestyWebhookEvent,
  completeGuestyWebhookEvent,
  releaseGuestyWebhookEvent,
};

'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { insertedId } = require('../database-utils');

function leaseExpiry(leaseSeconds) {
  return Date.now() + leaseSeconds * 1000;
}

async function beginRun(companyId, businessDate, { leaseSeconds = 300 } = {}) {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw new Error('Daily close leaseSeconds must be 30-3600');
  const leaseToken = crypto.randomUUID();
  return db.transaction(async (trx) => {
    const inserted = await trx('daily_close_runs')
      .insert({ company_id: companyId, business_date: businessDate, lease_token: leaseToken, lease_expires_at_ms: leaseExpiry(leaseSeconds) })
      .onConflict(['company_id', 'business_date'])
      .ignore()
      .returning('id');
    const insertedRunId = insertedId(inserted);
    if (insertedRunId) return trx('daily_close_runs').where({ id: insertedRunId }).first();

    const run = await trx('daily_close_runs')
      .where({ company_id: companyId, business_date: businessDate })
      .forUpdate()
      .first();
    if (run.status === 'running' && run.lease_expires_at_ms != null && Number(run.lease_expires_at_ms) >= Date.now()) {
      const error = new Error(`Daily close is already running for ${businessDate}`);
      error.status = 409;
      throw error;
    }
    await trx('daily_close_runs').where({ id: run.id }).update({
      status: 'running',
      document_count: 0,
      sent_count: 0,
      failed_count: 0,
      started_at: db.fn.now(),
      completed_at: null,
      lease_token: leaseToken,
      lease_expires_at_ms: leaseExpiry(leaseSeconds),
      updated_at: trx.fn.now(),
    });
    // Items describe the current attempt, not a crashed predecessor.
    await trx('daily_close_items').where({ run_id: run.id }).delete();
    return trx('daily_close_runs').where({ id: run.id }).first();
  });
}

async function heartbeatRun(runId, leaseToken, leaseSeconds = 300) {
  const changed = await db('daily_close_runs').where({ id: runId, status: 'running', lease_token: leaseToken })
    .where('lease_expires_at_ms', '>=', Date.now()).update({
    lease_expires_at_ms: leaseExpiry(leaseSeconds),
    updated_at: db.fn.now(),
  });
  if (changed !== 1) {
    const error = new Error('Daily close lease was lost');
    error.status = 409;
    throw error;
  }
}

async function getRun(companyId, businessDate) {
  return db('daily_close_runs').where({ company_id: companyId, business_date: businessDate }).first();
}

async function listRuns(filters = {}) {
  const query = db('daily_close_runs as r')
    .join('companies as c', 'r.company_id', 'c.id')
    .select('r.*', 'c.company_name', 'c.vat_number')
    .orderBy('r.business_date', 'desc')
    .orderBy('r.id', 'desc')
    .limit(Math.min(Math.max(Number(filters.limit) || 50, 1), 200));
  if (filters.companyId) query.where('r.company_id', filters.companyId);
  if (filters.status) query.where('r.status', filters.status);
  return query;
}

async function listRunItems(runId) {
  return db('daily_close_items as i')
    .join('fiscal_documents as d', 'i.document_id', 'd.id')
    .select(
      'i.id', 'i.run_id', 'i.document_id', 'i.result', 'i.message', 'i.created_at', 'i.updated_at',
      'd.document_type', 'd.series', 'd.aa', 'd.reservation_id', 'd.mydata_mark'
    )
    .where('i.run_id', runId)
    .orderBy('i.id', 'asc');
}

async function recordRunItem(runId, documentId, result, message = null, leaseToken) {
  if (!leaseToken) throw new Error('Daily close lease token is required to record a run item');
  return db.transaction(async (trx) => {
    // Locking the run row fences an expired worker from changing the audit trail
    // after another worker has recovered the same company/day run.
    const run = await trx('daily_close_runs')
      .where({ id: runId, status: 'running', lease_token: leaseToken })
      .where('lease_expires_at_ms', '>=', Date.now())
      .forUpdate()
      .first();
    if (!run) {
      const error = new Error('Daily close lease was lost before recording a run item');
      error.status = 409;
      throw error;
    }

    await trx('daily_close_items')
      .insert({ run_id: runId, document_id: documentId, result, message })
      .onConflict(['run_id', 'document_id'])
      .merge({ result, message, updated_at: trx.fn.now() });
  });
}

async function recordVerificationResult(runId, documentId, mark, outcome, leaseToken) {
  if (!leaseToken) throw new Error('Daily close lease token is required to record verification');
  const verified = outcome.verified === true;
  return db.transaction(async (trx) => {
    const run = await trx('daily_close_runs')
      .where({ id: runId, status: 'running', lease_token: leaseToken })
      .where('lease_expires_at_ms', '>=', Date.now())
      .forUpdate()
      .first();
    if (!run) {
      const error = new Error('Daily close lease was lost before recording verification');
      error.status = 409;
      throw error;
    }
    const documentUpdate = verified
      ? { verification_status: 'verified', verification_error: null, verified_at: trx.fn.now(), updated_at: trx.fn.now() }
      : { verification_status: 'failed', verification_error: String(outcome.error || 'Verification failed').slice(0, 4000), updated_at: trx.fn.now() };
    const changed = await trx('fiscal_documents')
      .where({ id: documentId, status: 'sent', mydata_mark: String(mark) })
      .update(documentUpdate);
    if (changed !== 1) {
      const error = new Error('Fiscal document changed before verification could be recorded');
      error.status = 409;
      throw error;
    }
    await trx('daily_close_items')
      .insert({
        run_id: runId,
        document_id: documentId,
        result: verified ? 'verified' : 'verification_failed',
        message: verified ? String(mark) : String(outcome.error || 'Verification failed'),
      })
      .onConflict(['run_id', 'document_id'])
      .merge({
        result: verified ? 'verified' : 'verification_failed',
        message: verified ? String(mark) : String(outcome.error || 'Verification failed'),
        updated_at: trx.fn.now(),
      });
  });
}

async function finishRun(runId, counts, leaseToken) {
  if (!leaseToken) throw new Error('Daily close lease token is required to finish a run');
  const status = counts.inFlight > 0 ? 'partial' : (counts.failed > 0 ? (counts.sent > 0 ? 'partial' : 'failed') : 'completed');
  const changed = await db('daily_close_runs').where({ id: runId, status: 'running', lease_token: leaseToken })
    .where('lease_expires_at_ms', '>=', Date.now()).update({
    status,
    document_count: counts.total,
    sent_count: counts.sent,
    failed_count: counts.failed,
    completed_at: db.fn.now(),
    lease_token: null,
    lease_expires_at: null,
    lease_expires_at_ms: null,
    updated_at: db.fn.now(),
  });
  if (changed !== 1) {
    const error = new Error('Daily close lease was lost before completion');
    error.status = 409;
    throw error;
  }
  return db('daily_close_runs').where({ id: runId }).first();
}

module.exports = { beginRun, heartbeatRun, getRun, listRuns, listRunItems, recordRunItem, recordVerificationResult, finishRun };

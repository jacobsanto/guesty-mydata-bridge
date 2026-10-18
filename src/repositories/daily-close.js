'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { insertedId } = require('../database-utils');
const { insertFiscalPdfArtifactOnce } = require('./fiscal-pdf-artifacts');

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
      materialization_failure_count: 0,
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
      ? {
          verification_status: 'verified', verification_error: null,
          ...(outcome.uid ? { mydata_uid: String(outcome.uid) } : {}),
          ...(outcome.qrUrl ? { mydata_qr_url: String(outcome.qrUrl) } : {}),
          verified_at: trx.fn.now(), updated_at: trx.fn.now(),
        }
      : { verification_status: 'failed', verification_error: String(outcome.error || 'Verification failed').slice(0, 4000), updated_at: trx.fn.now() };
    const changed = await trx('fiscal_documents')
      .where({ id: documentId, status: 'sent', mydata_mark: String(mark) })
      .update(documentUpdate);
    if (changed !== 1) {
      const error = new Error('Fiscal document changed before verification could be recorded');
      error.status = 409;
      throw error;
    }
    if (verified) {
      if (!outcome.artifact) throw new Error('Verified fiscal document requires an immutable PDF artifact');
      await insertFiscalPdfArtifactOnce(outcome.artifact, trx);
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
  const materializationFailures = Math.max(0, Number(counts.materializationFailures || 0));
  return db.transaction(async (trx) => {
    const run = await trx('daily_close_runs')
      .where({ id: runId, status: 'running', lease_token: leaseToken })
      .where('lease_expires_at_ms', '>=', Date.now())
      .forUpdate()
      .first();
    if (!run) {
      const error = new Error('Daily close lease was lost before completion');
      error.status = 409;
      throw error;
    }

    // Lock every due transmission whose lifecycle is not settled. This makes
    // `completed` impossible while a late MARK or verification is outstanding.
    const dueDocuments = await trx('fiscal_documents as d')
      .where({ 'd.company_id': run.company_id })
      .where('d.issue_date', '<=', run.business_date)
      .where((query) => query
        .whereIn('d.status', ['pending', 'failed', 'transmitting'])
        .orWhere((sent) => sent.where({ 'd.status': 'sent' }).andWhere((verification) => verification
          .whereNot({ 'd.verification_status': 'verified' })
          .orWhereNull('d.verification_status')
          .orWhereNotExists(trx('fiscal_pdf_artifacts as pdf').select(trx.raw('1')).whereRaw('pdf.document_id = d.id'))))
        .orWhereExists(trx('reservation_snapshots as review')
          .select(trx.raw('1'))
          .whereRaw('review.reservation_id = d.reservation_id')
          .where({ 'review.requires_review': true })))
      .forUpdate()
      .select(
        'd.id', 'd.status', 'd.verification_status',
        trx.raw('EXISTS (SELECT 1 FROM fiscal_pdf_artifacts pdf_state WHERE pdf_state.document_id = d.id) AS has_pdf_artifact'),
        trx.raw('EXISTS (SELECT 1 FROM reservation_snapshots review_state WHERE review_state.reservation_id = d.reservation_id AND review_state.requires_review = ?) AS requires_review', [true]),
      );
    const items = await trx('daily_close_items').where({ run_id: runId }).select('document_id', 'result');
    const verifiedCount = items.filter((item) => item.result === 'verified').length;
    const failedItemCount = items.filter((item) => ['failed', 'blocked', 'verification_failed', 'artifact_failed'].includes(item.result)).length;
    const inFlightCount = items.filter((item) => item.result === 'in_flight').length;
    const failedCount = failedItemCount + materializationFailures;
    const itemsByDocument = new Map(items.map((item) => [Number(item.document_id), item.result]));
    const hasUnsettled = inFlightCount > 0 || dueDocuments.some((document) => {
      const result = itemsByDocument.get(Number(document.id));
      if (!result) return true;
      if (result === 'in_flight') return true;
      if (result === 'verified') {
        return document.status !== 'sent' || document.verification_status !== 'verified'
          || !Boolean(document.has_pdf_artifact) || Boolean(document.requires_review);
      }
      return false;
    });
    const status = hasUnsettled ? 'partial' : (failedCount > 0 ? (verifiedCount > 0 ? 'partial' : 'failed') : 'completed');
    await trx('daily_close_runs').where({ id: runId }).update({
      status,
      document_count: items.length,
      sent_count: verifiedCount,
      failed_count: failedCount,
      materialization_failure_count: materializationFailures,
      completed_at: trx.fn.now(),
      lease_token: null,
      lease_expires_at: null,
      lease_expires_at_ms: null,
      updated_at: trx.fn.now(),
    });
    return trx('daily_close_runs').where({ id: runId }).first();
  });
}

module.exports = { beginRun, heartbeatRun, getRun, listRuns, listRunItems, recordRunItem, recordVerificationResult, finishRun };

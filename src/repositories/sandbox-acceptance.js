'use strict';

const { db } = require('../database');
const { insertedId } = require('../database-utils');

async function insertAcceptanceRun(run, artifacts) {
  return db.transaction(async (trx) => {
    const runId = insertedId(await trx('sandbox_acceptance_runs').insert(run).returning('id'));
    for (const artifact of artifacts) {
      await trx('sandbox_acceptance_artifacts').insert({ ...artifact, run_id: runId });
    }
    return getAcceptanceRun(runId, trx);
  });
}

async function getAcceptanceRun(id, client = db) {
  const run = await client('sandbox_acceptance_runs').where({ id }).first();
  if (!run) return null;
  const artifacts = await client('sandbox_acceptance_artifacts').where({ run_id: id }).orderBy('id');
  return { ...run, artifacts };
}

async function listAcceptanceRuns(filters = {}, client = db) {
  const query = client('sandbox_acceptance_runs').select('*').orderBy('approved_at', 'desc').orderBy('id', 'desc');
  if (filters.companyId) query.where({ company_id: Number(filters.companyId) });
  const runs = await query;
  if (!runs.length) return [];
  const artifacts = await client('sandbox_acceptance_artifacts').whereIn('run_id', runs.map((run) => run.id)).orderBy('id');
  const byRun = new Map();
  for (const artifact of artifacts) {
    if (!byRun.has(Number(artifact.run_id))) byRun.set(Number(artifact.run_id), []);
    byRun.get(Number(artifact.run_id)).push(artifact);
  }
  return runs.map((run) => ({ ...run, artifacts: byRun.get(Number(run.id)) || [] }));
}

async function listLegacyAcceptanceEvidence(companyIds, client = db) {
  if (!companyIds.length) return [];
  return client('sandbox_signoffs as s')
    .join('fiscal_documents as p', 'p.id', 's.primary_document_id')
    .join('fiscal_documents as t', 't.id', 's.takk_document_id')
    .whereIn('s.company_id', companyIds)
    .whereIn('p.document_type', ['2.1', '11.2'])
    .where({
      'p.mydata_environment': 'sandbox',
      'p.verification_status': 'verified',
      't.document_type': '8.2',
      't.mydata_environment': 'sandbox',
      't.verification_status': 'verified',
    })
    .whereNotNull('s.primary_xml_sha256')
    .whereNotNull('s.takk_xml_sha256')
    .whereNotNull('s.primary_response_sha256')
    .whereNotNull('s.takk_response_sha256')
    .select(
      's.id', 's.company_id', 's.issuer_vat', 's.credential_binding_sha256',
      'p.document_type as primary_type',
    );
}

module.exports = {
  insertAcceptanceRun,
  getAcceptanceRun,
  listAcceptanceRuns,
  listLegacyAcceptanceEvidence,
};

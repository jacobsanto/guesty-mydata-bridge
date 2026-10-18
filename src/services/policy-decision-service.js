'use strict';

const { db } = require('../database');

function policyError(message, status = 409) {
  return Object.assign(new Error(message), { status, code: 'POLICY_DECISION_BLOCKED' });
}

function policyColumns(type) {
  if (type === 'channel') return { id: 'channel_policy_id', table: 'channel_policy_versions' };
  if (type === 'takk') return { id: 'takk_policy_id', table: 'takk_policy_versions' };
  throw policyError('Unknown policy decision type', 500);
}

async function latestPolicyDecision(policy, type, executor = db, { lock = false } = {}) {
  const { id } = policyColumns(type);
  let query = executor('policy_decision_events').where({ [id]: policy.id, policy_hash: policy.policy_hash })
    .orderBy('decided_at', 'desc').orderBy('id', 'desc');
  if (lock && executor.client.config.client === 'pg') query = query.forUpdate();
  return query.first();
}

async function approvedPolicyIds(policies, type, executor = db) {
  if (!policies.length) return new Set();
  const { id } = policyColumns(type);
  const rows = await executor('policy_decision_events').whereIn(id, policies.map((policy) => policy.id))
    .orderBy('decided_at', 'desc').orderBy('id', 'desc');
  const latest = new Map();
  for (const row of rows) {
    const policy = policies.find((candidate) => Number(candidate.id) === Number(row[id]));
    if (policy && row.policy_hash === policy.policy_hash && !latest.has(Number(policy.id))) latest.set(Number(policy.id), row);
  }
  return new Set([...latest.entries()].filter(([, row]) => row.decision === 'approved').map(([policyId]) => policyId));
}

async function assertPolicyDecisionApproved(policy, type, executor = db, options = {}) {
  const decision = await latestPolicyDecision(policy, type, executor, options);
  if (!decision || decision.decision !== 'approved') {
    throw policyError(`${type === 'channel' ? 'Unified channel' : 'TAKK'} policy ${policy.id} has no active immutable approval decision`);
  }
  return decision;
}

module.exports = { latestPolicyDecision, approvedPolicyIds, assertPolicyDecisionApproved };

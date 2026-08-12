'use strict';

const { db } = require('../database');
const { approvedPolicyIds } = require('./policy-decision-service');

function unique(values) { return [...new Set(values.filter(Boolean).map(String))]; }

function activeOnDate(policy, date) {
  return (!policy.valid_from || String(policy.valid_from) <= date)
    && (!policy.valid_to || String(policy.valid_to) >= date);
}

async function policyFacts(policyId, policyHash, type) {
  if (type === 'channel') {
    const [samples, approvals] = await Promise.all([
      db('channel_policy_samples as s').join('fiscal_evidence_captures as e', 'e.id', 's.evidence_capture_id')
        .where({ 's.policy_id': policyId, 's.policy_hash': policyHash, 's.passed': true, 's.stale': false })
        .whereNotNull('s.historical_mark').select('e.reservation_id'),
      db('policy_approvals').where({ channel_policy_id: policyId, policy_hash: policyHash }).select('approval_role'),
    ]);
    return { samples: unique(samples.map((row) => row.reservation_id)).length, approvals: unique(approvals.map((row) => row.approval_role)) };
  }
  const [samples, approvals] = await Promise.all([
    db('takk_calibration_samples').where({ policy_id: policyId, passed: true }).select('scenario'),
    db('policy_approvals').where({ takk_policy_id: policyId, policy_hash: policyHash }).select('approval_role'),
  ]);
  return { scenarios: unique(samples.map((row) => row.scenario)), approvals: unique(approvals.map((row) => row.approval_role)) };
}

function stateForChannel(policy, facts, approved) {
  if (!policy) return { status: 'hold', blockers: ['Δεν υπάρχει unified policy για το ακριβές Guesty tuple'] };
  const blockers = [];
  if (!approved) blockers.push(`Policy v${policy.version} δεν έχει ενεργή immutable approval decision`);
  if (facts.samples < 3) blockers.push(`Απαιτούνται 3 οριστικοποιημένα δείγματα (${facts.samples}/3)`);
  if (!facts.approvals.includes('accounting')) blockers.push('Λείπει λογιστική έγκριση');
  if (!facts.approvals.includes('technical')) blockers.push('Λείπει τεχνική έγκριση');
  return { status: blockers.length ? (facts.samples ? 'review' : 'calibrating') : 'ready', blockers };
}

function stateForTakk(policy, facts, approved) {
  if (!policy) return { status: 'hold', blockers: ['Δεν υπάρχει ενεργή TAKK policy για το κατάλυμα'] };
  const blockers = [];
  if (!approved) blockers.push(`TAKK v${policy.version} δεν έχει ενεργή immutable approval decision`);
  for (const scenario of ['low', 'high', 'boundary']) if (!facts.scenarios.includes(scenario)) blockers.push(`Λείπει ${scenario} calibration`);
  if (!facts.approvals.includes('accounting')) blockers.push('Λείπει λογιστική έγκριση');
  if (!facts.approvals.includes('technical')) blockers.push('Λείπει τεχνική έγκριση');
  return { status: blockers.length ? 'review' : 'ready', blockers };
}

async function getPolicyMatrix({ asOf = new Date().toISOString().slice(0, 10) } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf))) throw new Error('policy matrix asOf must be YYYY-MM-DD');
  const [observed, channelPolicies, listings, takkPolicies] = await Promise.all([
    db('reservation_snapshots as r').join('listings as l', 'l.id', 'r.listing_id').join('companies as c', 'c.id', 'r.company_id')
      .whereNotIn('r.status', ['cancelled', 'canceled']).select(
        'r.company_id', 'r.listing_id', 'r.platform_key', 'r.source_key', 'l.listing_id_guesty', 'c.company_name',
      ).max({ last_seen_at: 'r.updated_at' }).groupBy('r.company_id', 'r.listing_id', 'r.platform_key', 'r.source_key', 'l.listing_id_guesty', 'c.company_name'),
    db('channel_policy_versions').select('*').orderBy('version', 'desc'),
    db('listings as l').join('companies as c', 'c.id', 'l.company_id').where({ 'l.active': true }).select('l.id', 'l.company_id', 'l.listing_id_guesty', 'c.company_name'),
    db('takk_policy_versions').select('*').orderBy('version', 'desc'),
  ]);
  const accountId = String(process.env.GUESTY_ACCOUNT_ID || '').trim() || null;
  const approvedChannels = await approvedPolicyIds(channelPolicies, 'channel');
  const approvedTakk = await approvedPolicyIds(takkPolicies, 'takk');
  const channels = await Promise.all(observed.map(async (item) => {
    const policies = channelPolicies.filter((policy) => Number(policy.company_id) === Number(item.company_id)
      && Number(policy.listing_id) === Number(item.listing_id) && policy.platform_key === item.platform_key && policy.source_key === item.source_key
      && (!accountId || policy.guesty_account_id === accountId));
    const activePolicies = policies.filter((policy) => approvedChannels.has(Number(policy.id)) && activeOnDate(policy, asOf));
    const policy = activePolicies.length === 1 ? activePolicies[0] : (policies[0] || null);
    const facts = policy ? await policyFacts(policy.id, policy.policy_hash, 'channel') : { samples: 0, approvals: [] };
    const state = activePolicies.length === 1 ? stateForChannel(policy, facts, true) : {
      status: 'hold', blockers: [`Απαιτείται ακριβώς μία εγκεκριμένη policy ενεργή στις ${asOf} (${activePolicies.length})`],
    };
    return { ...item, guesty_account_id: policy?.guesty_account_id || accountId, policy: policy && {
      id: policy.id, version: Number(policy.version), status: policy.status, recipient_model: policy.recipient_model,
      document_type: policy.document_type, series: policy.series, policy_hash: policy.policy_hash,
    }, calibration: facts, ...state };
  }));
  const takk = await Promise.all(listings.map(async (listing) => {
    const policies = takkPolicies.filter((policy) => Number(policy.company_id) === Number(listing.company_id) && Number(policy.listing_id) === Number(listing.id));
    const activePolicies = policies.filter((policy) => approvedTakk.has(Number(policy.id)) && activeOnDate(policy, asOf));
    const policy = activePolicies.length === 1 ? activePolicies[0] : (policies[0] || null);
    const facts = policy ? await policyFacts(policy.id, policy.policy_hash, 'takk') : { scenarios: [], approvals: [] };
    const state = activePolicies.length === 1 ? stateForTakk(policy, facts, true) : {
      status: 'hold', blockers: [`Απαιτείται ακριβώς μία εγκεκριμένη TAKK policy ενεργή στις ${asOf} (${activePolicies.length})`],
    };
    return { ...listing, policy: policy && {
      id: policy.id, version: Number(policy.version), status: policy.status, valid_from: policy.valid_from, valid_to: policy.valid_to,
      licensed_category: policy.licensed_category, high_rate_cents: Number(policy.high_rate_cents), low_rate_cents: Number(policy.low_rate_cents),
    }, calibration: facts, ...state };
  }));
  return { guestyAccountId: accountId, generatedAt: new Date().toISOString(), asOf, channels, takk };
}

module.exports = { getPolicyMatrix };

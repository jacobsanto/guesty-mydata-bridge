'use strict';

const crypto = require('crypto');
const { db } = require('../database');
const { insertedId } = require('../database-utils');
const { normalizeCounterpart, normalizeSeries, validateAccommodationClimatePair } = require('../validation/fiscal-fields');
const { evaluateFolio, normalizeChannelKey, validateLineRules } = require('./financial-rule-engine');
const { channelPolicyHash } = require('./unified-channel-policy-service');
const { takkPolicyHash, feeLines } = require('./takk-policy-service');
const { assertSingleStayFiscalFolio } = require('./financial-profile-service');
const { latestPolicyDecision } = require('./policy-decision-service');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MM_DD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function policyError(message, status = 400, code = 'POLICY_AUTHORING_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function positiveId(value, label) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1) throw policyError(`${label} must be a positive integer`);
  return id;
}

function nonBlank(value, label, max = 200) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw policyError(`${label} must be 1-${max} characters`);
  return text;
}

function optionalReason(value) {
  if (value === undefined || value === null || value === '') return null;
  return nonBlank(value, 'reason', 2000);
}

function dateValue(value, label, { required = true } = {}) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  const date = String(value || '').trim();
  if (!DATE_RE.test(date) || Number.isNaN(new Date(`${date}T12:00:00Z`).getTime())) throw policyError(`${label} must be YYYY-MM-DD`);
  return date;
}

function parseObject(value, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw policyError(`${label} must be an object`);
  return value;
}

function assertOnlyKeys(payload, allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw policyError('Request payload must be an object');
  const unknown = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unknown.length) throw policyError(`Unsupported policy fields: ${unknown.join(', ')}`);
}

function cents(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw policyError(`${label} must be a positive integer amount in cents`);
  return normalized;
}

function nonNegativeCents(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw policyError(`${label} must be a non-negative integer amount in cents`);
  return normalized;
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function sha256Field(value, label) {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw policyError(`${label} must be a SHA-256 hex digest`);
  return hash;
}

function aadeMark(value, label = 'historical_mark') {
  const mark = String(value || '').trim();
  if (!/^\d{1,30}$/.test(mark)) throw policyError(`${label} must be the numeric AADE MARK`);
  return mark;
}

async function listingForCompany(companyId, listingId, executor = db) {
  const listing = await executor('listings').where({ id: listingId, company_id: companyId }).first();
  if (!listing) throw policyError('Listing does not belong to the selected company', 404);
  if (!listing.active) throw policyError('Inactive listings cannot receive a new policy', 409);
  return listing;
}

async function nextVersion(table, where, executor) {
  const row = await executor(table).where(where).max({ max_version: 'version' }).first();
  return Number(row?.max_version || 0) + 1;
}

function channelDraftPayload(payload, actorId) {
  assertOnlyKeys(payload, new Set(['company_id', 'listing_id', 'platform_key', 'source_key', 'recipient_model', 'series', 'counterpart', 'valid_from', 'valid_to', 'line_rules']));
  const companyId = positiveId(payload.company_id, 'company_id');
  const listingId = positiveId(payload.listing_id, 'listing_id');
  const platformKey = normalizeChannelKey(payload.platform_key);
  const sourceKey = normalizeChannelKey(payload.source_key);
  if (!platformKey || !sourceKey) throw policyError('platform_key and source_key are required');
  const recipientModel = String(payload.recipient_model || '').trim();
  if (!['private_guest', 'approved_business_counterpart'].includes(recipientModel)) throw policyError('recipient_model must be private_guest or approved_business_counterpart');
  const validFrom = dateValue(payload.valid_from, 'valid_from');
  const validTo = dateValue(payload.valid_to, 'valid_to', { required: false });
  if (validTo && validTo < validFrom) throw policyError('valid_to cannot be before valid_from');
  let lineRules;
  try { lineRules = validateLineRules(payload.line_rules); } catch (error) { throw policyError(`Invalid line_rules: ${error.message}`); }
  const documentType = recipientModel === 'private_guest' ? '11.2' : '2.1';
  const counterpart = recipientModel === 'private_guest'
    ? null
    : normalizeCounterpart(payload.counterpart, { required: true, label: 'approved policy counterpart' });
  if (recipientModel === 'private_guest' && payload.counterpart !== undefined && payload.counterpart !== null) {
    const candidate = normalizeCounterpart(payload.counterpart, { required: false, label: 'private guest counterpart' });
    if (candidate.vatNumber || candidate.country || candidate.name) throw policyError('APY 11.2 policy cannot carry an OTA or business counterpart');
  }
  return {
    companyId, listingId, platformKey, sourceKey, validFrom, validTo, lineRules, documentType, recipientModel, counterpart,
    series: normalizeSeries(payload.series, { required: true }), createdBy: nonBlank(actorId, 'policy actor'),
  };
}

async function createChannelPolicyDraft(payload, actorId, executor = db) {
  const input = channelDraftPayload(payload, actorId);
  const guestyAccountId = nonBlank(process.env.GUESTY_ACCOUNT_ID, 'GUESTY_ACCOUNT_ID', 120);
  return executor.transaction(async (trx) => {
    await listingForCompany(input.companyId, input.listingId, trx);
    const version = await nextVersion('channel_policy_versions', {
      company_id: input.companyId, listing_id: input.listingId, guesty_account_id: guestyAccountId,
      platform_key: input.platformKey, source_key: input.sourceKey,
    }, trx);
    const record = {
      company_id: input.companyId, listing_id: input.listingId, guesty_account_id: guestyAccountId,
      platform_key: input.platformKey, source_key: input.sourceKey, currency: 'EUR', version, status: 'draft',
      recipient_model: input.recipientModel, document_type: input.documentType, series: input.series,
      counterpart_json: input.counterpart ? JSON.stringify(input.counterpart) : null,
      vat_category: 2, classification_category: 'category1_3',
      classification_type: input.documentType === '11.2' ? 'E3_561_003' : 'E3_561_007',
      gross_strategy: 'folio_items_sum', gross_strategy_config_json: '{}', line_rules_json: JSON.stringify(input.lineRules),
      tolerance_cents: 0, normalizer_version: 'guesty-v3-folio-1', calculator_version: 'folio-sum-1',
      valid_from: input.validFrom, valid_to: input.validTo, created_by: input.createdBy,
    };
    record.policy_hash = channelPolicyHash(record);
    const result = await trx('channel_policy_versions').insert(record);
    return trx('channel_policy_versions').where({ id: Number(insertedId(result)) }).first();
  });
}

function seasonRules(value) {
  const raw = parseObject(value, 'season_rules', null);
  const from = String(raw?.high?.from || '');
  const to = String(raw?.high?.to || '');
  if (!MM_DD_RE.test(from) || !MM_DD_RE.test(to)) throw policyError('season_rules.high.from and season_rules.high.to must be valid MM-DD values');
  return { high: { from, to } };
}

function takkDraftPayload(payload, actorId) {
  assertOnlyKeys(payload, new Set(['company_id', 'listing_id', 'licensed_category', 'valid_from', 'valid_to', 'high_rate_cents', 'low_rate_cents', 'season_rules', 'series']));
  const companyId = positiveId(payload.company_id, 'company_id');
  const listingId = positiveId(payload.listing_id, 'listing_id');
  const validFrom = dateValue(payload.valid_from, 'valid_from');
  const validTo = dateValue(payload.valid_to, 'valid_to', { required: false });
  if (validTo && validTo < validFrom) throw policyError('valid_to cannot be before valid_from');
  return {
    companyId, listingId, validFrom, validTo, licensedCategory: nonBlank(payload.licensed_category, 'licensed_category', 100),
    highRateCents: cents(payload.high_rate_cents, 'high_rate_cents'), lowRateCents: cents(payload.low_rate_cents, 'low_rate_cents'),
    seasonRules: seasonRules(payload.season_rules), series: normalizeSeries(payload.series, { required: true }), createdBy: nonBlank(actorId, 'policy actor'),
  };
}

async function createTakkPolicyDraft(payload, actorId, executor = db) {
  const input = takkDraftPayload(payload, actorId);
  return executor.transaction(async (trx) => {
    const listing = await listingForCompany(input.companyId, input.listingId, trx);
    validateAccommodationClimatePair(listing.property_type, listing.climate_fee_high_category, listing.climate_fee_low_category);
    const version = await nextVersion('takk_policy_versions', { company_id: input.companyId, listing_id: input.listingId }, trx);
    const record = {
      company_id: input.companyId, listing_id: input.listingId, version, status: 'draft', property_type: listing.property_type,
      licensed_category: input.licensedCategory, valid_from: input.validFrom, valid_to: input.validTo,
      high_category: Number(listing.climate_fee_high_category), low_category: Number(listing.climate_fee_low_category),
      high_rate_cents: input.highRateCents, low_rate_cents: input.lowRateCents, season_rules_json: JSON.stringify(input.seasonRules),
      series: input.series, calculator_version: 'takk-nightly-1', created_by: input.createdBy,
    };
    record.policy_hash = takkPolicyHash(record);
    const result = await trx('takk_policy_versions').insert(record);
    return trx('takk_policy_versions').where({ id: Number(insertedId(result)) }).first();
  });
}

function policyInfo(type) {
  if (type === 'channel') return { table: 'channel_policy_versions', id: 'channel_policy_id' };
  if (type === 'takk') return { table: 'takk_policy_versions', id: 'takk_policy_id' };
  throw policyError('Unknown policy type', 404);
}

async function policyById(type, policyId, executor = db) {
  const { table } = policyInfo(type);
  const policy = await executor(table).where({ id: positiveId(policyId, 'policy id') }).first();
  if (!policy) throw policyError('Policy not found', 404);
  return policy;
}

async function calibrationSnapshot(policy, reservationId, executor) {
  const snapshot = await executor('reservation_snapshots').where({
    company_id: policy.company_id, listing_id: policy.listing_id, reservation_id: nonBlank(reservationId, 'reservation_id', 120),
  }).first();
  if (!snapshot) throw policyError('No staged Guesty reservation snapshot exists for this exact company and listing', 404);
  let reservation;
  try { reservation = JSON.parse(snapshot.normalized_payload); } catch { throw policyError('The staged Guesty snapshot is invalid', 409); }
  const platform = normalizeChannelKey(reservation.platformKey || reservation.platform);
  const source = normalizeChannelKey(reservation.sourceKey || reservation.source);
  if (policy.platform_key && (platform !== policy.platform_key || source !== policy.source_key)) {
    throw policyError('Guesty reservation does not match the exact policy platform/source tuple', 409);
  }
  return { snapshot, reservation, payload: snapshot.normalized_payload };
}

function exactHistoricalPrimary(payload, policy) {
  assertOnlyKeys(payload, new Set(['reservation_id', 'historical_document_type', 'historical_series', 'historical_mark', 'historical_uid', 'historical_pdf_sha256', 'historical_primary_cents', 'historical_takk_cents', 'scenario', 'accountant_reference']));
  const documentType = String(payload.historical_document_type || '').trim();
  const series = normalizeSeries(payload.historical_series, { fieldName: 'historical_series', required: true });
  if (documentType !== policy.document_type || series !== policy.series) throw policyError('Welcome/myDATA document type and series must exactly match this policy', 409);
  return {
    reservationId: nonBlank(payload.reservation_id, 'reservation_id', 120), documentType, series,
    mark: aadeMark(payload.historical_mark), uid: payload.historical_uid ? nonBlank(payload.historical_uid, 'historical_uid', 50) : null,
    pdfHash: sha256Field(payload.historical_pdf_sha256, 'historical_pdf_sha256'),
    primaryCents: nonNegativeCents(payload.historical_primary_cents, 'historical_primary_cents'),
    takkCents: nonNegativeCents(payload.historical_takk_cents, 'historical_takk_cents'),
    scenario: nonBlank(payload.scenario || 'normal', 'scenario', 50),
    accountantReference: payload.accountant_reference ? nonBlank(payload.accountant_reference, 'accountant_reference', 200) : null,
  };
}

async function captureChannelCalibration(type, policyId, payload, actorId, executor = db) {
  if (type !== 'channel') throw policyError('Unknown policy type', 404);
  const actor = nonBlank(actorId, 'capture actor');
  return executor.transaction(async (trx) => {
    const policy = await policyById('channel', policyId, trx);
    if (await latestPolicyDecision(policy, 'channel', trx, { lock: true })) throw policyError('A decided policy cannot accept a new calibration capture', 409);
    const historical = exactHistoricalPrimary(payload, policy);
    const { snapshot, reservation, payload: rawPayload } = await calibrationSnapshot(policy, historical.reservationId, trx);
    const currency = String(reservation.fiscalCurrency || reservation.financials?.currency || 'EUR').trim().toUpperCase();
    if (currency !== 'EUR') throw policyError('Only EUR Guesty evidence can be used for this policy', 409);
    const invoiceItems = assertSingleStayFiscalFolio(reservation);
    const computed = evaluateFolio({ invoiceItems, profile: { status: 'approved', line_rules: JSON.parse(policy.line_rules_json), tolerance_cents: 0 } });
    if (!computed.ok || !Number.isSafeInteger(computed.totalCents)) {
      throw policyError(`Guesty folio cannot be calibrated under this policy: ${(computed.errors || []).map((item) => item.code).join(', ')}`, 409);
    }
    const payloadSha = sha256(rawPayload);
    const previous = await trx('fiscal_evidence_captures').where({
      company_id: policy.company_id, listing_id: policy.listing_id, reservation_id: historical.reservationId,
    }).orderBy('id', 'desc').first();
    let capture = await trx('fiscal_evidence_captures').where({
      company_id: policy.company_id, listing_id: policy.listing_id, reservation_id: historical.reservationId, payload_sha256: payloadSha,
    }).first();
    if (!capture) {
      const result = await trx('fiscal_evidence_captures').insert({
        company_id: policy.company_id, listing_id: policy.listing_id, reservation_id: historical.reservationId,
        platform_key: policy.platform_key, source_key: policy.source_key, guesty_account_id: policy.guesty_account_id, currency,
        folio_updated_at: snapshot.updated_at || null, normalized_payload_json: rawPayload, payload_sha256: payloadSha,
        previous_capture_id: previous?.id || null, previous_capture_sha256: previous?.payload_sha256 || null,
        capture_method: `admin-calibration:${actor}`, guesty_contract_version: 'reservations-v3',
      });
      capture = await trx('fiscal_evidence_captures').where({ id: Number(insertedId(result)) }).first();
    }
    const existing = await trx('channel_policy_samples').where({ policy_id: policy.id, evidence_capture_id: capture.id }).first();
    if (existing) return { capture, sample: { ...existing, idempotent: true } };
    const delta = historical.primaryCents - computed.totalCents;
    const sampleResult = await trx('channel_policy_samples').insert({
      policy_id: policy.id, evidence_capture_id: capture.id, policy_hash: policy.policy_hash, evidence_sha256: payloadSha,
      scenario: historical.scenario, historical_document_type: historical.documentType, historical_series: historical.series,
      historical_mark: historical.mark, historical_uid: historical.uid, historical_pdf_sha256: historical.pdfHash,
      historical_primary_cents: historical.primaryCents, historical_takk_cents: historical.takkCents,
      candidate_source_values_json: JSON.stringify({ computed_total_cents: computed.totalCents, evidence_hash: computed.profileHash, evaluated_line_count: computed.evidence.length }),
      computed_primary_cents: computed.totalCents, delta_cents: delta, passed: delta === 0, stale: false,
      exclusion_reason: delta === 0 ? null : `Guesty/Welcome mismatch: ${delta} cents`, accountant_reference: historical.accountantReference,
    });
    const sample = await trx('channel_policy_samples').where({ id: Number(insertedId(sampleResult)) }).first();
    return { capture, sample };
  });
}

function parsedSeasonRules(policy) {
  let rules;
  try { rules = JSON.parse(policy.season_rules_json); } catch { throw policyError('TAKK policy season rules are invalid', 409); }
  return { high: { from: String(rules?.high?.from || ''), to: String(rules?.high?.to || '') } };
}

function assertTakkScenario(scenario, lines, policy) {
  if (!['low', 'high', 'boundary'].includes(scenario)) throw policyError('scenario must be low, high or boundary');
  if (scenario === 'low' && !lines.every((line) => line.season === 'low')) throw policyError('A low TAKK sample must contain only low-season nights', 409);
  if (scenario === 'high' && !lines.every((line) => line.season === 'high')) throw policyError('A high TAKK sample must contain only high-season nights', 409);
  if (scenario === 'boundary') {
    const season = parsedSeasonRules(policy).high;
    if (!lines.some((line) => line.date.slice(5, 10) === season.from || line.date.slice(5, 10) === season.to)) {
      throw policyError('A boundary TAKK sample must include the configured high-season start or end date', 409);
    }
  }
}

async function captureTakkCalibration(policyId, payload, actorId, executor = db) {
  assertOnlyKeys(payload, new Set(['reservation_id', 'historical_document_type', 'historical_series', 'historical_mark', 'historical_pdf_sha256', 'historical_takk_cents', 'scenario', 'accountant_reference']));
  const actor = nonBlank(actorId, 'capture actor');
  return executor.transaction(async (trx) => {
    const policy = await policyById('takk', policyId, trx);
    if (await latestPolicyDecision(policy, 'takk', trx, { lock: true })) throw policyError('A decided TAKK policy cannot accept a new calibration capture', 409);
    const reservationId = nonBlank(payload.reservation_id, 'reservation_id', 120);
    const documentType = String(payload.historical_document_type || '').trim();
    const series = normalizeSeries(payload.historical_series, { fieldName: 'historical_series', required: true });
    if (documentType !== '8.2' || series !== policy.series) throw policyError('Welcome/myDATA TAKK evidence must be type 8.2 with this policy series', 409);
    const { reservation } = await calibrationSnapshot(policy, reservationId, trx);
    const dates = Array.from({ length: Number(reservation.nights) }, (_value, index) => {
      const start = new Date(`${reservation.checkIn}T12:00:00Z`); start.setUTCDate(start.getUTCDate() + index); return start.toISOString().slice(0, 10);
    });
    if (!dates.length || dates.some((date) => Number.isNaN(new Date(`${date}T12:00:00Z`).getTime()))) throw policyError('Guesty snapshot has no valid TAKK stay nights', 409);
    const lines = feeLines({ ...policy, seasonRules: parsedSeasonRules(policy).high }, dates);
    const scenario = nonBlank(payload.scenario, 'scenario', 20);
    assertTakkScenario(scenario, lines, policy);
    const expectedCents = nonNegativeCents(payload.historical_takk_cents, 'historical_takk_cents');
    const computedCents = lines.reduce((total, line) => total + line.cents, 0);
    const mark = aadeMark(payload.historical_mark);
    const pdfHash = sha256Field(payload.historical_pdf_sha256, 'historical_pdf_sha256');
    const evidenceHash = sha256(JSON.stringify({ policyHash: policy.policy_hash, reservationId, documentType, series, mark, pdfHash, expectedCents, lines }));
    const existing = await trx('takk_calibration_samples').where({ policy_id: policy.id, scenario, evidence_sha256: evidenceHash }).first();
    if (existing) return { ...existing, idempotent: true };
    const result = await trx('takk_calibration_samples').insert({
      policy_id: policy.id, scenario, check_in: reservation.checkIn, check_out: reservation.checkOut,
      expected_cents: expectedCents, computed_cents: computedCents, delta_cents: expectedCents - computedCents,
      passed: expectedCents === computedCents, evidence_sha256: evidenceHash, reservation_id: reservationId,
      historical_mark: mark, historical_document_type: documentType, historical_series: series, historical_pdf_sha256: pdfHash,
      accountant_reference: payload.accountant_reference ? nonBlank(payload.accountant_reference, 'accountant_reference', 200) : `captured-by:${actor}`,
    });
    return trx('takk_calibration_samples').where({ id: Number(insertedId(result)) }).first();
  });
}

async function recordApproval(type, policyId, role, notes, actorId, executor = db) {
  if (!['accounting', 'technical'].includes(role)) throw policyError('Invalid approval role', 403);
  const actor = nonBlank(actorId, 'approval actor');
  return executor.transaction(async (trx) => {
    const policy = await policyById(type, policyId, trx);
    if (await latestPolicyDecision(policy, type, trx, { lock: true })) throw policyError('A decided policy cannot receive a further approval', 409);
    const { id } = policyInfo(type);
    const existing = await trx('policy_approvals').where({ [id]: policy.id, policy_hash: policy.policy_hash, approval_role: role }).first();
    if (existing) return { ...existing, idempotent: true };
    const result = await trx('policy_approvals').insert({ [id]: policy.id, policy_hash: policy.policy_hash, approval_role: role, actor_id: actor, notes: optionalReason(notes) });
    return trx('policy_approvals').where({ id: Number(insertedId(result)) }).first();
  });
}

async function assertChannelEvidenceReady(policy, executor) {
  const samples = await executor('channel_policy_samples as s').join('fiscal_evidence_captures as e', 'e.id', 's.evidence_capture_id')
    .where({ 's.policy_id': policy.id, 's.policy_hash': policy.policy_hash, 's.passed': true, 's.stale': false })
    .whereNotNull('s.historical_mark')
    .select('e.reservation_id', 's.historical_document_type', 's.historical_series', 's.historical_primary_cents', 's.computed_primary_cents', 's.delta_cents');
  const exact = samples.filter((sample) => sample.historical_document_type === policy.document_type
    && sample.historical_series === policy.series
    && Number(sample.historical_primary_cents) === Number(sample.computed_primary_cents)
    && Number(sample.delta_cents) === 0);
  if (new Set(exact.map((sample) => String(sample.reservation_id))).size < 3) {
    throw policyError('Approval requires 3 distinct finalized samples with matching MARK, document type, series and exact Guesty amount', 409);
  }
}

async function assertTakkEvidenceReady(policy, executor) {
  const samples = await executor('takk_calibration_samples').where({ policy_id: policy.id, passed: true }).select('*');
  const scenarios = new Set(samples.filter((sample) => Number(sample.expected_cents) === Number(sample.computed_cents) && Number(sample.delta_cents) === 0).map((sample) => sample.scenario));
  for (const scenario of ['low', 'high', 'boundary']) if (!scenarios.has(scenario)) throw policyError(`Approval requires an exact ${scenario} TAKK calibration sample`, 409);
}

async function assertApprovalsReady(type, policy, executor) {
  const { id } = policyInfo(type);
  const approvals = await executor('policy_approvals').where({ [id]: policy.id, policy_hash: policy.policy_hash }).select('approval_role');
  const roles = new Set(approvals.map((row) => row.approval_role));
  if (!roles.has('accounting') || !roles.has('technical')) throw policyError('Approval decision requires separate accounting and technical approval', 409);
}

async function recordDecision(type, policyId, payload, actorId, idempotencyKey, executor = db) {
  assertOnlyKeys(payload, new Set(['decision', 'reason']));
  const decision = String(payload.decision || '').trim();
  if (!['approved', 'blocked', 'suspended'].includes(decision)) throw policyError('decision must be approved, blocked or suspended');
  const key = nonBlank(idempotencyKey, 'Idempotency-Key', 100);
  const actor = nonBlank(actorId, 'decision actor');
  return executor.transaction(async (trx) => {
    const existing = await trx('policy_decision_events').where({ idempotency_key: key }).first();
    if (existing) {
      const { id } = policyInfo(type);
      if (Number(existing[id]) !== positiveId(policyId, 'policy id')) throw policyError('Idempotency-Key was already used for another policy', 409);
      return { ...existing, idempotent: true };
    }
    const policy = await policyById(type, policyId, trx);
    const latest = await latestPolicyDecision(policy, type, trx, { lock: true });
    if (latest?.decision === 'approved' && decision === 'approved') throw policyError('Policy already has an active approval decision', 409);
    if (decision === 'approved') {
      await assertApprovalsReady(type, policy, trx);
      if (type === 'channel') await assertChannelEvidenceReady(policy, trx); else await assertTakkEvidenceReady(policy, trx);
    }
    const { id } = policyInfo(type);
    const result = await trx('policy_decision_events').insert({ [id]: policy.id, policy_hash: policy.policy_hash, decision, idempotency_key: key, actor_id: actor, reason: optionalReason(payload.reason) });
    return trx('policy_decision_events').where({ id: Number(insertedId(result)) }).first();
  });
}

async function listPolicyVersions(type, filters = {}, executor = db) {
  const { table, id } = policyInfo(type);
  const query = executor(table).select('*').orderBy('created_at', 'desc').limit(200);
  if (filters.listingId) query.where('listing_id', positiveId(filters.listingId, 'listing_id'));
  const policies = await query;
  const policyIds = policies.map((policy) => policy.id);
  const decisions = policyIds.length ? await executor('policy_decision_events').whereIn(id, policyIds).orderBy('decided_at', 'desc').orderBy('id', 'desc') : [];
  const latest = new Map();
  for (const decision of decisions) if (!latest.has(Number(decision[id]))) latest.set(Number(decision[id]), decision);
  return policies.map((policy) => ({ ...policy, latest_decision: latest.get(Number(policy.id)) || null }));
}

module.exports = {
  createChannelPolicyDraft, createTakkPolicyDraft, captureChannelCalibration, captureTakkCalibration, listPolicyVersions, recordApproval, recordDecision,
  policyById, policyError,
};

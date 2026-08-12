'use strict';

const { db } = require('../database');
const { isEncrypted, isContextBound } = require('../security/credentials');
const { listIntegrationChecks } = require('../repositories/integration-checks');
const { normalizeAndValidateGreekVat, normalizeCounterpart, normalizeSeries, validateAccommodationClimatePair } = require('../validation/fiscal-fields');
const { getAcceptanceMatrices } = require('./sandbox-acceptance-service');
const { takkPolicyHash } = require('./takk-policy-service');
const { channelPolicyHash } = require('./unified-channel-policy-service');
const { approvedPolicyIds } = require('./policy-decision-service');

function issue(code, message, scope = 'runtime') {
  return { code, message, scope };
}

function validationError(check) {
  try { check(); return null; } catch (error) { return error.message; }
}

function normalizeCompanyId(companyId) {
  if (companyId === null || companyId === undefined) return null;
  const normalized = Number(companyId);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw Object.assign(new Error('companyId must be a positive integer'), { status: 400 });
  }
  return normalized;
}

async function getReadiness({ companyId = null } = {}) {
  const scopedCompanyId = normalizeCompanyId(companyId);
  const companiesQuery = db('companies').where({ active: true }).select('*');
  const listingsQuery = db('listings').where({ active: true }).select('*');
  const rulesQuery = db('listing_channel_billing_rules as r')
    .join('listings as l', 'l.id', 'r.listing_id')
    .where({ 'r.active': true })
    .select('r.*');
  const legacyRulesQuery = db('listing_billing_rules as r')
    .join('listings as l', 'l.id', 'r.listing_id')
    .where({ 'r.active': true })
    .count({ count: '*' })
    .first();
  const financialProfilesQuery = db('financial_profiles as p')
    .join('listings as l', 'l.id', 'p.listing_id')
    .select('p.id', 'p.listing_id', 'p.platform_key', 'p.source_key', 'p.version', 'p.status', 'p.line_rules', 'p.minimum_samples');
  const channelPoliciesQuery = db('channel_policy_versions as p')
    .join('listings as l', 'l.id', 'p.listing_id')
    .select('p.*');
  const takkPoliciesQuery = db('takk_policy_versions as p')
    .join('listings as l', 'l.id', 'p.listing_id')
    .select('p.*');
  const observedChannelsQuery = db('reservation_snapshots')
      .whereIn('status', ['confirmed', 'checked_out'])
      .whereNull('materialized_at')
      .select('listing_id', 'listing_id_guesty', 'platform_key', 'source_key')
      .groupBy('listing_id', 'listing_id_guesty', 'platform_key', 'source_key');
  const reviewCountQuery = db('reservation_snapshots').where({ requires_review: true }).count({ count: '*' }).first();
  const uncertainCountQuery = db('fiscal_documents').where({ transmission_uncertain: true }).count({ count: '*' }).first();
  const cancellationUncertainCountQuery = db('fiscal_documents').where({ cancellation_uncertain: true }).count({ count: '*' }).first();
  const cancellationUnverifiedCountQuery = db('fiscal_documents')
      .where({ status: 'cancelled', cancellation_status: 'cancelled' })
      .whereNot({ cancellation_verification_status: 'verified' })
      .count({ count: '*' }).first();
  const environmentMismatchQuery = db('fiscal_documents')
      .whereIn('status', ['pending', 'failed', 'transmitting'])
      .where((query) => query.whereNull('target_environment').orWhereNot({ target_environment: 'production' }))
      .select('company_id', 'target_environment')
      .groupBy('company_id', 'target_environment');
  const pendingProductionDocumentsQuery = db('fiscal_documents')
    .where({ target_environment: 'production' })
    .whereIn('status', ['pending', 'failed', 'transmitting'])
    .select('id', 'company_id', 'document_type', 'source_payload');

  if (scopedCompanyId !== null) {
    companiesQuery.where({ id: scopedCompanyId });
    listingsQuery.where({ company_id: scopedCompanyId });
    rulesQuery.where({ 'l.company_id': scopedCompanyId });
    legacyRulesQuery.where({ 'l.company_id': scopedCompanyId });
    financialProfilesQuery.where({ 'l.company_id': scopedCompanyId });
    channelPoliciesQuery.where({ 'l.company_id': scopedCompanyId });
    takkPoliciesQuery.where({ 'l.company_id': scopedCompanyId });
    observedChannelsQuery.where({ company_id: scopedCompanyId });
    reviewCountQuery.where({ company_id: scopedCompanyId });
    uncertainCountQuery.where({ company_id: scopedCompanyId });
    cancellationUncertainCountQuery.where({ company_id: scopedCompanyId });
    cancellationUnverifiedCountQuery.where({ company_id: scopedCompanyId });
    environmentMismatchQuery.where({ company_id: scopedCompanyId });
    pendingProductionDocumentsQuery.where({ company_id: scopedCompanyId });
  }

  const [companies, listings, rules, legacyRuleCountRow, financialProfiles, channelPolicies, takkPolicies, observedChannels, reviewCountRow, uncertainCountRow, cancellationUncertainCountRow, cancellationUnverifiedCountRow, environmentMismatchRows, pendingProductionDocuments, allChecks] = await Promise.all([
    companiesQuery,
    listingsQuery,
    rulesQuery,
    legacyRulesQuery,
    financialProfilesQuery,
    channelPoliciesQuery,
    takkPoliciesQuery,
    observedChannelsQuery,
    reviewCountQuery,
    uncertainCountQuery,
    cancellationUncertainCountQuery,
    cancellationUnverifiedCountQuery,
    environmentMismatchQuery,
    pendingProductionDocumentsQuery,
    listIntegrationChecks(scopedCompanyId === null ? undefined : { companyId: scopedCompanyId }),
  ]);
  const checks = allChecks;
  const [approvedChannelPolicyIds, approvedTakkPolicyIds] = await Promise.all([
    approvedPolicyIds(channelPolicies, 'channel'),
    approvedPolicyIds(takkPolicies, 'takk'),
  ]);
  const acceptance = await getAcceptanceMatrices(companies);
  const issues = [];
  const freshAfter = Date.now() - 24 * 60 * 60 * 1000;
  const isFreshSuccess = (row) => row?.status === 'success' && Date.parse(row.checked_at) >= freshAfter;
  if (!process.env.GUESTY_CLIENT_ID || !process.env.GUESTY_CLIENT_SECRET) issues.push(issue('guesty_credentials', 'Λείπουν Guesty OAuth credentials'));
  if (!process.env.GUESTY_WEBHOOK_SECRET) issues.push(issue('guesty_webhook_secret', 'Λείπει Guesty webhook secret'));
  const encryptionKey = Buffer.from(process.env.DATA_ENCRYPTION_KEY || '', 'base64');
  if (encryptionKey.length !== 32) issues.push(issue('encryption_key', 'Το DATA_ENCRYPTION_KEY δεν είναι έγκυρο κλειδί 32 bytes'));
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_API_TOKEN) issues.push(issue('admin_auth', 'Λείπει ADMIN_API_TOKEN σε production'));
  if (companies.length === 0) issues.push(issue('companies', 'Δεν υπάρχει ενεργή εταιρεία'));
  if (listings.length === 0) issues.push(issue('listings', 'Δεν υπάρχει ενεργό κατάλυμα'));
  const legacyRuleCount = Number(legacyRuleCountRow?.count || 0);
  if (legacyRuleCount > 0) {
    issues.push(issue('legacy_billing_rules', `${legacyRuleCount} παλιοί κανόνες μόνο ανά source πρέπει να αντικατασταθούν με ακριβείς platform/source κανόνες`));
  }
  const activeCompanyIds = new Set(companies.map((company) => Number(company.id)));
  const activeListingIds = new Set(listings.map((listing) => Number(listing.id)));
  const today = new Date().toISOString().slice(0, 10);

  for (const company of companies) {
    const scope = `company:${company.id}`;
    const vatError = validationError(() => normalizeAndValidateGreekVat(company.vat_number));
    if (vatError) issues.push(issue('issuer_vat', `${company.company_name}: ${vatError}`, scope));
    const seriesError = validationError(() => normalizeSeries(company.invoice_series, { required: true }));
    if (seriesError) issues.push(issue('invoice_series', `${company.company_name}: ${seriesError}`, scope));
    const credentialsConfigured = Boolean(company.aade_user_id && company.aade_subscription_key);
    if (!credentialsConfigured || company.aade_credential_status === 'pending') {
      issues.push(issue('aade_credentials_pending', `${company.company_name}: εκκρεμεί η ασφαλής καταχώρηση credentials ΑΑΔΕ`, scope));
    } else {
      if (!isEncrypted(company.aade_user_id) || !isEncrypted(company.aade_subscription_key)) issues.push(issue('encrypted_credentials', `${company.company_name}: τα credentials ΑΑΔΕ δεν είναι κρυπτογραφημένα`, scope));
      if (!isContextBound(company.aade_user_id) || !isContextBound(company.aade_subscription_key)) issues.push(issue('context_bound_credentials', `${company.company_name}: τα credentials ΑΑΔΕ δεν έχουν ακόμη μεταφερθεί σε tenant-bound encryption v2`, scope));
      if (company.aade_credential_status !== 'verified' || !company.aade_credentials_verified_at) {
        issues.push(issue('aade_credentials_unverified', `${company.company_name}: τα credentials ΑΑΔΕ δεν έχουν επαληθευτεί επιτυχώς στο myDATA sandbox`, scope));
      }
    }
    if (!company.pdf_address || !company.pdf_tax_office) issues.push(issue('pdf_issuer_profile', `${company.company_name}: λείπει διεύθυνση ή ΔΟΥ για το PDF`, scope));
    const check = checks.find((row) => row.check_key === `mydata:${company.id}:sandbox` && row.environment === 'sandbox');
    if (!isFreshSuccess(check)) issues.push(issue('mydata_sandbox_check', `${company.company_name}: λείπει πρόσφατη (24ωρο) επιτυχής σύνδεση myDATA sandbox`, scope));
  }

  for (const listing of listings) {
    const scope = `listing:${listing.id}`;
    if (!activeCompanyIds.has(Number(listing.company_id))) issues.push(issue('inactive_company', `${listing.listing_id_guesty}: η συνδεδεμένη εταιρεία δεν είναι ενεργή`, scope));
    for (const field of ['climate_fee_high', 'climate_fee_low', 'climate_fee_high_category', 'climate_fee_low_category']) {
      if (listing[field] === null || listing[field] === undefined) issues.push(issue('takk_config', `${listing.listing_id_guesty}: λείπει ${field}`, scope));
    }
    if (Number(listing.climate_fee_high) <= 0 || Number(listing.climate_fee_low) <= 0) {
      issues.push(issue('takk_amount', `${listing.listing_id_guesty}: τα ποσά ΤΑΚΚ υψηλής/χαμηλής περιόδου πρέπει να είναι θετικά για ενεργό κατάλυμα`, scope));
    }
    const categoryError = validationError(() => validateAccommodationClimatePair(
      listing.property_type, listing.climate_fee_high_category, listing.climate_fee_low_category,
    ));
    if (categoryError) issues.push(issue('takk_category', `${listing.listing_id_guesty}: ${categoryError}`, scope));
    const climateSeriesError = validationError(() => normalizeSeries(listing.climate_fee_series, { fieldName: 'climate_fee_series', required: true }));
    if (climateSeriesError) issues.push(issue('takk_series', `${listing.listing_id_guesty}: ${climateSeriesError}`, scope));
    const counterpartError = validationError(() => normalizeCounterpart({
      vatNumber: listing.invoice_counterpart_vat_number,
      country: listing.invoice_counterpart_country,
      name: listing.invoice_counterpart_name,
      branch: listing.invoice_counterpart_branch,
    }, { required: listing.default_invoice_type === '2.1', label: 'invoice_counterpart' }));
    if (counterpartError) issues.push(issue('default_tpy_counterpart', `${listing.listing_id_guesty}: ${counterpartError}`, scope));

    const activeTakk = takkPolicies.filter((policy) => Number(policy.listing_id) === Number(listing.id)
      && approvedTakkPolicyIds.has(Number(policy.id)) && String(policy.valid_from) <= today && (!policy.valid_to || String(policy.valid_to) >= today));
    if (activeTakk.length !== 1) {
      issues.push(issue('takk_policy_missing', `${listing.listing_id_guesty}: απαιτείται ακριβώς μία εγκεκριμένη TAKK policy για την τρέχουσα περίοδο`, scope));
    }
  }

  for (const policy of takkPolicies.filter((row) => approvedTakkPolicyIds.has(Number(row.id)))) {
    const scope = `takk-policy:${policy.id}`;
    try {
      if (takkPolicyHash(policy) !== policy.policy_hash) throw new Error('policy hash does not match configuration');
    } catch (error) {
      issues.push(issue('takk_policy_hash', `TAKK policy ${policy.id}: ${error.message}`, scope));
      continue;
    }
    const [samples, approvals] = await Promise.all([
      db('takk_calibration_samples').where({ policy_id: policy.id, passed: true }).select('scenario'),
      db('policy_approvals').where({ takk_policy_id: policy.id, policy_hash: policy.policy_hash }).select('approval_role'),
    ]);
    const scenarios = new Set(samples.map((sample) => sample.scenario));
    const roles = new Set(approvals.map((approval) => approval.approval_role));
    if (!scenarios.has('low') || !scenarios.has('high') || !scenarios.has('boundary')) {
      issues.push(issue('takk_policy_calibration', `TAKK policy ${policy.id}: λείπουν approved low/high/boundary samples`, scope));
    }
    if (!roles.has('accounting') || !roles.has('technical')) {
      issues.push(issue('takk_policy_approvals', `TAKK policy ${policy.id}: λείπει λογιστική ή τεχνική έγκριση`, scope));
    }
  }
  for (const rule of rules) {
    const scope = `rule:${rule.id}`;
    if (!activeListingIds.has(Number(rule.listing_id))) issues.push(issue('inactive_listing', `Billing rule ${rule.id}: το συνδεδεμένο κατάλυμα δεν είναι ενεργό`, scope));
    const seriesError = validationError(() => normalizeSeries(rule.series));
    if (seriesError) issues.push(issue('rule_series', `Billing rule ${rule.id}: ${seriesError}`, scope));
    const counterpartError = validationError(() => normalizeCounterpart({
      vatNumber: rule.counterpart_vat_number,
      country: rule.counterpart_country,
      name: rule.counterpart_name,
      branch: rule.counterpart_branch,
    }, { required: rule.invoice_type === '2.1', label: 'counterpart' }));
    if (counterpartError) issues.push(issue('rule_tpy_counterpart', `Billing rule ${rule.id}: ${counterpartError}`, scope));
  }
  const approvedFinancialKeys = new Set(financialProfiles
    .filter((profile) => profile.status === 'approved')
    .map((profile) => `${profile.listing_id}\u0000${profile.platform_key}\u0000${profile.source_key}`));
  for (const profile of financialProfiles.filter((row) => row.status === 'approved')) {
    const scope = `financial-profile:${profile.id}`;
    let lineRules = [];
    try { lineRules = JSON.parse(profile.line_rules || '[]'); } catch { /* handled below */ }
    if (!Array.isArray(lineRules) || lineRules.length === 0) {
      issues.push(issue('financial_profile_rules', `Profile ${profile.id}: λείπουν έγκυροι line rules`, scope));
      continue;
    }
    const hasBroadInclude = lineRules.some((rule) => {
      const decision = rule.decision || rule.action || (rule.include === true ? 'include' : 'exclude');
      return decision === 'include' && !['origin', 'title', 'secondIdentifier', 'isDeducted', 'isDeductedV2'].some((field) => rule[field] !== undefined);
    });
    if (hasBroadInclude) issues.push(issue('financial_profile_broad_include', `Profile ${profile.id}: broad include χωρίς σταθερό Guesty discriminator`, scope));
    if (Number(profile.minimum_samples) < 3) issues.push(issue('financial_profile_samples', `Profile ${profile.id}: απαιτούνται τουλάχιστον 3 calibration samples`, scope));
  }
  for (const channel of observedChannels) {
    const scope = `listing:${channel.listing_id}`;
    if (!channel.platform_key || !channel.source_key) {
      issues.push(issue('financial_channel_unidentified', `${channel.listing_id_guesty}: δεν έχει αναγνωριστεί ακόμη platform/source από Guesty`, scope));
      continue;
    }
    const key = `${channel.listing_id}\u0000${channel.platform_key}\u0000${channel.source_key}`;
    if (!approvedFinancialKeys.has(key)) {
      issues.push(issue('financial_profile_missing', `${channel.listing_id_guesty}: λείπει εγκεκριμένο profile ποσών για ${channel.platform_key} / ${channel.source_key}`, scope));
    }
    const channelPoliciesForTuple = channelPolicies.filter((policy) => Number(policy.listing_id) === Number(channel.listing_id)
      && approvedChannelPolicyIds.has(Number(policy.id)) && policy.platform_key === channel.platform_key && policy.source_key === channel.source_key
      && String(policy.guesty_account_id) === String(process.env.GUESTY_ACCOUNT_ID || '')
      && String(policy.currency || 'EUR') === 'EUR'
      && (!policy.valid_from || String(policy.valid_from) <= today) && (!policy.valid_to || String(policy.valid_to) >= today));
    if (channelPoliciesForTuple.length !== 1) {
      issues.push(issue('unified_channel_policy_missing', `${channel.listing_id_guesty}: απαιτείται ακριβώς μία εγκεκριμένη unified policy για ${channel.platform_key} / ${channel.source_key}`, scope));
      continue;
    }
    const policy = channelPoliciesForTuple[0];
    try {
      if (channelPolicyHash(policy) !== policy.policy_hash) throw new Error('policy hash does not match configuration');
      const [samples, approvals] = await Promise.all([
        db('channel_policy_samples as s').join('fiscal_evidence_captures as e', 'e.id', 's.evidence_capture_id')
          .where({ 's.policy_id': policy.id, 's.policy_hash': policy.policy_hash, 's.passed': true, 's.stale': false })
          .whereNotNull('s.historical_mark').select('e.reservation_id'),
        db('policy_approvals').where({ channel_policy_id: policy.id, policy_hash: policy.policy_hash }).select('approval_role'),
      ]);
      if (new Set(samples.map((sample) => String(sample.reservation_id))).size < 3) throw new Error('requires 3 distinct finalized samples');
      const roles = new Set(approvals.map((approval) => approval.approval_role));
      if (!roles.has('accounting') || !roles.has('technical')) throw new Error('requires accounting and technical approvals');
    } catch (error) {
      issues.push(issue('unified_channel_policy_invalid', `Unified policy ${policy.id}: ${error.message}`, `channel-policy:${policy.id}`));
    }
  }
  const guestyCheck = checks.find((row) => row.check_key === 'guesty');
  if (!isFreshSuccess(guestyCheck)) issues.push(issue('guesty_connection_check', 'Λείπει πρόσφατη (24ωρο) επιτυχής σύνδεση Guesty'));
  const reviewCount = Number(reviewCountRow?.count || 0);
  if (reviewCount > 0) issues.push(issue('reservation_reviews', `${reviewCount} κρατήσεις χρειάζονται φορολογικό έλεγχο`));
  const uncertainCount = Number(uncertainCountRow?.count || 0);
  if (uncertainCount > 0) issues.push(issue('uncertain_transmissions', `${uncertainCount} μεταδόσεις έχουν αβέβαιο αποτέλεσμα και απαιτούν συμφωνία MARK`));
  const cancellationUncertainCount = Number(cancellationUncertainCountRow?.count || 0);
  if (cancellationUncertainCount > 0) issues.push(issue('uncertain_cancellations', `${cancellationUncertainCount} ακυρώσεις έχουν αβέβαιο αποτέλεσμα και απαιτούν συμφωνία`));
  const cancellationUnverifiedCount = Number(cancellationUnverifiedCountRow?.count || 0);
  if (cancellationUnverifiedCount > 0) issues.push(issue('unverified_cancellations', `${cancellationUnverifiedCount} ακυρώσεις έχουν MARK που δεν έχει ακόμη επαληθευτεί με RequestTransmittedDocs`));

  const sandboxReady = issues.length === 0;
  // A sandbox connection check is acceptance evidence, not a renewable
  // production health check. Production instead requires its own current-env
  // read-only check, while the signed-off sandbox MARK remains durable evidence.
  const productionIssues = issues.filter((item) => item.code !== 'mydata_sandbox_check');
  for (const row of environmentMismatchRows) {
    productionIssues.push(issue(
      'fiscal_target_environment',
      `Υπάρχουν μη ολοκληρωμένα παραστατικά ${row.target_environment || 'legacy/άγνωστου'} περιβάλλοντος· ακυρώστε τα ή επανεκδώστε τα πριν από production`,
      `company:${row.company_id}`,
    ));
  }
  for (const document of pendingProductionDocuments) {
    let source = {};
    try { source = JSON.parse(document.source_payload || '{}'); } catch { /* reported below */ }
    const hasChannel = Boolean(source?.billingSnapshot?.unified_channel_policy?.policy_hash);
    const hasTakk = Boolean(source?.climateSnapshot?.unified_takk_policy?.policy_hash);
    const valid = document.document_type === '8.2' ? hasTakk : hasChannel;
    if (!valid) productionIssues.push(issue(
      'unified_policy_provenance',
      `Το production παραστατικό ${document.id} (${document.document_type}) δεν έχει frozen unified policy provenance και δεν επιτρέπεται να σταλεί`,
      `company:${document.company_id}`,
    ));
  }
  for (const company of companies) {
    const productionCheck = checks.find((row) => row.check_key === `mydata:${company.id}:production` && row.environment === 'production');
    if (!isFreshSuccess(productionCheck)) {
      productionIssues.push(issue('mydata_production_check', `${company.company_name}: λείπει πρόσφατη (24ωρο) επιτυχής σύνδεση myDATA production`, `company:${company.id}`));
    }
  }
  if ((process.env.DB_CLIENT || 'better-sqlite3') !== 'pg') productionIssues.push(issue('production_database', 'Για production απαιτείται PostgreSQL'));
  if (process.env.DAILY_CLOSE_ENABLED !== 'true') productionIssues.push(issue('daily_close_disabled', 'Για production απαιτείται DAILY_CLOSE_ENABLED=true'));
  for (const matrix of acceptance) {
    for (const capability of matrix.missing) {
      productionIssues.push(issue(
        'sandbox_capability',
        `${matrix.companyName}: λείπει λογιστικά εγκεκριμένο sandbox evidence για ${capability}`,
        `company:${matrix.companyId}`,
      ));
    }
  }
  if (process.env.MYDATA_PRODUCTION_ENABLED !== 'true') productionIssues.push(issue('production_breaker', 'Το MYDATA_PRODUCTION_ENABLED παραμένει απενεργοποιημένο'));

  return {
    sandboxReady,
    productionReady: productionIssues.length === 0,
    issues,
    productionIssues,
    acceptance,
    checks: checks.map((row) => ({ key: row.check_key, status: row.status, environment: row.environment, checked_at: row.checked_at })),
    counts: {
      companies: companies.length,
      listings: listings.length,
      reviews: reviewCount,
      uncertainTransmissions: uncertainCount,
      uncertainCancellations: cancellationUncertainCount,
      unverifiedCancellations: cancellationUnverifiedCount,
      financialProfiles: financialProfiles.length,
      unifiedChannelPolicies: channelPolicies.length,
      takkPolicies: takkPolicies.length,
      observedFinancialChannels: observedChannels.length,
      sandboxAcceptedCapabilities: acceptance.reduce((sum, matrix) => sum + matrix.accepted.length, 0),
    },
  };
}

module.exports = { getReadiness };

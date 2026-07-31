'use strict';

const { db } = require('../database');
const { isEncrypted, isContextBound, companyCredentialBinding } = require('../security/credentials');
const { listIntegrationChecks } = require('../repositories/integration-checks');
const { normalizeAndValidateGreekVat, normalizeCounterpart, normalizeSeries, validateAccommodationClimatePair } = require('../validation/fiscal-fields');

function issue(code, message, scope = 'runtime') {
  return { code, message, scope };
}

function validationError(check) {
  try { check(); return null; } catch (error) { return error.message; }
}

async function getReadiness() {
  const [companies, listings, rules, legacyRuleCountRow, financialProfiles, observedChannels, reviewCountRow, uncertainCountRow, cancellationUncertainCountRow, checks, sandboxSignoffs] = await Promise.all([
    db('companies').where({ active: true }).select('*'),
    db('listings').where({ active: true }).select('*'),
    db('listing_channel_billing_rules').where({ active: true }).select('*'),
    db('listing_billing_rules').where({ active: true }).count({ count: '*' }).first(),
    db('financial_profiles').select('id', 'listing_id', 'platform_key', 'source_key', 'version', 'status', 'line_rules', 'minimum_samples'),
    db('reservation_snapshots')
      .whereIn('status', ['confirmed', 'checked_out'])
      .whereNull('materialized_at')
      .select('listing_id', 'listing_id_guesty', 'platform_key', 'source_key')
      .groupBy('listing_id', 'listing_id_guesty', 'platform_key', 'source_key'),
    db('reservation_snapshots').where({ requires_review: true }).count({ count: '*' }).first(),
    db('fiscal_documents').where({ transmission_uncertain: true }).count({ count: '*' }).first(),
    db('fiscal_documents').where({ cancellation_uncertain: true }).count({ count: '*' }).first(),
    listIntegrationChecks(),
    db('sandbox_signoffs').select('company_id', 'reservation_id', 'issuer_vat', 'credential_binding_sha256', 'primary_mark', 'takk_mark', 'approved_by', 'approved_at'),
  ]);
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

  for (const company of companies) {
    const scope = `company:${company.id}`;
    const vatError = validationError(() => normalizeAndValidateGreekVat(company.vat_number));
    if (vatError) issues.push(issue('issuer_vat', `${company.company_name}: ${vatError}`, scope));
    const seriesError = validationError(() => normalizeSeries(company.invoice_series, { required: true }));
    if (seriesError) issues.push(issue('invoice_series', `${company.company_name}: ${seriesError}`, scope));
    if (!isEncrypted(company.aade_user_id) || !isEncrypted(company.aade_subscription_key)) issues.push(issue('encrypted_credentials', `${company.company_name}: τα credentials ΑΑΔΕ δεν είναι κρυπτογραφημένα`, scope));
    if (!isContextBound(company.aade_user_id) || !isContextBound(company.aade_subscription_key)) issues.push(issue('context_bound_credentials', `${company.company_name}: τα credentials ΑΑΔΕ δεν έχουν ακόμη μεταφερθεί σε tenant-bound encryption v2`, scope));
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
    }, { required: listing.default_invoice_type === '2.1', label: 'invoice_counterpart' }));
    if (counterpartError) issues.push(issue('default_tpy_counterpart', `${listing.listing_id_guesty}: ${counterpartError}`, scope));
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
  }
  const guestyCheck = checks.find((row) => row.check_key === 'guesty');
  if (!isFreshSuccess(guestyCheck)) issues.push(issue('guesty_connection_check', 'Λείπει πρόσφατη (24ωρο) επιτυχής σύνδεση Guesty'));
  const reviewCount = Number(reviewCountRow?.count || 0);
  if (reviewCount > 0) issues.push(issue('reservation_reviews', `${reviewCount} κρατήσεις χρειάζονται φορολογικό έλεγχο`));
  const uncertainCount = Number(uncertainCountRow?.count || 0);
  if (uncertainCount > 0) issues.push(issue('uncertain_transmissions', `${uncertainCount} μεταδόσεις έχουν αβέβαιο αποτέλεσμα και απαιτούν συμφωνία MARK`));
  const cancellationUncertainCount = Number(cancellationUncertainCountRow?.count || 0);
  if (cancellationUncertainCount > 0) issues.push(issue('uncertain_cancellations', `${cancellationUncertainCount} ακυρώσεις έχουν αβέβαιο αποτέλεσμα και απαιτούν συμφωνία`));

  const sandboxReady = issues.length === 0;
  // A sandbox connection check is acceptance evidence, not a renewable
  // production health check. Production instead requires its own current-env
  // read-only check, while the signed-off sandbox MARK remains durable evidence.
  const productionIssues = issues.filter((item) => item.code !== 'mydata_sandbox_check');
  for (const company of companies) {
    const productionCheck = checks.find((row) => row.check_key === `mydata:${company.id}:production` && row.environment === 'production');
    if (!isFreshSuccess(productionCheck)) {
      productionIssues.push(issue('mydata_production_check', `${company.company_name}: λείπει πρόσφατη (24ωρο) επιτυχής σύνδεση myDATA production`, `company:${company.id}`));
    }
  }
  if ((process.env.DB_CLIENT || 'better-sqlite3') !== 'pg') productionIssues.push(issue('production_database', 'Για production απαιτείται PostgreSQL'));
  if (process.env.DAILY_CLOSE_ENABLED !== 'true') productionIssues.push(issue('daily_close_disabled', 'Για production απαιτείται DAILY_CLOSE_ENABLED=true'));
  for (const company of companies) {
    if (!sandboxSignoffs.some((signoff) => Number(signoff.company_id) === Number(company.id)
      && signoff.issuer_vat === company.vat_number
      && signoff.credential_binding_sha256 === companyCredentialBinding(company))) {
      productionIssues.push(issue('sandbox_signoff', `${company.company_name}: λείπει λογιστικά εγκεκριμένο sandbox ζεύγος ΑΠΥ/ΤΠΥ + ΤΑΚΚ`, `company:${company.id}`));
    }
  }
  if (process.env.MYDATA_PRODUCTION_ENABLED !== 'true') productionIssues.push(issue('production_breaker', 'Το MYDATA_PRODUCTION_ENABLED παραμένει απενεργοποιημένο'));

  return {
    sandboxReady,
    productionReady: productionIssues.length === 0,
    issues,
    productionIssues,
    checks: checks.map((row) => ({ key: row.check_key, status: row.status, environment: row.environment, checked_at: row.checked_at })),
    counts: {
      companies: companies.length,
      listings: listings.length,
      reviews: reviewCount,
      uncertainTransmissions: uncertainCount,
      uncertainCancellations: cancellationUncertainCount,
      financialProfiles: financialProfiles.length,
      observedFinancialChannels: observedChannels.length,
      sandboxSignoffs: sandboxSignoffs.length,
    },
  };
}

module.exports = { getReadiness };

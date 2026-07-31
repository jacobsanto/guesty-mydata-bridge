'use strict';

const { getCompanyById } = require('../repositories/companies');
const { testMyDataConnection } = require('../mydata-client');
const { testGuestyConnection } = require('../guesty/client');
const { recordIntegrationCheck } = require('../repositories/integration-checks');
const { db } = require('../database');
const {
  assertConfiguredAadeCredentials, assertVerifiedAadeCredentials,
} = require('../security/aade-credential-guard');

async function testCompanyMyDataConnection(companyId, tester = testMyDataConnection) {
  const company = await getCompanyById(companyId);
  if (!company) throw Object.assign(new Error('Company not found'), { status: 404 });
  const environment = process.env.MYDATA_ENV || 'sandbox';
  try {
    const context = environment === 'production'
      ? assertVerifiedAadeCredentials(company)
      : assertConfiguredAadeCredentials(company);
    const result = await tester(context);
    if (result?.success !== true) throw new Error('myDATA connection test did not confirm success');
    await db.transaction(async (trx) => {
      await recordIntegrationCheck(`mydata:${company.id}:${environment}`, 'success', result.environment || environment, null, trx);
      if (environment === 'sandbox') {
        await trx('companies').where({ id: company.id }).update({
          aade_credential_status: 'verified',
          aade_credentials_verified_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        });
      }
    });
    return result;
  } catch (error) {
    await db.transaction(async (trx) => {
      await recordIntegrationCheck(`mydata:${company.id}:${environment}`, 'failed', environment, error.message, trx);
      if (environment === 'sandbox' && company.aade_credential_status !== 'pending') {
        await trx('companies').where({ id: company.id }).update({
          aade_credential_status: 'configured',
          aade_credentials_verified_at: null,
          updated_at: trx.fn.now(),
        });
      }
    });
    throw error;
  }
}

async function testConfiguredGuestyConnection(tester = testGuestyConnection) {
  try {
    const result = await tester();
    await recordIntegrationCheck('guesty', 'success', null);
    return result;
  } catch (error) {
    await recordIntegrationCheck('guesty', 'failed', null, error.message);
    throw error;
  }
}

module.exports = { testCompanyMyDataConnection, testConfiguredGuestyConnection };

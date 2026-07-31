'use strict';

const { getCompanyById } = require('../repositories/companies');
const { decryptCompanySecret } = require('../security/credentials');
const { testMyDataConnection } = require('../mydata-client');
const { testGuestyConnection } = require('../guesty/client');
const { recordIntegrationCheck } = require('../repositories/integration-checks');

async function testCompanyMyDataConnection(companyId, tester = testMyDataConnection) {
  const company = await getCompanyById(companyId);
  if (!company) throw Object.assign(new Error('Company not found'), { status: 404 });
  try {
    const environment = process.env.MYDATA_ENV || 'sandbox';
    const result = await tester({
      ...company,
      aade_user_id: decryptCompanySecret(company, 'aade_user_id'),
      aade_subscription_key: decryptCompanySecret(company, 'aade_subscription_key'),
    });
    await recordIntegrationCheck(`mydata:${company.id}:${environment}`, 'success', result.environment || environment);
    return result;
  } catch (error) {
    const environment = process.env.MYDATA_ENV || 'sandbox';
    await recordIntegrationCheck(`mydata:${company.id}:${environment}`, 'failed', environment, error.message);
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

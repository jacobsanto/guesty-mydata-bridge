'use strict';

async function assertProductionTransmissionEnabled(action = 'transmissions', companyId = null) {
  if (process.env.MYDATA_ENV !== 'production') return;
  if (process.env.MYDATA_PRODUCTION_ENABLED !== 'true') {
    const error = new Error(`Production myDATA ${action} are disabled`);
    error.status = 503;
    throw error;
  }
  if (action === 'submissions') {
    const normalizedCompanyId = Number(companyId);
    if (!Number.isInteger(normalizedCompanyId) || normalizedCompanyId <= 0) {
      const error = new Error('Production submission guard requires a company id');
      error.status = 503;
      throw error;
    }
    const { getReadiness } = require('../services/readiness-service');
    const readiness = await getReadiness({ companyId: normalizedCompanyId });
    if (!readiness.productionReady) {
      const summary = readiness.productionIssues.map((item) => item.message).join('; ');
      const error = new Error(`Production myDATA preflight failed: ${summary}`);
      error.status = 503;
      throw error;
    }
  }
}

module.exports = { assertProductionTransmissionEnabled };

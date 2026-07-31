'use strict';

async function assertProductionTransmissionEnabled(action = 'transmissions') {
  if (process.env.MYDATA_ENV !== 'production') return;
  if (process.env.MYDATA_PRODUCTION_ENABLED !== 'true') {
    const error = new Error(`Production myDATA ${action} are disabled`);
    error.status = 503;
    throw error;
  }
  if (action === 'submissions') {
    const { getReadiness } = require('../services/readiness-service');
    const readiness = await getReadiness();
    if (!readiness.productionReady) {
      const summary = readiness.productionIssues.map((item) => item.message).join('; ');
      const error = new Error(`Production myDATA preflight failed: ${summary}`);
      error.status = 503;
      throw error;
    }
  }
}

module.exports = { assertProductionTransmissionEnabled };

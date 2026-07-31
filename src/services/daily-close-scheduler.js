'use strict';

const { listCompanies } = require('../repositories/companies');
const { getRun } = require('../repositories/daily-close');
const { executeDailyClose } = require('./daily-close-service');
const { testCompanyMyDataConnection, testConfiguredGuestyConnection } = require('./connection-service');
const { runGuestyReconciliation } = require('./guesty-reconciliation-service');

function localParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function previousDate(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function scheduledBusinessDate(now, timeZone, closeTime) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(closeTime)) throw new Error('DAILY_CLOSE_TIME must use HH:mm');
  const parts = localParts(now, timeZone);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const [hour, minute] = closeTime.split(':').map(Number);
  return currentMinutes >= hour * 60 + minute ? date : previousDate(date);
}

async function runScheduledDailyClose({
  now = new Date(),
  timeZone = process.env.DAILY_CLOSE_TIMEZONE || 'Europe/Athens',
  closeTime = process.env.DAILY_CLOSE_TIME || '23:55',
  executor = executeDailyClose,
  runLookup = getRun,
  guestyConnectionTest = testConfiguredGuestyConnection,
  myDataConnectionTest = testCompanyMyDataConnection,
  reconciler = runGuestyReconciliation,
} = {}) {
  const businessDate = scheduledBusinessDate(now, timeZone, closeTime);
  const companies = (await listCompanies()).filter((company) => company.active);
  const results = [];
  if (companies.length && process.env.GUESTY_CLIENT_ID && process.env.GUESTY_CLIENT_SECRET) {
    try { await reconciler(); } catch (error) {
      return companies.map((company) => ({ companyId: company.id, businessDate, skipped: true, status: 'error', error: `Guesty reconciliation failed: ${error.message}` }));
    }
  }
  let guestyChecked = false;
  for (const company of companies) {
    const existing = await runLookup(company.id, businessDate);
    if (existing?.status === 'completed') {
      results.push({ companyId: company.id, businessDate, skipped: true, status: 'completed' });
      continue;
    }
    try {
      if (process.env.MYDATA_ENV === 'production' && process.env.SCHEDULED_CONNECTION_PREFLIGHT !== 'false') {
        if (!guestyChecked) { await guestyConnectionTest(); guestyChecked = true; }
        await myDataConnectionTest(company.id);
      }
      const run = await executor({ companyId: company.id, businessDate });
      results.push({ companyId: company.id, businessDate, skipped: false, status: run.status });
    } catch (error) {
      results.push({ companyId: company.id, businessDate, skipped: false, status: 'error', error: error.message });
    }
  }
  return results;
}

function startDailyCloseScheduler() {
  if (process.env.DAILY_CLOSE_ENABLED !== 'true') return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await runScheduledDailyClose();
      console.log('🌙 Αυτόματο ημερήσιο κλείσιμο:', JSON.stringify(results));
    } catch (error) {
      console.error('❌ Scheduler ημερήσιου κλεισίματος:', error.message);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, 60000);
  timer.unref();
  return timer;
}

module.exports = { scheduledBusinessDate, runScheduledDailyClose, startDailyCloseScheduler };

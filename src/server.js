'use strict';

require('dotenv').config();
const express = require('express');
const { db, initSchema } = require('./database');
const guestyWebhook = require('./guesty-webhook');
const companiesRoutes = require('./routes/companies');
const listingsRoutes = require('./routes/listings');
const invoicesRoutes = require('./routes/invoices');
const dailyCloseRoutes = require('./routes/daily-close');
const fiscalDocumentsRoutes = require('./routes/fiscal-documents');
const billingRulesRoutes = require('./routes/billing-rules');
const connectionsRoutes = require('./routes/connections');
const reservationsRoutes = require('./routes/reservations');
const financialProfilesRoutes = require('./routes/financial-profiles');
const sandboxSignoffsRoutes = require('./routes/sandbox-signoffs');
const { adminAuth } = require('./middleware/admin-auth');
const { startDailyCloseScheduler } = require('./services/daily-close-scheduler');
const { validateRuntimeConfig } = require('./config/runtime');

const app = express();
const PORT = process.env.PORT || 3001;
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'",
  });
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

// -------------------------------------------------------------------
// Raw body capture — απαραίτητο για HMAC signature validation
// Το κάνουμε μέσω verify hook ώστε να μη σπάει τα υπόλοιπα JSON routes.
// -------------------------------------------------------------------
function captureRawBody(req, _res, buf) {
  if (buf && buf.length) {
    req.rawBody = buf.toString('utf8');
  }
}

app.use(express.json({ limit: '256kb', verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: '64kb', verify: captureRawBody }));
app.get('/admin', (_req, res) => res.sendFile(require('path').join(__dirname, '..', 'public', 'admin.html')));
app.use('/admin', express.static(require('path').join(__dirname, '..', 'public')));

// -------------------------------------------------------------------
// Health check
// -------------------------------------------------------------------
function liveHealth(_req, res) {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
}
async function readyHealth(_req, res, database = db) {
  try {
    await database.raw('select 1 as ok');
    res.json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (_error) {
    res.status(503).json({ status: 'not_ready', timestamp: new Date().toISOString() });
  }
}

app.get('/health/live', liveHealth);
app.get('/health/ready', readyHealth);
app.get('/health', async (_req, res) => {
  try {
    await db.raw('select 1 as ok');
    res.json({ status: 'ok', env: process.env.MYDATA_ENV || 'sandbox', timestamp: new Date().toISOString() });
  } catch (_error) {
    res.status(503).json({ status: 'not_ready', env: process.env.MYDATA_ENV || 'sandbox', timestamp: new Date().toISOString() });
  }
});

// -------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------
// Guesty authenticates with its own Svix/HMAC signature and must remain outside
// the admin bearer middleware.
app.use('/api', guestyWebhook);
app.use('/api', adminAuth, companiesRoutes);
app.use('/api', adminAuth, listingsRoutes);
app.use('/api', adminAuth, invoicesRoutes);
app.use('/api', adminAuth, dailyCloseRoutes);
app.use('/api', adminAuth, fiscalDocumentsRoutes);
app.use('/api', adminAuth, billingRulesRoutes);
app.use('/api', adminAuth, connectionsRoutes);
app.use('/api', adminAuth, reservationsRoutes);
app.use('/api', adminAuth, financialProfilesRoutes);
app.use('/api', adminAuth, sandboxSignoffsRoutes);

// -------------------------------------------------------------------
// Global error handler
// -------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error('🔥 Unhandled error:', err.stack);
  const status = err.status || 500;
  const publicMessage = status < 500 ? err.message : 'Internal Server Error';
  const body = { error: publicMessage };
  if (status < 500 || process.env.NODE_ENV !== 'production') body.detail = err.message;
  res.status(status).json(body);
});

// -------------------------------------------------------------------
// Startup
// -------------------------------------------------------------------
function createShutdown({ server, scheduler, database = db, timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000) }) {
  let shuttingDown = false;
  return async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`🛑 ${signal}: graceful shutdown`);
    if (scheduler) clearInterval(scheduler);
    const forceTimer = setTimeout(() => {
      console.error('💥 Graceful shutdown timed out');
      process.exit(1);
    }, timeoutMs);
    forceTimer.unref();
    try {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await database.destroy();
      clearTimeout(forceTimer);
      process.exitCode = 0;
    } catch (error) {
      clearTimeout(forceTimer);
      console.error('💥 Shutdown failed:', error.message);
      process.exitCode = 1;
    }
  };
}

async function start() {
  try {
    validateRuntimeConfig();
    await initSchema();
    console.log('✅ Database schema έτοιμο');
    const scheduler = startDailyCloseScheduler();

    const server = app.listen(PORT, () => {
      console.log(`🚀 Guesty→myDATA Bridge εκτελείται στο http://localhost:${PORT}`);
      console.log(`   Περιβάλλον myDATA: ${process.env.MYDATA_ENV || 'sandbox'}`);
      console.log(`   Webhook endpoint: POST http://localhost:${PORT}/api/webhook/guesty-reservation`);
    });
    const shutdown = createShutdown({ server, scheduler });
    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.once('SIGINT', () => { void shutdown('SIGINT'); });
    return { server, scheduler, shutdown };
  } catch (err) {
    console.error('💥 Αποτυχία εκκίνησης:', err.message);
    process.exit(1);
  }
}

if (require.main === module) void start();

module.exports = { app, start, liveHealth, readyHealth, createShutdown };

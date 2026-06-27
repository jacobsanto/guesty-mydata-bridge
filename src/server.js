'use strict';

require('dotenv').config();
const express = require('express');
const { initSchema } = require('./database');
const guestyWebhook = require('./guesty-webhook');
const companiesRoutes = require('./routes/companies');

const app = express();
const PORT = process.env.PORT || 3001;

// -------------------------------------------------------------------
// Raw body capture — απαραίτητο για HMAC signature validation
// Το κάνουμε μέσω verify hook ώστε να μη σπάει τα υπόλοιπα JSON routes.
// -------------------------------------------------------------------
function captureRawBody(req, _res, buf) {
  if (buf && buf.length) {
    req.rawBody = buf.toString('utf8');
  }
}

app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, verify: captureRawBody }));

// -------------------------------------------------------------------
// Health check
// -------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.MYDATA_ENV || 'sandbox',
    timestamp: new Date().toISOString(),
  });
});

// -------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------
app.use('/api', companiesRoutes);
app.use('/api', guestyWebhook);

// -------------------------------------------------------------------
// Global error handler
// -------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error('🔥 Unhandled error:', err.stack);
  res.status(err.status || 500).json({
    error: err.status && err.status < 500 ? err.message : 'Internal Server Error',
    detail: err.message,
  });
});

// -------------------------------------------------------------------
// Startup
// -------------------------------------------------------------------
async function start() {
  try {
    await initSchema();
    console.log('✅ Database schema έτοιμο');

    app.listen(PORT, () => {
      console.log(`🚀 Guesty→myDATA Bridge εκτελείται στο http://localhost:${PORT}`);
      console.log(`   Περιβάλλον myDATA: ${process.env.MYDATA_ENV || 'sandbox'}`);
      console.log(`   Webhook endpoint: POST http://localhost:${PORT}/api/webhook/guesty-reservation`);
    });
  } catch (err) {
    console.error('💥 Αποτυχία εκκίνησης:', err.message);
    process.exit(1);
  }
}

start();

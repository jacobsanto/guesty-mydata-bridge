'use strict';

require('dotenv').config();
const express = require('express');
const { initSchema } = require('./database');
const guestyWebhook = require('./guesty-webhook');

const app = express();
const PORT = process.env.PORT || 3001;

// -------------------------------------------------------------------
// Raw body capture — απαραίτητο για HMAC signature validation
// Πρέπει να ορίζεται ΠΡΙΝ το express.json()
// -------------------------------------------------------------------
app.use((req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
app.use('/api', guestyWebhook);

// -------------------------------------------------------------------
// Global error handler
// -------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error('🔥 Unhandled error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error', detail: err.message });
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

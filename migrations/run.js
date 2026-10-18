'use strict';

require('dotenv').config();
const { initSchema, db } = require('../src/database');

async function run() {
  try {
    await initSchema();
    console.log('✅ Database schema migration completed');
  } finally {
    await db.destroy();
  }
}

run().catch((error) => {
  console.error(`❌ Database migration failed: ${error.message}`);
  process.exitCode = 1;
});

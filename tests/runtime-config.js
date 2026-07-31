'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { databaseConfig, postgresSsl, validateRuntimeConfig } = require('../src/config/runtime');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-'));
const sqlitePath = path.join(tempRoot, 'nested', 'bridge.db');
const sqlite = databaseConfig({ DB_CLIENT: 'better-sqlite3', DB_PATH: sqlitePath });
assert.strictEqual(sqlite.connection.filename, sqlitePath);
assert(fs.existsSync(path.dirname(sqlitePath)), 'SQLite parent directory is created');

const tls = postgresSsl({ DB_SSL: 'verify-full', DB_SSL_CA: 'line1\\nline2' });
assert.deepStrictEqual(tls, { rejectUnauthorized: true, ca: 'line1\nline2' });

const pg = databaseConfig({
  DB_CLIENT: 'pg', DATABASE_URL: 'postgres://user:pass@db/app', DB_SSL: 'verify-full',
  DB_POOL_MIN: '1', DB_POOL_MAX: '4', DB_ACQUIRE_TIMEOUT_MS: '7000',
});
assert.strictEqual(pg.connection.connectionString, 'postgres://user:pass@db/app');
assert.strictEqual(pg.connection.ssl.rejectUnauthorized, true);
assert.strictEqual(pg.pool.max, 4);
assert.strictEqual(pg.acquireConnectionTimeout, 7000);
assert.throws(
  () => databaseConfig({ DB_CLIENT: 'pg', DATABASE_URL: 'postgres://user:pass@db/app', DB_POOL_MAX: '1' }),
  /at least 2/,
);

assert.throws(() => validateRuntimeConfig({ NODE_ENV: 'production', DB_CLIENT: 'better-sqlite3' }), /DB_CLIENT=pg is required/);
assert.throws(() => validateRuntimeConfig({
  NODE_ENV: 'production', DB_CLIENT: 'pg', DATABASE_URL: 'postgres://db/app', DB_SSL: 'false',
  ADMIN_API_TOKEN: 'x'.repeat(32), DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  GUESTY_WEBHOOK_SECRET: 'x', GUESTY_CLIENT_ID: 'x', GUESTY_CLIENT_SECRET: 'x',
}), /Verified PostgreSQL TLS is required/);

assert.strictEqual(validateRuntimeConfig({
  NODE_ENV: 'production', DB_CLIENT: 'pg', DATABASE_URL: 'postgres://db/app', DB_SSL: 'verify-full',
  ADMIN_API_TOKEN: 'x'.repeat(32), DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  GUESTY_WEBHOOK_SECRET: 'x', GUESTY_CLIENT_ID: 'x', GUESTY_CLIENT_SECRET: 'x',
}), true);

assert.throws(() => validateRuntimeConfig({
  NODE_ENV: 'production', DB_CLIENT: 'pg', DATABASE_URL: 'postgres://db/app', DB_SSL: 'verify-full',
  ADMIN_API_TOKEN: 'x'.repeat(32), DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  DATA_ENCRYPTION_KEY_PREVIOUS: Buffer.alloc(32).toString('base64'),
  GUESTY_WEBHOOK_SECRET: 'x', GUESTY_CLIENT_ID: 'x', GUESTY_CLIENT_SECRET: 'x',
}), /must differ/);

assert.throws(() => validateRuntimeConfig({
  NODE_ENV: 'development', MYDATA_ENV: 'production', MYDATA_PRODUCTION_ENABLED: 'true',
}), /NODE_ENV=production is required/);

console.log('✅ Runtime config tests passed');

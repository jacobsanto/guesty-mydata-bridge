'use strict';

const fs = require('fs');
const path = require('path');

function positiveInteger(value, fallback, name) {
  const parsed = Number(value === undefined || value === '' ? fallback : value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, fallback, name) {
  const parsed = Number(value === undefined || value === '' ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function decodePem(value) {
  return value ? String(value).replace(/\\n/g, '\n') : undefined;
}

function postgresSsl(env = process.env) {
  const setting = String(env.DB_SSL || '').trim().toLowerCase();
  if (!setting || ['false', 'disable', 'off', '0'].includes(setting)) return false;
  if (!['true', 'require', 'verify-full', 'on', '1'].includes(setting)) {
    throw new Error('DB_SSL must be true, require, verify-full, or false');
  }
  return {
    rejectUnauthorized: true,
    ...(env.DB_SSL_CA ? { ca: decodePem(env.DB_SSL_CA) } : {}),
  };
}

function databaseConfig(env = process.env) {
  const client = env.DB_CLIENT || 'better-sqlite3';
  if (!['better-sqlite3', 'pg'].includes(client)) throw new Error('DB_CLIENT must be pg or better-sqlite3');

  const acquireConnectionTimeout = positiveInteger(env.DB_ACQUIRE_TIMEOUT_MS, 10000, 'DB_ACQUIRE_TIMEOUT_MS');
  if (client === 'pg') {
    const connection = env.DATABASE_URL
      ? { connectionString: env.DATABASE_URL }
      : {
          host: env.DB_HOST || 'localhost',
          port: positiveInteger(env.DB_PORT, 5432, 'DB_PORT'),
          database: env.DB_NAME || 'guesty_mydata',
          user: env.DB_USER,
          password: env.DB_PASSWORD,
    };
    const ssl = postgresSsl(env);
    if (ssl) connection.ssl = ssl;
    const poolMax = positiveInteger(env.DB_POOL_MAX, 10, 'DB_POOL_MAX');
    if (poolMax < 2) {
      throw new Error('DB_POOL_MAX must be at least 2 for PostgreSQL schema migration locking');
    }
    return {
      client,
      connection,
      acquireConnectionTimeout,
      pool: {
        min: nonNegativeInteger(env.DB_POOL_MIN, 0, 'DB_POOL_MIN'),
        max: poolMax,
        acquireTimeoutMillis: acquireConnectionTimeout,
        createTimeoutMillis: positiveInteger(env.DB_CONNECT_TIMEOUT_MS, 10000, 'DB_CONNECT_TIMEOUT_MS'),
        idleTimeoutMillis: positiveInteger(env.DB_IDLE_TIMEOUT_MS, 30000, 'DB_IDLE_TIMEOUT_MS'),
      },
    };
  }

  const filename = path.resolve(env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'bridge.db'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  return {
    client,
    connection: { filename },
    useNullAsDefault: true,
    acquireConnectionTimeout,
    pool: { min: 1, max: 1 },
  };
}

function validateRuntimeConfig(env = process.env) {
  const errors = [];
  const required = (name) => {
    if (!String(env[name] || '').trim()) errors.push(`${name} is required`);
  };

  try { positiveInteger(env.PORT, 3001, 'PORT'); } catch (error) { errors.push(error.message); }
  try { positiveInteger(env.SHUTDOWN_TIMEOUT_MS, 10000, 'SHUTDOWN_TIMEOUT_MS'); } catch (error) { errors.push(error.message); }
  try {
    const leaseSeconds = positiveInteger(env.DAILY_CLOSE_LEASE_SECONDS, 300, 'DAILY_CLOSE_LEASE_SECONDS');
    if (leaseSeconds < 30 || leaseSeconds > 3600) errors.push('DAILY_CLOSE_LEASE_SECONDS must be 30-3600');
  } catch (error) { errors.push(error.message); }
  if (!['sandbox', 'production'].includes(env.MYDATA_ENV || 'sandbox')) errors.push('MYDATA_ENV must be sandbox or production');

  if (env.DAILY_CLOSE_ENABLED === 'true') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(env.DAILY_CLOSE_TIME || '23:55')) errors.push('DAILY_CLOSE_TIME must use HH:mm');
    try { new Intl.DateTimeFormat('en', { timeZone: env.DAILY_CLOSE_TIMEZONE || 'Europe/Athens' }); } catch { errors.push('DAILY_CLOSE_TIMEZONE must be a valid IANA time zone'); }
  }

  try {
    const config = databaseConfig({ ...env, DB_PATH: env.DB_PATH || path.join(process.cwd(), 'data', 'bridge.db') });
    if (config.client === 'pg' && config.pool.min > config.pool.max) errors.push('DB_POOL_MIN cannot exceed DB_POOL_MAX');
  } catch (error) {
    errors.push(error.message);
  }

  if (env.NODE_ENV === 'production') {
    for (const name of [
      'ADMIN_API_TOKEN', 'POLICY_ACCOUNTING_APPROVER_TOKEN', 'POLICY_ACCOUNTING_ACTOR',
      'POLICY_TECHNICAL_APPROVER_TOKEN', 'POLICY_TECHNICAL_ACTOR', 'DATA_ENCRYPTION_KEY',
      'GUESTY_WEBHOOK_SECRET', 'GUESTY_CLIENT_ID', 'GUESTY_CLIENT_SECRET', 'GUESTY_ACCOUNT_ID',
    ]) required(name);
    if ((env.DB_CLIENT || 'better-sqlite3') !== 'pg') errors.push('DB_CLIENT=pg is required in production');
    if (!env.DATABASE_URL) {
      for (const name of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) required(name);
    }
    if (!postgresSsl(env) && env.DB_PRIVATE_NETWORK !== 'true') {
      errors.push('Verified PostgreSQL TLS is required in production; set DB_SSL=true or explicitly declare DB_PRIVATE_NETWORK=true');
    }
    const key = Buffer.from(env.DATA_ENCRYPTION_KEY || '', 'base64');
    if (key.length !== 32) errors.push('DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    if (env.DATA_ENCRYPTION_KEY_PREVIOUS) {
      const previousKey = Buffer.from(env.DATA_ENCRYPTION_KEY_PREVIOUS, 'base64');
      if (previousKey.length !== 32) errors.push('DATA_ENCRYPTION_KEY_PREVIOUS must be a base64-encoded 32-byte key');
      if (previousKey.length === 32 && key.length === 32 && previousKey.equals(key)) errors.push('DATA_ENCRYPTION_KEY_PREVIOUS must differ from DATA_ENCRYPTION_KEY');
    }
    if (String(env.ADMIN_API_TOKEN || '').length < 32) errors.push('ADMIN_API_TOKEN must contain at least 32 characters in production');
    for (const name of ['POLICY_ACCOUNTING_APPROVER_TOKEN', 'POLICY_TECHNICAL_APPROVER_TOKEN']) {
      if (String(env[name] || '').length < 32) errors.push(`${name} must contain at least 32 characters in production`);
    }
    const approvalTokens = [env.ADMIN_API_TOKEN, env.POLICY_ACCOUNTING_APPROVER_TOKEN, env.POLICY_TECHNICAL_APPROVER_TOKEN].filter(Boolean);
    if (new Set(approvalTokens).size !== approvalTokens.length) errors.push('ADMIN and policy approver tokens must be distinct in production');
    if (env.ALLOW_INSECURE_DEV === 'true') errors.push('ALLOW_INSECURE_DEV must not be enabled in production');
  }

  if (env.MYDATA_ENV === 'production') {
    if (env.NODE_ENV !== 'production') errors.push('NODE_ENV=production is required when MYDATA_ENV=production');
    if (env.MYDATA_PRODUCTION_ENABLED !== 'true') errors.push('MYDATA_PRODUCTION_ENABLED=true is required when MYDATA_ENV=production');
  }

  if (errors.length) throw new Error(`Invalid runtime configuration:\n- ${[...new Set(errors)].join('\n- ')}`);
  return true;
}

module.exports = { databaseConfig, postgresSsl, validateRuntimeConfig };

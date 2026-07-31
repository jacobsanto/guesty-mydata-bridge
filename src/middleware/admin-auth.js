'use strict';

const crypto = require('crypto');

function adminAuth(req, res, next) {
  const configuredToken = process.env.ADMIN_API_TOKEN;
  if (!configuredToken) {
    const explicitlyInsecureDevelopment = process.env.NODE_ENV !== 'production'
      && process.env.ALLOW_INSECURE_DEV === 'true';
    if (explicitlyInsecureDevelopment) return next();
    return res.status(503).json({ error: 'Admin API is not configured' });
  }

  const authorization = req.get('authorization') || '';
  const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expected = Buffer.from(configuredToken);
  const actual = Buffer.from(suppliedToken);

  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

module.exports = { adminAuth };

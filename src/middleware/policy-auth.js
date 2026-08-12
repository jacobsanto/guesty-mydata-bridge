'use strict';

const crypto = require('crypto');

function bearerToken(req) {
  const authorization = req.get('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function equalToken(actualValue, expectedValue) {
  if (!expectedValue) return false;
  const actual = Buffer.from(String(actualValue));
  const expected = Buffer.from(String(expectedValue));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function configuredRole(tokenName, actorName, role, defaultActor = '') {
  const token = process.env[tokenName];
  const actor = String(process.env[actorName] || defaultActor).trim();
  return token && actor ? { role, token, actor } : null;
}

// Policy routes deliberately use narrower credentials than the global admin
// middleware.  An accounting or technical approval credential cannot read or
// modify any other administrative endpoint.
function policyAuth(req, res, next) {
  const supplied = bearerToken(req);
  const candidates = [
    configuredRole('ADMIN_API_TOKEN', 'POLICY_ADMIN_ACTOR', 'admin', 'admin-api'),
    configuredRole('POLICY_ACCOUNTING_APPROVER_TOKEN', 'POLICY_ACCOUNTING_ACTOR', 'accounting'),
    configuredRole('POLICY_TECHNICAL_APPROVER_TOKEN', 'POLICY_TECHNICAL_ACTOR', 'technical'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (equalToken(supplied, candidate.token)) {
      req.policyActor = { role: candidate.role, actorId: candidate.actor };
      return next();
    }
  }

  const explicitlyInsecureDevelopment = process.env.NODE_ENV !== 'production'
    && process.env.ALLOW_INSECURE_DEV === 'true'
    && candidates.length === 0;
  if (explicitlyInsecureDevelopment) {
    req.policyActor = { role: 'admin', actorId: 'explicit-insecure-development' };
    return next();
  }
  return res.status(candidates.length ? 401 : 503).json({ error: candidates.length ? 'Unauthorized' : 'Policy approval credentials are not configured' });
}

function requirePolicyRole(...roles) {
  return (req, res, next) => {
    if (!req.policyActor || !roles.includes(req.policyActor.role)) return res.status(403).json({ error: 'Insufficient policy approval role' });
    return next();
  };
}

module.exports = { policyAuth, requirePolicyRole };

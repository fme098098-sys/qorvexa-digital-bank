'use strict';
/**
 * Synchronizer-token CSRF protection. A per-session random token is exposed to
 * views as `csrfToken` and must be echoed back on every state-changing request
 * (hidden field `_csrf` or header `X-CSRF-Token`).
 */
const crypto = require('crypto');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function csrfProtection(req, res, next) {
  const token = ensureToken(req);
  res.locals.csrfToken = token;
  if (SAFE.has(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error('Your session form token is invalid or expired. Please reload the page and try again.');
    err.status = 403;
    err.expose = true;
    err.code = 'EBADCSRFTOKEN';
    return next(err);
  }
  return next();
}

module.exports = { csrfProtection, ensureToken };

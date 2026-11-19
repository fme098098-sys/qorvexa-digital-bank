'use strict';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v || ''));
/** Wrap async route handlers so rejections reach the error handler. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const notFound = () => { const e = new Error('Not found'); e.status = 404; e.expose = true; return e; };
const pageNum = (v) => Math.max(1, Math.min(10000, parseInt(v, 10) || 1));
module.exports = { isUuid, ah, notFound, pageNum };

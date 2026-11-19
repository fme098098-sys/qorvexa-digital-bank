'use strict';
const rateLimit = require('express-rate-limit');
const config = require('../config');

const handler = (req, res) => {
  res.status(429);
  if (req.accepts('html')) {
    return res.render('errors/error', { title: 'Too many requests', status: 429, message: 'Too many requests. Please wait a few minutes and try again.', layout: 'layouts/public' });
  }
  return res.json({ error: 'Too many requests' });
};

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.rateLimit.authMax, standardHeaders: 'draft-7', legacyHeaders: false, handler });
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.rateLimit.generalMax, standardHeaders: 'draft-7', legacyHeaders: false, handler });
const sensitiveLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.isTest ? 10000 : 20, standardHeaders: 'draft-7', legacyHeaders: false, handler });

module.exports = { authLimiter, generalLimiter, sensitiveLimiter };

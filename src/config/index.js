'use strict';
require('dotenv').config({ quiet: true });

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';
const isTest = env === 'test';

function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

const sessionSecret = process.env.SESSION_SECRET || (isProd ? null : 'dev-only-insecure-secret-change-me');
if (!sessionSecret) {
  throw new Error('SESSION_SECRET must be set in production');
}

module.exports = {
  env,
  isProd,
  isTest,
  port: int('PORT', 3000),
  baseUrl: process.env.APP_BASE_URL || `http://localhost:${int('PORT', 3000)}`,
  databaseUrl: isTest
    ? (process.env.TEST_DATABASE_URL || 'postgres://qorvexa:qorvexa_dev_pw@localhost:5432/qorvexa_test')
    : (process.env.DATABASE_URL || 'postgres://qorvexa:qorvexa_dev_pw@localhost:5432/qorvexa'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  sessionSecret,
  sessionTtlMinutes: int('SESSION_TTL_MINUTES', 30),
  rememberMeDays: int('REMEMBER_ME_DAYS', 14),
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
  trustProxy: int('TRUST_PROXY', isProd ? 1 : 0),
  bcryptRounds: isTest ? 4 : int('BCRYPT_ROUNDS', 12),
  rateLimit: {
    authMax: isTest ? 1000 : int('RATE_LIMIT_AUTH_MAX', 20),
    generalMax: isTest ? 100000 : int('RATE_LIMIT_GENERAL_MAX', 600),
  },
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || 'Qorvexa Digital Bank <no-reply@localhost>',
  brand: {
    name: 'QORVEXA DIGITAL BANK',
    short: 'Qorvexa',
    supportEmail: 'support@qorvexa.example',
    supportPhone: '+1 (555) 010-2040',
    address: '100 Example Avenue, Suite 400, Springfield (fictional address)',
    disclaimer: 'Educational software project — all balances and transactions are simulated. Qorvexa is not a real bank and holds no real money.',
  },
};

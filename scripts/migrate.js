#!/usr/bin/env node
'use strict';
/**
 * Applies SQL files in db/migrations in filename order, tracking them in
 * schema_migrations. Safe to run repeatedly. Usage:
 *   npm run migrate                   apply pending migrations
 *   node scripts/migrate.js --reset   DROP everything and re-apply (dev only!)
 */
const { pool } = require('../src/db/pool');
const config = require('../src/config');
const { migrate } = require('../src/db/migrator');

module.exports = { migrate: (opts = {}) => migrate({ allowReset: !config.isProd, ...opts }) };

if (require.main === module) {
  migrate({ reset: process.argv.includes('--reset'), allowReset: !config.isProd })
    .then(() => pool.end())
    .catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
}

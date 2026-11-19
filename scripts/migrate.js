#!/usr/bin/env node
'use strict';
/**
 * Applies SQL files in db/migrations in filename order, tracking them in
 * schema_migrations. Usage:
 *   npm run migrate            apply pending migrations
 *   node scripts/migrate.js --reset   DROP everything and re-apply (dev only!)
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db/pool');
const config = require('../src/config');

async function migrate({ reset = false, quiet = false } = {}) {
  const client = await pool.connect();
  const log = (...a) => { if (!quiet) console.log(...a); };
  try {
    if (reset) {
      if (config.isProd) throw new Error('Refusing to reset a production database');
      log('Resetting schema "public"...');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      log(`Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${e.message}`);
      }
    }
    log('Migrations up to date.');
  } finally {
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate({ reset: process.argv.includes('--reset') })
    .then(() => pool.end())
    .catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
}

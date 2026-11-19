'use strict';
/**
 * Idempotent SQL migration runner shared by `npm run migrate` and server boot.
 * Applies db/migrations/*.sql in filename order, records each in
 * schema_migrations, and holds a Postgres advisory lock so two instances
 * booting at the same time cannot apply the same migration twice.
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');
const LOCK_KEY = 4815162342; // arbitrary app-wide advisory lock id
const REQUIRED_TABLES = ['users', 'accounts', 'transactions', 'admin_users', 'audit_logs', 'system_settings', 'session'];

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

async function appliedMigrations(client) {
  const { rows: [t] } = await client.query("SELECT to_regclass('public.schema_migrations') AS t");
  if (!t.t) return new Set();
  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

/** Returns { pending: [...files], missingTables: [...] } without changing anything. */
async function schemaStatus() {
  const client = await pool.connect();
  try {
    const applied = await appliedMigrations(client);
    const pending = migrationFiles().filter((f) => !applied.has(f));
    const { rows } = await client.query(
      'SELECT t FROM unnest($1::text[]) AS t WHERE to_regclass(\'public.\' || quote_ident(t)) IS NULL', [REQUIRED_TABLES]);
    return { pending, missingTables: rows.map((r) => r.t) };
  } finally {
    client.release();
  }
}

async function migrate({ reset = false, quiet = false, allowReset = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    if (reset) {
      if (!allowReset) throw new Error('Refusing to reset a production database');
      log('Resetting schema "public"...');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const applied = await appliedMigrations(client);
    const done = [];
    for (const file of migrationFiles()) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      log(`Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        done.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${e.message}`);
      }
    }
    log(done.length ? `Applied ${done.length} migration(s).` : 'Migrations up to date.');
    return done;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* connection may be gone */ }
    client.release();
  }
}

module.exports = { migrate, schemaStatus, migrationFiles, REQUIRED_TABLES };

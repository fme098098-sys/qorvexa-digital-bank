'use strict';
const { Pool, types } = require('pg');
const config = require('../config');

// Return BIGINT (int8) values as JS numbers. All money values are cents and stay
// far below Number.MAX_SAFE_INTEGER in this application.
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 15,
});

pool.on('error', (err) => {
  console.error('[db] unexpected idle client error', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run fn inside a transaction. fn receives a dedicated client.
 * Rolls back on any thrown error.
 */
async function withTransaction(fn, { isolation } = {}) {
  const client = await pool.connect();
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };

'use strict';
const db = require('../db/pool');
const audit = require('./auditService');
const { AppError } = require('../utils/errors');

const NUMERIC_KEYS = ['max_single_transfer_cents', 'daily_transfer_limit_cents', 'daily_withdrawal_limit_cents', 'max_deposit_request_cents'];
const BOOL_KEYS = ['registration_open'];
const TEXT_KEYS = ['maintenance_banner'];

async function getAll() {
  const { rows } = await db.query('SELECT s.*, a.full_name AS updated_by_name FROM system_settings s LEFT JOIN admin_users a ON a.id = s.updated_by ORDER BY key');
  return rows;
}

async function getMap(client) {
  const { rows } = await (client || db).query('SELECT key, value FROM system_settings');
  const map = {};
  for (const r of rows) {
    if (NUMERIC_KEYS.includes(r.key)) map[r.key] = parseInt(r.value, 10);
    else if (BOOL_KEYS.includes(r.key)) map[r.key] = r.value === 'true';
    else map[r.key] = r.value;
  }
  return map;
}

/** changes: {key: stringValue}. Validated, persisted and audit-logged. */
async function update(admin, changes, req) {
  return db.withTransaction(async (client) => {
    const current = await getMap(client);
    const applied = {};
    for (const [key, raw] of Object.entries(changes)) {
      let value;
      if (NUMERIC_KEYS.includes(key)) {
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 100 || n > 100000000000) throw new AppError(`Invalid value for ${key}.`);
        value = String(n);
      } else if (BOOL_KEYS.includes(key)) {
        value = raw === true || raw === 'true' || raw === 'on' ? 'true' : 'false';
      } else if (TEXT_KEYS.includes(key)) {
        value = String(raw || '').trim().slice(0, 240);
      } else {
        continue; // unknown keys are ignored
      }
      if (String(current[key]) === value) continue;
      await client.query('UPDATE system_settings SET value = $1, updated_by = $2, updated_at = now() WHERE key = $3', [value, admin.id, key]);
      applied[key] = { from: String(current[key]), to: value };
    }
    if (Object.keys(applied).length) {
      await audit.log({ actorType: 'admin', actorId: admin.id, actorLabel: admin.username, action: 'settings.update', entityType: 'system_settings', details: applied, req }, client);
    }
    return applied;
  });
}

module.exports = { getAll, getMap, update, NUMERIC_KEYS, BOOL_KEYS, TEXT_KEYS };

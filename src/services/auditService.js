'use strict';
const db = require('../db/pool');

function reqMeta(req) {
  if (!req) return { ip: null, ua: null };
  return { ip: req.ip || null, ua: (req.get && req.get('user-agent') || '').slice(0, 255) || null };
}

/**
 * Append an entry to the immutable audit log.
 * @param {object} entry {actorType, actorId, actorLabel, action, entityType, entityId, details, req}
 * @param {object} [client] optional transaction client so the log commits atomically with the action
 */
async function log(entry, client) {
  const { ip, ua } = reqMeta(entry.req);
  const q = client || db;
  await q.query(
    `INSERT INTO audit_logs (actor_type, actor_id, actor_label, action, entity_type, entity_id, details, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entry.actorType, entry.actorId || null, entry.actorLabel || null, entry.action,
      entry.entityType || null, entry.entityId ? String(entry.entityId) : null,
      JSON.stringify(entry.details || {}), ip, ua]
  );
}

async function list({ actorType, q, page = 1, perPage = 50 } = {}) {
  const where = [];
  const params = [];
  if (actorType) { params.push(actorType); where.push(`actor_type = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(action ILIKE $${params.length} OR actor_label ILIKE $${params.length} OR entity_id ILIKE $${params.length} OR details::text ILIKE $${params.length})`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const count = await db.query(`SELECT count(*)::int AS n FROM audit_logs ${w}`, params);
  params.push(perPage, (page - 1) * perPage);
  const { rows } = await db.query(
    `SELECT * FROM audit_logs ${w} ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total: count.rows[0].n, page, perPage };
}

module.exports = { log, list };

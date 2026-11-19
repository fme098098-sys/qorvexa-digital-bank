'use strict';
const db = require('../db/pool');

async function create(userId, { category = 'info', title, body, link = null }, client) {
  const q = client || db;
  await q.query(
    'INSERT INTO notifications (user_id, category, title, body, link) VALUES ($1,$2,$3,$4,$5)',
    [userId, category, title, body, link]
  );
}

async function list(userId, { unreadOnly = false, limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM notifications WHERE user_id = $1 ${unreadOnly ? 'AND is_read = FALSE' : ''}
     ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
  return rows;
}

async function unreadCount(userId) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = FALSE', [userId]);
  return rows[0].n;
}

async function markRead(userId, id) {
  const { rowCount } = await db.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [id, userId]);
  return rowCount;
}

async function markAllRead(userId) {
  const { rowCount } = await db.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE', [userId]);
  return rowCount;
}

async function remove(userId, id) {
  const { rowCount } = await db.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [id, userId]);
  return rowCount;
}

module.exports = { create, list, unreadCount, markRead, markAllRead, remove };

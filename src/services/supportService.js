'use strict';
const db = require('../db/pool');
const audit = require('./auditService');
const notifications = require('./notificationService');
const { AppError } = require('../utils/errors');
const { genTicketNumber } = require('../utils/ids');

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const CATEGORIES = ['general', 'account', 'transfer', 'deposit', 'technical', 'other'];

async function create({ user, name, email, subject, category, message, req }) {
  const { rows } = await db.query(
    `INSERT INTO support_tickets (ticket_number, user_id, name, email, subject, category, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [genTicketNumber(), user ? user.id : null, user ? user.full_name : name, user ? user.email : email,
      subject, CATEGORIES.includes(category) ? category : 'general', message]);
  await audit.log({ actorType: user ? 'user' : 'guest', actorId: user ? user.id : null, actorLabel: user ? user.username : String(email).slice(0, 140), action: 'support.create', entityType: 'support_ticket', entityId: rows[0].ticket_number, req });
  return rows[0];
}

async function listForUser(userId) {
  const { rows } = await db.query('SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return rows;
}

async function list({ status, q, page = 1, perPage = 25 } = {}) {
  const where = [];
  const params = [];
  if (status && STATUSES.includes(status)) { params.push(status); where.push(`t.status = $${params.length}`); }
  if (q) { params.push(`%${q}%`); const i = params.length; where.push(`(t.ticket_number ILIKE $${i} OR t.subject ILIKE $${i} OR t.email ILIKE $${i} OR t.name ILIKE $${i})`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await db.query(`SELECT count(*)::int AS n FROM support_tickets t ${w}`, params)).rows[0].n;
  params.push(perPage, (page - 1) * perPage);
  const { rows } = await db.query(
    `SELECT t.*, a.username AS assigned_username FROM support_tickets t LEFT JOIN admin_users a ON a.id = t.assigned_admin ${w}
      ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, t.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total, page, perPage };
}

async function get(id) {
  const { rows } = await db.query('SELECT t.*, a.username AS assigned_username FROM support_tickets t LEFT JOIN admin_users a ON a.id = t.assigned_admin WHERE t.id = $1', [id]);
  return rows[0] || null;
}

async function update(id, { status, priority, response }, admin, req) {
  if (status && !STATUSES.includes(status)) throw new AppError('Invalid status.');
  if (priority && !['low', 'normal', 'high'].includes(priority)) throw new AppError('Invalid priority.');
  return db.withTransaction(async (client) => {
    const t = (await client.query('SELECT * FROM support_tickets WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!t) throw new AppError('Ticket not found.', 404);
    const resp = response && response.trim() ? response.trim() : null;
    const updated = (await client.query(
      `UPDATE support_tickets SET status = coalesce($2, status), priority = coalesce($3, priority),
          admin_response = coalesce($4, admin_response), responded_at = CASE WHEN $4::text IS NOT NULL THEN now() ELSE responded_at END,
          assigned_admin = $5, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, status || null, priority || null, resp, admin.id])).rows[0];
    if (t.user_id && (resp || (status && status !== t.status))) {
      await notifications.create(t.user_id, { category: 'support', title: `Support ticket ${t.ticket_number} updated`, body: resp ? `Response: ${resp.slice(0, 200)}` : `Status changed to ${status.replace('_', ' ')}.`, link: '/support' }, client);
    }
    await audit.log({ actorType: 'admin', actorId: admin.id, actorLabel: admin.username, action: 'support.update', entityType: 'support_ticket', entityId: t.ticket_number,
      details: { status: status && status !== t.status ? { from: t.status, to: status } : undefined, priority, responded: Boolean(resp) }, req }, client);
    return updated;
  });
}

module.exports = { STATUSES, CATEGORIES, create, listForUser, list, get, update };

'use strict';
const bcrypt = require('bcryptjs');
const db = require('../db/pool');
const config = require('../config');
const audit = require('./auditService');
const { AppError } = require('../utils/errors');

const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 4);

async function createAdmin({ fullName, email, username, password, role = 'admin' }) {
  const hash = await bcrypt.hash(password, config.bcryptRounds);
  try {
    const { rows } = await db.query(
      `INSERT INTO admin_users (full_name, email, username, password_hash, role) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, full_name, email, username, role, created_at`, [fullName, email.toLowerCase(), username, hash, role]);
    await audit.log({ actorType: 'system', actorLabel: 'cli', action: 'admin.create', entityType: 'admin_user', entityId: rows[0].id, details: { username, role } });
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw new AppError('An administrator with that email or username already exists.', 409);
    throw e;
  }
}

async function authenticate(identifier, password, req) {
  const ident = String(identifier || '').trim().toLowerCase();
  const { rows } = await db.query('SELECT * FROM admin_users WHERE lower(email) = $1 OR lower(username) = $1', [ident]);
  const admin = rows[0];
  const ok = await bcrypt.compare(password || '', admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !ok || !admin.is_active) {
    await audit.log({ actorType: admin ? 'admin' : 'guest', actorId: admin ? admin.id : null, actorLabel: ident.slice(0, 140), action: 'admin.login_failed', req });
    throw new AppError('Invalid administrator credentials.', 401);
  }
  await db.query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [admin.id]);
  await audit.log({ actorType: 'admin', actorId: admin.id, actorLabel: admin.username, action: 'admin.login', req });
  return admin;
}

async function getById(id) {
  const { rows } = await db.query('SELECT id, full_name, email, username, role, is_active, last_login_at FROM admin_users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function overview() {
  const users = (await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
            count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new_7d,
            count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS new_30d
       FROM users`)).rows[0];
  const pending = (await db.query(`SELECT count(*)::int AS n, coalesce(sum(amount_cents),0)::bigint AS amt FROM deposit_requests WHERE status = 'pending'`)).rows[0];
  const tickets = (await db.query(`SELECT count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open FROM support_tickets`)).rows[0];
  const registrations = (await db.query(
    `SELECT to_char(d.day, 'Mon DD') AS label, count(u.id)::int AS n
       FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') AS d(day)
       LEFT JOIN users u ON date_trunc('day', u.created_at) = d.day GROUP BY d.day ORDER BY d.day`)).rows;
  const volume = (await db.query(
    `SELECT to_char(d.day, 'Mon DD') AS label,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.type = 'deposit'),0)::bigint AS deposits,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.type = 'withdrawal'),0)::bigint AS withdrawals,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.type = 'transfer_out'),0)::bigint AS transfers
       FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') AS d(day)
       LEFT JOIN transactions t ON date_trunc('day', t.created_at) = d.day GROUP BY d.day ORDER BY d.day`)).rows;
  const newest = (await db.query(`SELECT u.id, u.full_name, u.email, u.created_at, a.account_number FROM users u LEFT JOIN accounts a ON a.user_id = u.id ORDER BY u.created_at DESC LIMIT 6`)).rows;
  return { users, pending, tickets, registrations, volume, newest };
}

module.exports = { createAdmin, authenticate, getById, overview };

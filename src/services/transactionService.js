'use strict';
/** Read-side queries over the ledger (history, details, dashboard metrics, statements). */
const db = require('../db/pool');

const TYPES = ['deposit', 'withdrawal', 'transfer_in', 'transfer_out'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildFilters({ accountId, q, type, from, to }, params) {
  const where = [];
  if (accountId) { params.push(accountId); where.push(`t.account_id = $${params.length}`); }
  if (q) {
    params.push(`%${String(q).trim()}%`);
    const i = params.length;
    where.push(`(t.reference ILIKE $${i} OR t.description ILIKE $${i} OR t.counterparty_name ILIKE $${i} OR t.user_reference ILIKE $${i} OR t.counterparty_account_number ILIKE $${i})`);
  }
  if (type && TYPES.includes(type)) { params.push(type); where.push(`t.type = $${params.length}`); }
  if (from && DATE_RE.test(from)) { params.push(from); where.push(`t.created_at >= $${params.length}::date`); }
  if (to && DATE_RE.test(to)) { params.push(to); where.push(`t.created_at < ($${params.length}::date + interval '1 day')`); }
  return where.length ? 'WHERE ' + where.join(' AND ') : '';
}

async function list(filters = {}) {
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const perPage = Math.min(100, filters.perPage || 20);
  const params = [];
  const w = buildFilters(filters, params);
  const total = (await db.query(`SELECT count(*)::int AS n FROM transactions t ${w}`, params)).rows[0].n;
  params.push(perPage, (page - 1) * perPage);
  const { rows } = await db.query(
    `SELECT t.*, a.account_number, u.full_name AS owner_name, u.username AS owner_username
       FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN users u ON u.id = a.user_id
       ${w} ORDER BY t.created_at DESC, t.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

/** Get one ledger entry for an account by reference. */
async function getForAccount(accountId, reference) {
  const { rows } = await db.query(
    `SELECT t.*, a.account_number, a.account_type, u.full_name AS owner_name, u.customer_id
       FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN users u ON u.id = a.user_id
      WHERE t.account_id = $1 AND t.reference = $2`, [accountId, reference]);
  return rows[0] || null;
}

async function getByReference(reference) {
  const { rows } = await db.query(
    `SELECT t.*, a.account_number, u.full_name AS owner_name, u.username AS owner_username, u.id AS owner_id, ad.username AS admin_username
       FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN users u ON u.id = a.user_id
       LEFT JOIN admin_users ad ON ad.id = t.initiated_by_admin
      WHERE t.reference = $1 ORDER BY t.direction DESC`, [reference]);
  return rows;
}

async function dashboardStats(accountId) {
  const totals = (await db.query(
    `SELECT coalesce(sum(amount_cents) FILTER (WHERE direction = 'credit'),0)::bigint AS incoming,
            coalesce(sum(amount_cents) FILTER (WHERE direction = 'debit'),0)::bigint AS outgoing,
            coalesce(sum(amount_cents) FILTER (WHERE type = 'transfer_in'),0)::bigint AS transfers_in,
            coalesce(sum(amount_cents) FILTER (WHERE type = 'transfer_out'),0)::bigint AS transfers_out,
            count(*)::int AS tx_count
       FROM transactions WHERE account_id = $1`, [accountId])).rows[0];
  const monthly = (await db.query(
    `SELECT to_char(m.month, 'Mon YYYY') AS label, to_char(m.month, 'YYYY-MM') AS ym,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.direction = 'credit'),0)::bigint AS credits,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.direction = 'debit'),0)::bigint AS debits,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.type = 'transfer_out'),0)::bigint AS transfers_out,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.type = 'withdrawal'),0)::bigint AS withdrawals
       FROM generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') AS m(month)
       LEFT JOIN transactions t ON t.account_id = $1 AND date_trunc('month', t.created_at) = m.month
      GROUP BY m.month ORDER BY m.month`, [accountId])).rows;
  return { totals, monthly };
}

async function statement(accountId, from, to) {
  const opening = (await db.query(
    `SELECT balance_after_cents FROM transactions WHERE account_id = $1 AND created_at < $2::date
      ORDER BY created_at DESC, id DESC LIMIT 1`, [accountId, from])).rows[0];
  const { rows } = await db.query(
    `SELECT * FROM transactions WHERE account_id = $1 AND created_at >= $2::date AND created_at < ($3::date + interval '1 day')
      ORDER BY created_at ASC, direction ASC`, [accountId, from, to]);
  const openingBalance = opening ? opening.balance_after_cents : 0;
  const credits = rows.filter((r) => r.direction === 'credit').reduce((s, r) => s + r.amount_cents, 0);
  const debits = rows.filter((r) => r.direction === 'debit').reduce((s, r) => s + r.amount_cents, 0);
  return { rows, openingBalance, closingBalance: openingBalance + credits - debits, credits, debits };
}

async function systemTotals() {
  const { rows } = await db.query(
    `SELECT (SELECT coalesce(sum(balance_cents),0) FROM accounts)::bigint AS total_funds,
            coalesce(sum(amount_cents) FILTER (WHERE type = 'deposit'),0)::bigint AS total_deposits,
            count(*) FILTER (WHERE type = 'deposit')::int AS deposit_count,
            coalesce(sum(amount_cents) FILTER (WHERE type = 'withdrawal'),0)::bigint AS total_withdrawals,
            count(*) FILTER (WHERE type = 'withdrawal')::int AS withdrawal_count,
            coalesce(sum(amount_cents) FILTER (WHERE type = 'transfer_out'),0)::bigint AS total_transfers,
            count(*) FILTER (WHERE type = 'transfer_out')::int AS transfer_count
       FROM transactions`);
  return rows[0];
}

module.exports = { TYPES, list, getForAccount, getByReference, dashboardStats, statement, systemTotals };

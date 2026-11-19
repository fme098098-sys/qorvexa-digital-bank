'use strict';
/**
 * Ledger service: the ONLY code path that changes account balances.
 * Every balance change is paired with an immutable transactions row, executed in a
 * single database transaction with row-level locks (SELECT ... FOR UPDATE).
 */
const db = require('../db/pool');
const audit = require('./auditService');
const notifications = require('./notificationService');
const settings = require('./settingsService');
const users = require('./userService');
const { AppError } = require('../utils/errors');
const { genReference } = require('../utils/ids');
const { formatUSD } = require('../utils/money');

const IDEM_RE = /^[A-Za-z0-9-]{8,64}$/;

function checkIdem(key) {
  if (key === undefined || key === null || key === '') return null;
  if (!IDEM_RE.test(String(key))) throw new AppError('Invalid request token. Please reload the page and try again.');
  return String(key);
}

async function enableLedgerWrite(client) {
  await client.query(`SELECT set_config('qorvexa.ledger_write', 'on', true)`);
}

async function insertTx(client, t) {
  const { rows } = await client.query(
    `INSERT INTO transactions (reference, account_id, type, direction, amount_cents, balance_after_cents,
        counterparty_account_id, counterparty_name, counterparty_account_number, description, user_reference,
        idempotency_key, deposit_request_id, initiated_by_admin, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, coalesce($15::timestamptz, now())) RETURNING *`,
    [t.reference, t.accountId, t.type, t.direction, t.amountCents, t.balanceAfter,
      t.counterpartyAccountId || null, t.counterpartyName || null, t.counterpartyAccountNumber || null,
      t.description, t.userReference || null, t.idempotencyKey || null, t.depositRequestId || null,
      t.initiatedByAdmin || null, t.at || null]);
  return rows[0];
}

async function sumToday(client, accountId, type) {
  const { rows } = await client.query(
    `SELECT coalesce(sum(amount_cents),0)::bigint AS s FROM transactions
      WHERE account_id = $1 AND type = $2 AND created_at >= date_trunc('day', now())`, [accountId, type]);
  return rows[0].s;
}

async function findExistingByIdem(client, accountId, key) {
  if (!key) return null;
  const { rows } = await client.query('SELECT * FROM transactions WHERE account_id = $1 AND idempotency_key = $2', [accountId, key]);
  return rows[0] || null;
}

/**
 * Internal transfer between two Qorvexa accounts.
 * @returns {{reference, duplicate:boolean, debit, credit}}
 */
async function transfer({ userId, recipient, amountCents, description, userReference, idempotencyKey, expectedRecipientAccountId, req, at }) {
  const idem = checkIdem(idempotencyKey);
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new AppError('Amount must be greater than $0.00.');
  const desc = String(description || '').trim() || 'Transfer';
  const limits = await settings.getMap();
  if (amountCents > limits.max_single_transfer_cents) {
    throw new AppError(`The maximum single transfer is ${formatUSD(limits.max_single_transfer_cents)}.`);
  }

  const run = async (client) => {
    await enableLedgerWrite(client);
    const sender = await users.getPrimaryAccount(userId, client);
    if (!sender) throw new AppError('You do not have an account to send from.', 404);

    const dup = await findExistingByIdem(client, sender.id, idem);
    if (dup) return { reference: dup.reference, duplicate: true, debit: dup };

    const rcpt = await users.findRecipient(recipient, client);
    if (!rcpt) throw new AppError('Recipient account not found. Check the account number or username.', 404, 'RECIPIENT_NOT_FOUND');
    if (expectedRecipientAccountId && rcpt.account_id !== expectedRecipientAccountId) {
      throw new AppError('Recipient details changed. Please review the transfer again.', 409);
    }
    if (rcpt.account_id === sender.id) throw new AppError('You cannot transfer money to your own account.');

    // Lock both rows in a consistent order to avoid deadlocks.
    const ids = [sender.id, rcpt.account_id].sort();
    const locked = (await client.query(
      `SELECT a.*, u.status AS user_status, u.full_name, u.username FROM accounts a JOIN users u ON u.id = a.user_id
        WHERE a.id = ANY($1::uuid[]) ORDER BY a.id FOR UPDATE OF a`, [ids])).rows;
    const s = locked.find((r) => r.id === sender.id);
    const r = locked.find((x) => x.id === rcpt.account_id);

    // Re-check idempotency now that we hold the lock (a concurrent duplicate may have committed).
    const dup2 = await findExistingByIdem(client, sender.id, idem);
    if (dup2) return { reference: dup2.reference, duplicate: true, debit: dup2 };

    if (s.user_status !== 'active' || s.status !== 'active') throw new AppError('Your account is not active. Transfers are disabled.', 403);
    if (r.user_status !== 'active' || r.status !== 'active') throw new AppError('The recipient account cannot receive transfers at this time.', 422);

    const available = s.balance_cents - s.hold_cents;
    if (amountCents > available) {
      throw new AppError(`Insufficient funds. Your available balance is ${formatUSD(available)}.`, 422, 'INSUFFICIENT_FUNDS');
    }
    const today = await sumToday(client, s.id, 'transfer_out');
    if (today + amountCents > limits.daily_transfer_limit_cents) {
      throw new AppError(`This transfer exceeds your daily transfer limit of ${formatUSD(limits.daily_transfer_limit_cents)}.`, 422);
    }

    const reference = genReference('TRF', at);
    const sNew = (await client.query('UPDATE accounts SET balance_cents = balance_cents - $2 WHERE id = $1 RETURNING balance_cents', [s.id, amountCents])).rows[0].balance_cents;
    const rNew = (await client.query('UPDATE accounts SET balance_cents = balance_cents + $2 WHERE id = $1 RETURNING balance_cents', [r.id, amountCents])).rows[0].balance_cents;

    const debit = await insertTx(client, {
      reference, accountId: s.id, type: 'transfer_out', direction: 'debit', amountCents, balanceAfter: sNew,
      counterpartyAccountId: r.id, counterpartyName: r.full_name, counterpartyAccountNumber: r.account_number,
      description: desc, userReference, idempotencyKey: idem, at,
    });
    const credit = await insertTx(client, {
      reference, accountId: r.id, type: 'transfer_in', direction: 'credit', amountCents, balanceAfter: rNew,
      counterpartyAccountId: s.id, counterpartyName: s.full_name, counterpartyAccountNumber: s.account_number,
      description: desc, userReference, at,
    });

    await notifications.create(s.user_id, { category: 'transfer', title: 'Transfer sent', body: `You sent ${formatUSD(amountCents)} to ${r.full_name}. Ref ${reference}.`, link: `/transactions/${reference}` }, client);
    await notifications.create(r.user_id, { category: 'transfer', title: 'Money received', body: `You received ${formatUSD(amountCents)} from ${s.full_name}. Ref ${reference}.`, link: `/transactions/${reference}` }, client);
    await audit.log({ actorType: 'user', actorId: s.user_id, actorLabel: s.username, action: 'transfer.complete', entityType: 'transaction', entityId: reference,
      details: { amount_cents: amountCents, to_account: r.account_number }, req }, client);
    return { reference, duplicate: false, debit, credit };
  };

  try {
    return await db.withTransaction(run);
  } catch (e) {
    // A concurrent request with the same idempotency key won the race.
    if (e.code === '23505' && idem && /idempotency/.test(e.constraint || '')) {
      const acct = await users.getPrimaryAccount(userId);
      const existing = await findExistingByIdem(db, acct.id, idem);
      if (existing) return { reference: existing.reference, duplicate: true, debit: existing };
    }
    if (e.code === '23514') throw new AppError('Insufficient funds.', 422, 'INSUFFICIENT_FUNDS');
    throw e;
  }
}

/** Simulated cash withdrawal (debit). */
async function withdraw({ userId, amountCents, description, idempotencyKey, req, at }) {
  const idem = checkIdem(idempotencyKey);
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new AppError('Amount must be greater than $0.00.');
  const limits = await settings.getMap();
  try {
    return await db.withTransaction(async (client) => {
      await enableLedgerWrite(client);
      const acct = await users.getPrimaryAccount(userId, client);
      if (!acct) throw new AppError('Account not found.', 404);
      const a = (await client.query(
        'SELECT a.*, u.status AS user_status, u.username FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.id = $1 FOR UPDATE OF a', [acct.id])).rows[0];
      const dup = await findExistingByIdem(client, a.id, idem);
      if (dup) return { reference: dup.reference, duplicate: true, tx: dup };
      if (a.user_status !== 'active' || a.status !== 'active') throw new AppError('Your account is not active. Withdrawals are disabled.', 403);
      const available = a.balance_cents - a.hold_cents;
      if (amountCents > available) throw new AppError(`Insufficient funds. Your available balance is ${formatUSD(available)}.`, 422, 'INSUFFICIENT_FUNDS');
      const today = await sumToday(client, a.id, 'withdrawal');
      if (today + amountCents > limits.daily_withdrawal_limit_cents) {
        throw new AppError(`This withdrawal exceeds your daily withdrawal limit of ${formatUSD(limits.daily_withdrawal_limit_cents)}.`, 422);
      }
      const reference = genReference('WDL', at);
      const bal = (await client.query('UPDATE accounts SET balance_cents = balance_cents - $2 WHERE id = $1 RETURNING balance_cents', [a.id, amountCents])).rows[0].balance_cents;
      const tx = await insertTx(client, {
        reference, accountId: a.id, type: 'withdrawal', direction: 'debit', amountCents, balanceAfter: bal,
        description: String(description || '').trim() || 'Simulated withdrawal', idempotencyKey: idem, at,
      });
      await notifications.create(a.user_id, { category: 'withdrawal', title: 'Withdrawal completed', body: `${formatUSD(amountCents)} was withdrawn from your account. Ref ${reference}.`, link: `/transactions/${reference}` }, client);
      await audit.log({ actorType: 'user', actorId: a.user_id, actorLabel: a.username, action: 'withdrawal.complete', entityType: 'transaction', entityId: reference, details: { amount_cents: amountCents }, req }, client);
      return { reference, duplicate: false, tx };
    });
  } catch (e) {
    if (e.code === '23514') throw new AppError('Insufficient funds.', 422, 'INSUFFICIENT_FUNDS');
    throw e;
  }
}

/** Customer submits a simulated deposit request; funds post only after admin approval. */
async function createDepositRequest({ userId, amountCents, method, note, idempotencyKey, req, client: outer, at }) {
  const idem = checkIdem(idempotencyKey);
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new AppError('Amount must be greater than $0.00.');
  if (!['simulated_card', 'simulated_wire', 'simulated_cash'].includes(method)) throw new AppError('Choose a deposit method.');
  const limits = await settings.getMap(outer);
  if (amountCents > limits.max_deposit_request_cents) throw new AppError(`The maximum deposit request is ${formatUSD(limits.max_deposit_request_cents)}.`);
  const run = async (client) => {
    const user = (await client.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    const acct = await users.getPrimaryAccount(userId, client);
    if (!user || !acct) throw new AppError('Account not found.', 404);
    if (idem) {
      const ex = (await client.query('SELECT * FROM deposit_requests WHERE user_id = $1 AND idempotency_key = $2', [userId, idem])).rows[0];
      if (ex) return { request: ex, duplicate: true };
    }
    if (user.status !== 'active' || acct.status !== 'active') throw new AppError('Your account is not active. Deposits are disabled.', 403);
    const reference = genReference('DEP', at);
    const request = (await client.query(
      `INSERT INTO deposit_requests (reference, user_id, account_id, amount_cents, method, note, idempotency_key, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now())) RETURNING *`,
      [reference, userId, acct.id, amountCents, method, note || null, idem, at || null])).rows[0];
    await notifications.create(userId, { category: 'deposit', title: 'Deposit request received', body: `Your simulated deposit request of ${formatUSD(amountCents)} (${reference}) is pending review.`, link: '/deposit' }, client);
    await audit.log({ actorType: 'user', actorId: userId, actorLabel: user.username, action: 'deposit.request', entityType: 'deposit_request', entityId: reference, details: { amount_cents: amountCents, method }, req }, client);
    return { request, duplicate: false };
  };
  try {
    return outer ? await run(outer) : await db.withTransaction(run);
  } catch (e) {
    if (e.code === '23505' && /idem/.test(e.constraint || '')) {
      const ex = (await db.query('SELECT * FROM deposit_requests WHERE user_id = $1 AND idempotency_key = $2', [userId, idem])).rows[0];
      if (ex) return { request: ex, duplicate: true };
    }
    throw e;
  }
}

/**
 * Approve or reject a pending deposit request. Approval posts a ledgered deposit.
 * admin may be null only for the seed script (system actor).
 */
async function reviewDepositRequest({ requestId, decision, note, admin, req, client: outer, at }) {
  if (!['approve', 'reject'].includes(decision)) throw new AppError('Invalid decision.');
  const run = async (client) => {
    await enableLedgerWrite(client);
    const dr = (await client.query('SELECT * FROM deposit_requests WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
    if (!dr) throw new AppError('Deposit request not found.', 404);
    if (dr.status !== 'pending') throw new AppError(`This request has already been ${dr.status}.`, 409);
    const actor = admin
      ? { actorType: 'admin', actorId: admin.id, actorLabel: admin.username }
      : { actorType: 'system', actorLabel: 'seed' };
    if (decision === 'reject') {
      await client.query(`UPDATE deposit_requests SET status = 'rejected', reviewed_by = $2, reviewed_at = coalesce($4::timestamptz, now()), review_note = $3 WHERE id = $1`,
        [dr.id, admin ? admin.id : null, note || null, at || null]);
      await notifications.create(dr.user_id, { category: 'deposit', title: 'Deposit request declined', body: `Your deposit request ${dr.reference} for ${formatUSD(dr.amount_cents)} was declined${note ? `: ${note}` : '.'}`, link: '/deposit' }, client);
      await audit.log({ ...actor, action: 'deposit.reject', entityType: 'deposit_request', entityId: dr.reference, details: { amount_cents: dr.amount_cents, note: note || null }, req }, client);
      return { status: 'rejected', request: dr };
    }
    const acct = (await client.query('SELECT a.*, u.status AS user_status FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.id = $1 FOR UPDATE OF a', [dr.account_id])).rows[0];
    if (acct.user_status !== 'active' || acct.status !== 'active') throw new AppError('The customer account is not active; the deposit cannot be posted.', 409);
    const bal = (await client.query('UPDATE accounts SET balance_cents = balance_cents + $2 WHERE id = $1 RETURNING balance_cents', [acct.id, dr.amount_cents])).rows[0].balance_cents;
    const tx = await insertTx(client, {
      reference: dr.reference, accountId: acct.id, type: 'deposit', direction: 'credit', amountCents: dr.amount_cents, balanceAfter: bal,
      description: `Simulated deposit (${dr.method.replace('simulated_', '')})`, userReference: dr.note ? dr.note.slice(0, 40) : null,
      depositRequestId: dr.id, initiatedByAdmin: admin ? admin.id : null, at,
    });
    await client.query(`UPDATE deposit_requests SET status = 'approved', reviewed_by = $2, reviewed_at = coalesce($5::timestamptz, now()), review_note = $3, transaction_id = $4 WHERE id = $1`,
      [dr.id, admin ? admin.id : null, note || null, tx.id, at || null]);
    await notifications.create(dr.user_id, { category: 'deposit', title: 'Deposit approved', body: `${formatUSD(dr.amount_cents)} has been credited to your account. Ref ${dr.reference}.`, link: `/transactions/${dr.reference}` }, client);
    await audit.log({ ...actor, action: 'deposit.approve', entityType: 'deposit_request', entityId: dr.reference, details: { amount_cents: dr.amount_cents, note: note || null }, req }, client);
    return { status: 'approved', request: dr, tx };
  };
  return outer ? run(outer) : db.withTransaction(run);
}

async function listDepositRequests({ status, userId, page = 1, perPage = 25 } = {}) {
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`d.status = $${params.length}`); }
  if (userId) { params.push(userId); where.push(`d.user_id = $${params.length}`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await db.query(`SELECT count(*)::int AS n FROM deposit_requests d ${w}`, params)).rows[0].n;
  params.push(perPage, (page - 1) * perPage);
  const { rows } = await db.query(
    `SELECT d.*, u.full_name, u.username, a.account_number, ad.username AS reviewer
       FROM deposit_requests d JOIN users u ON u.id = d.user_id JOIN accounts a ON a.id = d.account_id
       LEFT JOIN admin_users ad ON ad.id = d.reviewed_by ${w}
      ORDER BY (d.status = 'pending') DESC, d.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total, page, perPage };
}

module.exports = { transfer, withdraw, createDepositRequest, reviewDepositRequest, listDepositRequests };

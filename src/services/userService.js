'use strict';
const bcrypt = require('bcryptjs');
const db = require('../db/pool');
const config = require('../config');
const audit = require('./auditService');
const notifications = require('./notificationService');
const mail = require('./mailService');
const loginEvents = require('./loginEventService');
const { AppError } = require('../utils/errors');
const { genCustomerId, genAccountNumber, genToken, sha256 } = require('../utils/ids');

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 4);

const hashPassword = (pw) => bcrypt.hash(pw, config.bcryptRounds);

/** Inserts with retries on the (rare) random-ID collision. */
async function insertUnique(client, fn, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    await client.query('SAVEPOINT uniq');
    try {
      const res = await fn();
      await client.query('RELEASE SAVEPOINT uniq');
      return res;
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT uniq');
      const isIdCollision = e.code === '23505' && /(customer_id|account_number)/.test(e.constraint || e.detail || '');
      if (!isIdCollision) throw e;
    }
  }
  throw new Error('Could not allocate a unique identifier');
}

function mapUniqueViolation(e) {
  if (e.code === '23505') {
    if (/email/.test(e.constraint || '')) return new AppError('An account with this email address already exists.', 409);
    if (/username/.test(e.constraint || '')) return new AppError('This username is already taken.', 409);
  }
  return e;
}

/**
 * Create a customer and their primary account (balance starts at $0.00).
 * data: {fullName,email,phone,username,password,country,accountType}
 */
async function createCustomer(data, { createdByAdmin = null, req = null, client: outer = null } = {}) {
  const passwordHash = await hashPassword(data.password);
  const run = async (client) => {
    const user = await insertUnique(client, async () => (await client.query(
      `INSERT INTO users (customer_id, full_name, email, phone, username, password_hash, country, created_by_admin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [genCustomerId(), data.fullName, data.email.toLowerCase(), data.phone, data.username, passwordHash, data.country, createdByAdmin ? createdByAdmin.id : null]
    )).rows[0]);
    const account = await insertUnique(client, async () => (await client.query(
      'INSERT INTO accounts (user_id, account_number, account_type) VALUES ($1,$2,$3) RETURNING *',
      [user.id, genAccountNumber(), data.accountType]
    )).rows[0]);
    await notifications.create(user.id, {
      category: 'account',
      title: 'Welcome to Qorvexa',
      body: `Your ${data.accountType} account ${account.account_number} is open. Remember: this is an educational platform and all funds are simulated.`,
      link: '/dashboard',
    }, client);
    await audit.log(createdByAdmin
      ? { actorType: 'admin', actorId: createdByAdmin.id, actorLabel: createdByAdmin.username, action: 'customer.create', entityType: 'user', entityId: user.id, details: { username: user.username, account_number: account.account_number }, req }
      : { actorType: 'user', actorId: user.id, actorLabel: user.username, action: 'user.register', entityType: 'user', entityId: user.id, details: { account_number: account.account_number }, req }, client);
    return { user, account };
  };
  try {
    return outer ? await run(outer) : await db.withTransaction(run);
  } catch (e) {
    throw mapUniqueViolation(e);
  }
}

async function getById(id) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getPrimaryAccount(userId, client) {
  const { rows } = await (client || db).query(
    'SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1', [userId]);
  return rows[0] || null;
}

/**
 * Verify customer credentials. Returns user on success; throws AppError otherwise.
 * Implements a per-account lockout after repeated failures.
 */
async function authenticate(identifier, password, req) {
  const ident = String(identifier || '').trim().toLowerCase();
  const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = $1 OR lower(username) = $1 LIMIT 1', [ident]);
  const user = rows[0];
  const generic = new AppError('Invalid email/username or password.', 401);
  if (!user) {
    await bcrypt.compare(password || '', DUMMY_HASH); // reduce user-enumeration timing differences
    await audit.log({ actorType: 'guest', actorLabel: ident.slice(0, 140), action: 'auth.login_failed', details: { reason: 'unknown_user' }, req });
    await loginEvents.record({ actorType: 'user', identifier: ident, event: 'login', success: false, failureReason: 'unknown_user', req });
    throw generic;
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await loginEvents.record({ actorType: 'user', userId: user.id, identifier: ident, event: 'login', success: false, failureReason: 'locked', req });
    throw new AppError('Too many failed attempts. Please try again in a few minutes.', 429);
  }
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) {
    const failed = user.failed_logins + 1;
    const lock = failed >= MAX_FAILED;
    await db.query(
      `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + interval '${LOCK_MINUTES} minutes' ELSE locked_until END WHERE id = $1`,
      [user.id, lock ? 0 : failed, lock]);
    await audit.log({ actorType: 'user', actorId: user.id, actorLabel: user.username, action: lock ? 'auth.locked' : 'auth.login_failed', details: { reason: 'bad_password' }, req });
    await loginEvents.record({ actorType: 'user', userId: user.id, identifier: ident, event: 'login', success: false, failureReason: lock ? 'bad_password_locked' : 'bad_password', req });
    throw generic;
  }
  if (user.status !== 'active') {
    await audit.log({ actorType: 'user', actorId: user.id, actorLabel: user.username, action: 'auth.login_blocked', details: { reason: 'suspended' }, req });
    await loginEvents.record({ actorType: 'user', userId: user.id, identifier: ident, event: 'login', success: false, failureReason: 'suspended', req });
    throw new AppError('This account is suspended. Please contact customer support.', 403);
  }
  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
  await audit.log({ actorType: 'user', actorId: user.id, actorLabel: user.username, action: 'auth.login', req });
  return user;
}

async function updateProfile(userId, { fullName, email, phone, country }, actor, req) {
  return db.withTransaction(async (client) => {
    const before = (await client.query('SELECT full_name, email, phone, country FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!before) throw new AppError('Customer not found.', 404);
    let updated;
    try {
      updated = (await client.query(
        `UPDATE users SET full_name = $2, email = $3, phone = $4, country = $5, updated_at = now() WHERE id = $1 RETURNING *`,
        [userId, fullName, email.toLowerCase(), phone, country])).rows[0];
    } catch (e) { throw mapUniqueViolation(e); }
    const changes = {};
    for (const [k, v] of Object.entries({ full_name: updated.full_name, email: updated.email, phone: updated.phone, country: updated.country })) {
      if (before[k] !== v) changes[k] = { from: before[k], to: v };
    }
    await audit.log({
      actorType: actor.type, actorId: actor.id, actorLabel: actor.label,
      action: actor.type === 'admin' ? 'customer.profile_edit' : 'user.profile_update',
      entityType: 'user', entityId: userId, details: changes, req,
    }, client);
    if (actor.type === 'admin' && Object.keys(changes).length) {
      await notifications.create(userId, { category: 'account', title: 'Profile updated by Qorvexa staff', body: `The following details were updated: ${Object.keys(changes).join(', ').replace(/_/g, ' ')}.`, link: '/profile' }, client);
    }
    return updated;
  });
}

async function changePassword(userId, currentPassword, newPassword, req) {
  const user = await getById(userId);
  if (!user) throw new AppError('Customer not found.', 404);
  if (!(await bcrypt.compare(currentPassword || '', user.password_hash))) {
    await audit.log({ actorType: 'user', actorId: user.id, actorLabel: user.username, action: 'user.password_change_failed', req });
    throw new AppError('Your current password is incorrect.');
  }
  if (await bcrypt.compare(newPassword, user.password_hash)) throw new AppError('Your new password must be different from the current one.');
  const hash = await hashPassword(newPassword);
  await db.withTransaction(async (client) => {
    await client.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, hash]);
    await notifications.create(userId, { category: 'security', title: 'Password changed', body: 'Your password was changed. If this was not you, contact support immediately.', link: '/profile' }, client);
    await audit.log({ actorType: 'user', actorId: user.id, actorLabel: user.username, action: 'user.password_change', req }, client);
  });
}

async function setStatus(userId, status, reason, admin, req) {
  if (!['active', 'suspended'].includes(status)) throw new AppError('Invalid status.');
  return db.withTransaction(async (client) => {
    const user = (await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!user) throw new AppError('Customer not found.', 404);
    if (user.status === status) throw new AppError(`Account is already ${status}.`);
    await client.query('UPDATE users SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1', [userId, status, reason || null]);
    await client.query(`UPDATE accounts SET status = $2 WHERE user_id = $1`, [userId, status === 'active' ? 'active' : 'frozen']);
    if (status === 'suspended') {
      // Terminate the customer's active sessions.
      await loginEvents.revokeUserSessions(userId, {}, client);
      await loginEvents.record({ actorType: 'user', userId, identifier: `admin:${admin.username}`, event: 'forced_logout', success: true, failureReason: 'account_suspended', req }, client);
    }
    await notifications.create(userId, {
      category: 'account',
      title: status === 'active' ? 'Account reactivated' : 'Account suspended',
      body: status === 'active' ? 'Your account has been reactivated.' : `Your account has been suspended${reason ? `: ${reason}` : '.'}`,
    }, client);
    await audit.log({ actorType: 'admin', actorId: admin.id, actorLabel: admin.username, action: status === 'active' ? 'customer.reactivate' : 'customer.suspend', entityType: 'user', entityId: userId, details: { reason: reason || null, username: user.username }, req }, client);
  });
}

/** Find an active recipient account by 10-digit account number or username. */
async function findRecipient(identifier, client) {
  const ident = String(identifier || '').trim();
  if (!ident) return null;
  const { rows } = await (client || db).query(
    `SELECT a.id AS account_id, a.account_number, a.status AS account_status, u.id AS user_id, u.full_name, u.username, u.status AS user_status
       FROM accounts a JOIN users u ON u.id = a.user_id
      WHERE a.account_number = $1 OR lower(u.username) = lower($1)
      ORDER BY a.created_at ASC LIMIT 1`, [ident.replace(/\s/g, '')]);
  return rows[0] || null;
}

async function search({ q, status, page = 1, perPage = 25 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    params.push(`%${q.trim()}%`);
    const i = params.length;
    where.push(`(u.full_name ILIKE $${i} OR u.email ILIKE $${i} OR u.username ILIKE $${i} OR a.account_number ILIKE $${i} OR u.customer_id ILIKE $${i} OR u.phone ILIKE $${i})`);
  }
  if (status) { params.push(status); where.push(`u.status = $${params.length}`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const count = (await db.query(`SELECT count(*)::int AS n FROM users u LEFT JOIN accounts a ON a.user_id = u.id ${w}`, params)).rows[0].n;
  params.push(perPage, (page - 1) * perPage);
  const { rows } = await db.query(
    `SELECT u.*, a.account_number, a.account_type, a.balance_cents, a.id AS account_id
       FROM users u LEFT JOIN accounts a ON a.user_id = u.id ${w}
      ORDER BY u.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total: count, page, perPage };
}

async function requestPasswordReset(email, req) {
  const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [String(email || '').trim()]);
  const user = rows[0];
  if (!user) {
    await audit.log({ actorType: 'guest', actorLabel: String(email).slice(0, 140), action: 'auth.reset_requested_unknown', req });
    await loginEvents.record({ actorType: 'user', identifier: String(email || '').trim(), event: 'password_reset_request', success: false, failureReason: 'unknown_email', req });
    return null;
  }
  const token = genToken();
  await db.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
  await db.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [user.id, sha256(token)]);
  await audit.log({ actorType: 'user', actorId: user.id, actorLabel: user.username, action: 'auth.reset_requested', req });
  await loginEvents.record({ actorType: 'user', userId: user.id, identifier: user.email, event: 'password_reset_request', success: true, req });
  const link = `${config.baseUrl}/reset-password/${token}`;
  await mail.send({
    to: user.email,
    subject: 'Reset your Qorvexa password',
    text: `Hello ${user.full_name},\n\nUse this link within 30 minutes to choose a new password:\n${link}\n\nIf you did not request this, you can ignore this message.\n\n(Qorvexa is an educational software project; all funds are simulated.)`,
  });
  return token; // returned for tests; never sent to the browser
}

async function validateResetToken(token) {
  const { rows } = await db.query(
    'SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()', [sha256(token)]);
  return rows[0] || null;
}

async function resetPassword(token, newPassword, req) {
  const hash = await hashPassword(newPassword);
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE', [sha256(token)]);
    const reset = rows[0];
    if (!reset) throw new AppError('This reset link is invalid or has expired.');
    await client.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [reset.id]);
    await client.query('UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [reset.user_id, hash]);
    await loginEvents.revokeUserSessions(reset.user_id, {}, client);
    await loginEvents.record({ actorType: 'user', userId: reset.user_id, event: 'password_reset', success: true, req }, client);
    await notifications.create(reset.user_id, { category: 'security', title: 'Password reset', body: 'Your password was reset using a reset link.' }, client);
    await audit.log({ actorType: 'user', actorId: reset.user_id, action: 'auth.password_reset', req }, client);
  });
}

module.exports = {
  hashPassword, createCustomer, getById, getPrimaryAccount, authenticate, updateProfile, changePassword,
  setStatus, findRecipient, search, requestPasswordReset, validateResetToken, resetPassword,
};

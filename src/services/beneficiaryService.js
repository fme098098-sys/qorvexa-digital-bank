'use strict';
const db = require('../db/pool');
const audit = require('./auditService');
const users = require('./userService');
const { AppError } = require('../utils/errors');

async function list(userId) {
  const { rows } = await db.query(
    `SELECT b.*, a.account_number, u.full_name, u.username
       FROM beneficiaries b JOIN accounts a ON a.id = b.beneficiary_account_id JOIN users u ON u.id = a.user_id
      WHERE b.user_id = $1 ORDER BY coalesce(b.nickname, u.full_name)`, [userId]);
  return rows;
}

async function add(user, identifier, nickname, req) {
  const rcpt = await users.findRecipient(identifier);
  if (!rcpt) throw new AppError('No Qorvexa account matches that account number or username.', 404);
  if (rcpt.user_id === user.id) throw new AppError('You cannot add your own account as a beneficiary.');
  try {
    const { rows } = await db.query(
      'INSERT INTO beneficiaries (user_id, beneficiary_account_id, nickname) VALUES ($1,$2,$3) RETURNING *',
      [user.id, rcpt.account_id, nickname ? String(nickname).trim().slice(0, 60) : null]);
    await audit.log({ actorType: 'user', actorId: user.id, actorLabel: user.username, action: 'beneficiary.add', entityType: 'beneficiary', entityId: rows[0].id, details: { account_number: rcpt.account_number }, req });
    return { beneficiary: rows[0], recipient: rcpt };
  } catch (e) {
    if (e.code === '23505') throw new AppError(`${rcpt.full_name} is already in your beneficiaries.`, 409);
    throw e;
  }
}

async function remove(user, id, req) {
  const { rows } = await db.query('DELETE FROM beneficiaries WHERE id = $1 AND user_id = $2 RETURNING *', [id, user.id]);
  if (!rows[0]) throw new AppError('Beneficiary not found.', 404);
  await audit.log({ actorType: 'user', actorId: user.id, actorLabel: user.username, action: 'beneficiary.remove', entityType: 'beneficiary', entityId: id, req });
}

module.exports = { list, add, remove };

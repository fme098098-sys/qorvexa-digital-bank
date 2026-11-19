'use strict';
process.env.NODE_ENV = 'test';
const request = require('supertest');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const db = require('../src/db/pool');
const users = require('../src/services/userService');
const ledger = require('../src/services/ledgerService');
const admins = require('../src/services/adminService');

const app = createApp();
const PASSWORD = 'Str0ng#Passw0rd';

async function resetData() {
  await db.query(`TRUNCATE password_resets, beneficiaries, notifications, support_tickets, "session" RESTART IDENTITY CASCADE`);
  // Ledger/audit tables are append-only; disable their guard triggers only for test cleanup.
  await db.query('ALTER TABLE transactions DISABLE TRIGGER transactions_immutable');
  await db.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
  await db.query('TRUNCATE audit_logs, transactions, deposit_requests, accounts, users, admin_users RESTART IDENTITY CASCADE');
  await db.query('ALTER TABLE transactions ENABLE TRIGGER transactions_immutable');
  await db.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
  // TRUNCATE admin_users CASCADE also empties system_settings (FK updated_by); restore defaults.
  await db.query(`INSERT INTO system_settings (key, value, description) VALUES
      ('registration_open','true','Allow new customers to register online'),
      ('max_single_transfer_cents','2500000','Maximum amount for a single transfer (cents)'),
      ('daily_transfer_limit_cents','5000000','Maximum total outgoing transfers per customer per day (cents)'),
      ('daily_withdrawal_limit_cents','1000000','Maximum total withdrawals per customer per day (cents)'),
      ('max_deposit_request_cents','10000000','Maximum amount for a single simulated deposit request (cents)'),
      ('maintenance_banner','','Optional banner text shown to signed-in customers')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = NULL`);
}

let n = 0;
async function makeUser(overrides = {}) {
  n += 1;
  const tag = `${Date.now().toString(36)}${n}`;
  const { user, account } = await users.createCustomer({
    fullName: overrides.fullName || `Test User ${String.fromCharCode(65 + (n % 26))}`,
    email: overrides.email || `user${tag}@example.com`,
    phone: '+1 555 010 0000',
    username: overrides.username || `user${tag}`,
    password: overrides.password || PASSWORD,
    country: 'United States',
    accountType: 'checking',
  });
  if (overrides.balance) await fund(user.id, overrides.balance);
  return { user, account };
}

async function fund(userId, cents) {
  const { request: r } = await ledger.createDepositRequest({ userId, amountCents: cents, method: 'simulated_wire' });
  await ledger.reviewDepositRequest({ requestId: r.id, decision: 'approve', note: 'test funding' });
}

async function makeAdmin(role = 'super_admin') {
  n += 1;
  return admins.createAdmin({ fullName: 'Test Admin', email: `admin${n}${Date.now()}@example.com`, username: `admin${n}${Date.now().toString(36)}`, password: 'AdminPassw0rd#1', role });
}

async function balanceOf(accountId) {
  return (await db.query('SELECT balance_cents FROM accounts WHERE id = $1', [accountId])).rows[0].balance_cents;
}

function extractCsrf(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  return m ? m[1] : null;
}

async function csrfFor(agent, path = '/login') {
  const res = await agent.get(path);
  return extractCsrf(res.text);
}

async function loginAgent(identifier, password = PASSWORD) {
  const agent = request.agent(app);
  const token = await csrfFor(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf: token, identifier, password });
  return { agent, res };
}

async function adminAgent(admin, password = 'AdminPassw0rd#1') {
  const agent = request.agent(app);
  const token = await csrfFor(agent, '/admin/login');
  const res = await agent.post('/admin/login').type('form').send({ _csrf: token, identifier: admin.username, password });
  return { agent, res };
}

const key = () => crypto.randomUUID();

module.exports = { app, request, db, PASSWORD, resetData, makeUser, fund, makeAdmin, balanceOf, extractCsrf, csrfFor, loginAgent, adminAgent, key };

#!/usr/bin/env node
'use strict';
/**
 * Seed fictional sample customers and transactions for local testing.
 * All money movements go through the ledger service (no direct balance writes).
 * Usage: npm run seed   (safe to re-run: skips if sample users exist)
 */
const crypto = require('crypto');
const db = require('../src/db/pool');
const users = require('../src/services/userService');
const ledger = require('../src/services/ledgerService');
const support = require('../src/services/supportService');

const PASSWORD = process.env.SEED_PASSWORD || 'Qorvexa#2026';

const SAMPLE = [
  { fullName: 'Amara Okafor', email: 'amara.okafor@example.com', phone: '+234 801 555 0101', username: 'amara', country: 'Nigeria', accountType: 'checking', opening: 2545000 },
  { fullName: 'Daniel Mercer', email: 'daniel.mercer@example.com', phone: '+1 555 010 4477', username: 'daniel.mercer', country: 'United States', accountType: 'checking', opening: 1820000 },
  { fullName: 'Sofia Lindqvist', email: 'sofia.lindqvist@example.com', phone: '+46 70 555 0199', username: 'sofia', country: 'Sweden', accountType: 'savings', opening: 4200000 },
  { fullName: 'Kenji Tanaka', email: 'kenji.tanaka@example.com', phone: '+81 90 5550 1234', username: 'kenji', country: 'Japan', accountType: 'business', opening: 7500000 },
  { fullName: 'Lucía Fernández', email: 'lucia.fernandez@example.com', phone: '+34 600 555 012', username: 'lucia', country: 'Spain', accountType: 'checking', opening: 960000 },
  { fullName: 'Kwame Mensah', email: 'kwame.mensah@example.com', phone: '+233 20 555 0177', username: 'kwame', country: 'Ghana', accountType: 'savings', opening: 315000 },
];
// Recently registered customers (shown under "new registrations")
const RECENT = [
  { fullName: 'Mei Chen', email: 'mei.chen@example.com', phone: '+65 8555 0123', username: 'mei', country: 'Singapore', accountType: 'checking', opening: 120000, days: 2 },
  { fullName: 'Oliver Brandt', email: 'oliver.brandt@example.com', phone: '+49 151 5550 0199', username: 'oliver', country: 'Germany', accountType: 'savings', opening: 0, days: 0 },
];

const daysAgo = (d, h = 10) => { const t = new Date(); t.setDate(t.getDate() - d); t.setHours(h, Math.floor(Math.random() * 59), 0, 0); return t; };
const key = () => crypto.randomUUID();

async function main() {
  const exists = (await db.query(`SELECT count(*)::int AS n FROM users WHERE username = 'amara'`)).rows[0].n;
  if (exists) { console.log('Sample data already present - skipping seed.'); return; }

  const created = {};
  for (const [i, s] of SAMPLE.entries()) {
    const { user, account } = await users.createCustomer({ ...s, password: PASSWORD });
    // Backdate registration for realistic "new registrations" figures.
    await db.query('UPDATE users SET created_at = $2 WHERE id = $1', [user.id, daysAgo(178 - i * 5)]);
    await db.query('UPDATE accounts SET created_at = $2 WHERE id = $1', [account.id, daysAgo(178 - i * 5)]);
    const at = daysAgo(176 - i * 5);
    await db.withTransaction(async (client) => {
      const { request } = await ledger.createDepositRequest({ userId: user.id, amountCents: s.opening, method: 'simulated_wire', note: 'Opening deposit', client, at });
      await ledger.reviewDepositRequest({ requestId: request.id, decision: 'approve', note: 'Seed data', client, at });
    });
    created[s.username] = user;
  }

  // Chronological activity over the past months (ledger keeps balances consistent).
  const activity = [
    ['transfer', 'amara', 'daniel.mercer', 45000, 'Concert tickets', 120],
    ['transfer', 'kenji', 'sofia', 250000, 'Consulting invoice 0042', 110],
    ['withdraw', 'daniel.mercer', null, 30000, 'ATM cash', 100],
    ['transfer', 'sofia', 'amara', 125000, 'Design project payment', 95],
    ['transfer', 'lucia', 'amara', 18050, 'Dinner split', 80],
    ['transfer', 'amara', 'kwame', 60000, 'Family support', 72],
    ['withdraw', 'amara', null, 20000, 'Cash withdrawal', 60],
    ['transfer', 'kenji', 'daniel.mercer', 410000, 'Equipment purchase', 50],
    ['transfer', 'daniel.mercer', 'lucia', 75000, 'Rent share', 40],
    ['transfer', 'amara', 'sofia', 98000, 'Rent - October', 33],
    ['withdraw', 'kenji', null, 150000, 'Petty cash', 25],
    ['transfer', 'kwame', 'amara', 12500, 'Books', 18],
    ['transfer', 'amara', 'lucia', 35000, 'Spanish lessons', 12],
    ['transfer', 'sofia', 'kenji', 220000, 'Office space deposit', 8],
    ['transfer', 'amara', 'daniel.mercer', 52575, 'Groceries & utilities', 5],
    ['withdraw', 'lucia', null, 15000, 'Market cash', 3],
    ['transfer', 'daniel.mercer', 'amara', 88000, 'Car repair refund', 2],
    ['transfer', 'amara', 'kenji', 41000, 'Laptop accessories', 1],
  ];
  for (const [type, from, to, amount, desc, d] of activity) {
    const at = daysAgo(d, 9 + Math.floor(Math.random() * 8));
    if (type === 'transfer') {
      await ledger.transfer({ userId: created[from].id, recipient: to, amountCents: amount, description: desc, idempotencyKey: key(), at });
    } else {
      await ledger.withdraw({ userId: created[from].id, amountCents: amount, description: desc, idempotencyKey: key(), at });
    }
  }

  for (const s of RECENT) {
    const { user, account } = await users.createCustomer({ ...s, password: PASSWORD });
    await db.query('UPDATE users SET created_at = $2 WHERE id = $1', [user.id, daysAgo(s.days, 8)]);
    await db.query('UPDATE accounts SET created_at = $2 WHERE id = $1', [account.id, daysAgo(s.days, 8)]);
    if (s.opening) {
      await db.withTransaction(async (client) => {
        const { request } = await ledger.createDepositRequest({ userId: user.id, amountCents: s.opening, method: 'simulated_card', note: 'Opening deposit', client, at: daysAgo(s.days, 9) });
        await ledger.reviewDepositRequest({ requestId: request.id, decision: 'approve', note: 'Seed data', client, at: daysAgo(s.days, 9) });
      });
    }
    created[s.username] = user;
  }

  // Pending items for the admin queue
  await ledger.createDepositRequest({ userId: created.amara.id, amountCents: 150000, method: 'simulated_card', note: 'Salary top-up', idempotencyKey: key() });
  await ledger.createDepositRequest({ userId: created.kwame.id, amountCents: 50000, method: 'simulated_cash', note: 'Savings', idempotencyKey: key() });
  await ledger.createDepositRequest({ userId: created.lucia.id, amountCents: 230000, method: 'simulated_wire', idempotencyKey: key() });

  await support.create({ user: created.daniel ? created.daniel : created['daniel.mercer'], subject: 'Question about daily transfer limit', category: 'transfer', message: 'Hello, can you explain how the daily transfer limit is calculated? Thanks!' });
  await support.create({ user: null, name: 'Priya Raman', email: 'priya.raman@example.com', subject: 'How do I open a business account?', category: 'account', message: 'I run a small design studio and would like to know what I need to open a business account.' });

  await db.query(`INSERT INTO audit_logs (actor_type, actor_label, action, details) VALUES ('system', 'seed', 'seed.complete', $1)`, [JSON.stringify({ customers: SAMPLE.length + RECENT.length, transactions: activity.length })]);
  console.log(`Seeded ${SAMPLE.length + RECENT.length} fictional customers (password: ${PASSWORD}) and ${activity.length} transactions.`);
}

main().then(() => db.pool.end()).catch((e) => { console.error(e); db.pool.end(); process.exit(1); });

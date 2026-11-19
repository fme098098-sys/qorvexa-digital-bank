'use strict';
const h = require('./helpers');
const ledger = require('../src/services/ledgerService');

beforeEach(() => h.resetData());
afterAll(() => h.db.pool.end());

describe('Transfer service', () => {
  test('moves money atomically and records both sides with one unique reference', async () => {
    const a = await h.makeUser({ balance: 100000 });
    const b = await h.makeUser();
    const r = await ledger.transfer({ userId: a.user.id, recipient: b.account.account_number, amountCents: 25050, description: 'Rent', userReference: 'NOV', idempotencyKey: h.key() });
    expect(r.reference).toMatch(/^TRF\d{8}[A-Z0-9]{8}$/);
    expect(await h.balanceOf(a.account.id)).toBe(74950);
    expect(await h.balanceOf(b.account.id)).toBe(25050);
    const { rows } = await h.db.query('SELECT * FROM transactions WHERE reference = $1 ORDER BY direction', [r.reference]);
    expect(rows.map((x) => x.type)).toEqual(['transfer_in', 'transfer_out']);
    expect(rows.find((x) => x.type === 'transfer_out').balance_after_cents).toBe(74950);
    expect(rows.find((x) => x.type === 'transfer_in').counterparty_name).toBe(a.user.full_name);
    const notes = await h.db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = ANY($1) AND category = $2', [[a.user.id, b.user.id], 'transfer']);
    expect(notes.rows[0].n).toBe(2);
  });

  test('accepts the recipient username as well as the account number', async () => {
    const a = await h.makeUser({ balance: 5000 });
    const b = await h.makeUser({ username: 'recipient.name' });
    await ledger.transfer({ userId: a.user.id, recipient: 'Recipient.Name', amountCents: 1000, description: 'Hi', idempotencyKey: h.key() });
    expect(await h.balanceOf(b.account.id)).toBe(1000);
  });

  test('rejects insufficient funds without changing any balance', async () => {
    const a = await h.makeUser({ balance: 5000 });
    const b = await h.makeUser();
    await expect(ledger.transfer({ userId: a.user.id, recipient: b.account.account_number, amountCents: 5001, description: 'Too much', idempotencyKey: h.key() }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await h.balanceOf(a.account.id)).toBe(5000);
    expect(await h.balanceOf(b.account.id)).toBe(0);
    const { rows } = await h.db.query(`SELECT count(*)::int AS n FROM transactions WHERE type LIKE 'transfer%'`);
    expect(rows[0].n).toBe(0);
  });

  test('rejects nonexistent recipients, self-transfers and invalid amounts', async () => {
    const a = await h.makeUser({ balance: 5000 });
    await expect(ledger.transfer({ userId: a.user.id, recipient: '4099999999', amountCents: 100, description: 'x', idempotencyKey: h.key() }))
      .rejects.toMatchObject({ code: 'RECIPIENT_NOT_FOUND' });
    await expect(ledger.transfer({ userId: a.user.id, recipient: a.account.account_number, amountCents: 100, description: 'x', idempotencyKey: h.key() }))
      .rejects.toThrow(/own account/);
    await expect(ledger.transfer({ userId: a.user.id, recipient: 'nobody', amountCents: -5, description: 'x' })).rejects.toThrow(/greater than/);
    await expect(ledger.transfer({ userId: a.user.id, recipient: 'nobody', amountCents: 0, description: 'x' })).rejects.toThrow(/greater than/);
  });

  test('blocks transfers to suspended accounts', async () => {
    const a = await h.makeUser({ balance: 5000 });
    const b = await h.makeUser();
    const admin = await h.makeAdmin();
    await require('../src/services/userService').setStatus(b.user.id, 'suspended', 'test', admin);
    await expect(ledger.transfer({ userId: a.user.id, recipient: b.account.account_number, amountCents: 100, description: 'x', idempotencyKey: h.key() }))
      .rejects.toThrow(/cannot receive/);
  });

  test('concurrent transfers never overdraw the account', async () => {
    const a = await h.makeUser({ balance: 10000 }); // $100.00
    const b = await h.makeUser();
    const c = await h.makeUser();
    const attempts = Array.from({ length: 12 }, (_, i) => ledger.transfer({
      userId: a.user.id, recipient: (i % 2 ? b : c).account.account_number, amountCents: 3000, description: `race ${i}`, idempotencyKey: h.key() }));
    const results = await Promise.allSettled(attempts);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    expect(failed.every((f) => f.reason.code === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await h.balanceOf(a.account.id)).toBe(1000);
    expect((await h.balanceOf(b.account.id)) + (await h.balanceOf(c.account.id))).toBe(9000);
    // Ledger reconciles with balances
    const { rows } = await h.db.query(`SELECT a.balance_cents, coalesce(sum(CASE WHEN t.direction = 'credit' THEN t.amount_cents ELSE -t.amount_cents END),0)::bigint AS ledger
      FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id GROUP BY a.id`);
    rows.forEach((r) => expect(r.balance_cents).toBe(r.ledger));
  });

  test('duplicate submissions with the same idempotency key create exactly one transfer', async () => {
    const a = await h.makeUser({ balance: 50000 });
    const b = await h.makeUser();
    const k = h.key();
    const results = await Promise.all(Array.from({ length: 6 }, () => ledger.transfer({
      userId: a.user.id, recipient: b.account.account_number, amountCents: 1500, description: 'dup', idempotencyKey: k })));
    const refs = new Set(results.map((r) => r.reference));
    expect(refs.size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await h.balanceOf(a.account.id)).toBe(48500);
    expect(await h.balanceOf(b.account.id)).toBe(1500);
  });

  test('enforces the per-transfer limit from system settings', async () => {
    const a = await h.makeUser({ balance: 9000000 });
    const b = await h.makeUser();
    await expect(ledger.transfer({ userId: a.user.id, recipient: b.account.account_number, amountCents: 2600000, description: 'big', idempotencyKey: h.key() }))
      .rejects.toThrow(/maximum single transfer/);
  });
});

describe('Ledger integrity (database level)', () => {
  test('balances cannot be changed outside the ledger and ledger rows are immutable', async () => {
    const a = await h.makeUser({ balance: 1000 });
    await expect(h.db.query('UPDATE accounts SET balance_cents = 999999 WHERE id = $1', [a.account.id])).rejects.toThrow(/ledgered transactions/);
    await expect(h.db.query('UPDATE transactions SET amount_cents = 1')).rejects.toThrow(/immutable/);
    await expect(h.db.query('DELETE FROM transactions')).rejects.toThrow(/immutable/);
    await expect(h.db.query('DELETE FROM audit_logs')).rejects.toThrow(/immutable/);
    expect(await h.balanceOf(a.account.id)).toBe(1000);
  });

  test('CHECK constraint forbids negative balances even inside the ledger context', async () => {
    const a = await h.makeUser({ balance: 1000 });
    await expect(h.db.withTransaction(async (c) => {
      await c.query(`SELECT set_config('qorvexa.ledger_write', 'on', true)`);
      await c.query('UPDATE accounts SET balance_cents = balance_cents - 2000 WHERE id = $1', [a.account.id]);
    })).rejects.toThrow(/check constraint/);
  });
});

describe('Transfer HTTP flow', () => {
  async function review(agent, body) {
    const token = h.extractCsrf((await agent.get('/transfer')).text);
    const res = await agent.post('/transfer/review').type('form').send({ _csrf: token, ...body });
    return { res, token };
  }

  test('review shows the recipient name, confirm completes, re-submit does not duplicate', async () => {
    const a = await h.makeUser({ balance: 20000, username: 'payer' });
    const b = await h.makeUser({ fullName: 'Bella Recipient' });
    const { agent } = await h.loginAgent('payer');
    const { res, token } = await review(agent, { recipient: b.account.account_number, amount: '50.25', description: 'Lunch' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Bella Recipient');
    const idem = res.text.match(/name="idempotencyKey" value="([^"]+)"/)[1];

    const noConfirm = await agent.post('/transfer/confirm').type('form').send({ _csrf: token, idempotencyKey: idem });
    expect(noConfirm.status).toBe(422);
    expect(await h.balanceOf(a.account.id)).toBe(20000);

    const done = await agent.post('/transfer/confirm').type('form').send({ _csrf: token, idempotencyKey: idem, confirmName: '1' });
    expect(done.status).toBe(302);
    const ref = done.headers.location.match(/\/transactions\/([A-Z0-9]+)/)[1];
    const again = await agent.post('/transfer/confirm').type('form').send({ _csrf: token, idempotencyKey: idem, confirmName: '1' });
    expect(again.status).toBe(302);
    expect(again.headers.location).toContain(ref);
    expect(await h.balanceOf(a.account.id)).toBe(14975);
    expect(await h.balanceOf(b.account.id)).toBe(5025);

    const receipt = await agent.get(`/transactions/${ref}?receipt=1`);
    expect(receipt.text).toContain('Success');
    expect(receipt.text).toMatch(/simulated/i);
    const pdf = await agent.get(`/transactions/${ref}/receipt.pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const history = await agent.get('/transactions?q=Lunch');
    expect(history.text).toContain(ref);
  });

  test('review rejects insufficient funds and unknown recipients with clear errors', async () => {
    await h.makeUser({ balance: 1000, username: 'poor' });
    const b = await h.makeUser();
    const { agent } = await h.loginAgent('poor');
    const r1 = await review(agent, { recipient: b.account.account_number, amount: '10.01', description: 'Too much' });
    expect(r1.res.status).toBe(422);
    expect(r1.res.text).toContain('Insufficient funds');
    const r2 = await review(agent, { recipient: '4000000001', amount: '1', description: 'Who' });
    expect(r2.res.status).toBe(422);
    expect(r2.res.text).toContain('Recipient account not found');
  });

  test('another customer cannot view my transaction receipt', async () => {
    const a = await h.makeUser({ balance: 5000 });
    const b = await h.makeUser();
    await h.makeUser({ username: 'snoop' });
    const r = await ledger.transfer({ userId: a.user.id, recipient: b.account.account_number, amountCents: 100, description: 'private', idempotencyKey: h.key() });
    const { agent } = await h.loginAgent('snoop');
    expect((await agent.get(`/transactions/${r.reference}`)).status).toBe(404);
    expect((await agent.get(`/transactions/${r.reference}/receipt.pdf`)).status).toBe(404);
  });
});

describe('Withdrawals and deposits', () => {
  test('withdrawal debits balance and cannot overdraw', async () => {
    const a = await h.makeUser({ balance: 5000 });
    await ledger.withdraw({ userId: a.user.id, amountCents: 2000, idempotencyKey: h.key() });
    expect(await h.balanceOf(a.account.id)).toBe(3000);
    await expect(ledger.withdraw({ userId: a.user.id, amountCents: 3001, idempotencyKey: h.key() })).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  test('deposit requests do not change the balance until approved', async () => {
    const a = await h.makeUser();
    const { request } = await ledger.createDepositRequest({ userId: a.user.id, amountCents: 7700, method: 'simulated_card', idempotencyKey: h.key() });
    expect(await h.balanceOf(a.account.id)).toBe(0);
    const admin = await h.makeAdmin();
    await ledger.reviewDepositRequest({ requestId: request.id, decision: 'approve', admin });
    expect(await h.balanceOf(a.account.id)).toBe(7700);
    await expect(ledger.reviewDepositRequest({ requestId: request.id, decision: 'approve', admin })).rejects.toThrow(/already been approved/);
    expect(await h.balanceOf(a.account.id)).toBe(7700);
  });
});

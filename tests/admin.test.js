'use strict';
const h = require('./helpers');
const ledger = require('../src/services/ledgerService');

beforeEach(() => h.resetData());
afterAll(() => h.db.pool.end());

describe('Admin authentication and authorization', () => {
  test('admin pages require a separate admin login', async () => {
    const anon = await h.request(h.app).get('/admin');
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toBe('/admin/login');
    // A signed-in customer is not an admin
    await h.makeUser({ username: 'customer1' });
    const { agent } = await h.loginAgent('customer1');
    for (const p of ['/admin', '/admin/users', '/admin/transactions', '/admin/settings']) {
      const res = await agent.get(p);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login');
    }
    // Customer credentials do not work on the admin login
    const token = await h.csrfFor(agent, '/admin/login');
    const res = await agent.post('/admin/login').type('form').send({ _csrf: token, identifier: 'customer1', password: h.PASSWORD });
    expect(res.status).toBe(401);
  });

  test('rejects wrong admin passwords and logs the failure', async () => {
    const admin = await h.makeAdmin();
    const { res } = await h.adminAgent(admin, 'WrongPassword#9');
    expect(res.status).toBe(401);
    const { rows } = await h.db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'admin.login_failed'`);
    expect(rows[0].n).toBe(1);
  });

  test('support role cannot access operations or settings', async () => {
    const support = await h.makeAdmin('support');
    const { agent, res } = await h.adminAgent(support);
    expect(res.status).toBe(302);
    expect((await agent.get('/admin')).status).toBe(200);
    expect((await agent.get('/admin/support')).status).toBe(200);
    expect((await agent.get('/admin/transactions')).status).toBe(403);
    expect((await agent.get('/admin/deposits')).status).toBe(403);
    const token = h.extractCsrf((await agent.get('/admin')).text);
    expect((await agent.post('/admin/settings').type('form').send({ _csrf: token, registration_open: 'on' })).status).toBe(403);
  });

  test('regular admin can view settings but only super admin can change them', async () => {
    const admin = await h.makeAdmin('admin');
    const { agent } = await h.adminAgent(admin);
    expect((await agent.get('/admin/settings')).status).toBe(200);
    const token = h.extractCsrf((await agent.get('/admin/settings')).text);
    expect((await agent.post('/admin/settings').type('form').send({ _csrf: token })).status).toBe(403);

    const sup = await h.makeAdmin('super_admin');
    const s = await h.adminAgent(sup);
    const t2 = h.extractCsrf((await s.agent.get('/admin/settings')).text);
    const res = await s.agent.post('/admin/settings').type('form').send({ _csrf: t2, max_single_transfer_cents: '1000.00', daily_transfer_limit_cents: '50000.00', daily_withdrawal_limit_cents: '10000.00', max_deposit_request_cents: '100000.00', registration_open: 'on', maintenance_banner: '' });
    expect(res.status).toBe(302);
    const v = await h.db.query(`SELECT value FROM system_settings WHERE key = 'max_single_transfer_cents'`);
    expect(v.rows[0].value).toBe('100000');
    const log = await h.db.query(`SELECT * FROM audit_logs WHERE action = 'settings.update'`);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].details.max_single_transfer_cents).toEqual({ from: '2500000', to: '100000' });
  });
});

describe('Admin operations are ledgered and audited', () => {
  test('approving a deposit request credits the account and is audit-logged', async () => {
    const { user, account } = await h.makeUser();
    const { request } = await ledger.createDepositRequest({ userId: user.id, amountCents: 12345, method: 'simulated_wire', idempotencyKey: h.key() });
    const admin = await h.makeAdmin('admin');
    const { agent } = await h.adminAgent(admin);
    const page = await agent.get('/admin/deposits');
    expect(page.text).toContain(request.reference);
    const token = h.extractCsrf(page.text);
    const res = await agent.post(`/admin/deposits/${request.id}/review`).type('form').send({ _csrf: token, decision: 'approve', note: 'verified' });
    expect(res.status).toBe(302);
    expect(await h.balanceOf(account.id)).toBe(12345);
    const tx = await h.db.query('SELECT * FROM transactions WHERE deposit_request_id = $1', [request.id]);
    expect(tx.rows[0].initiated_by_admin).toBe(admin.id);
    const log = await h.db.query(`SELECT * FROM audit_logs WHERE action = 'deposit.approve' AND actor_id = $1`, [admin.id]);
    expect(log.rows).toHaveLength(1);
  });

  test('rejecting a deposit requires a reason and never changes the balance', async () => {
    const { user, account } = await h.makeUser();
    const { request } = await ledger.createDepositRequest({ userId: user.id, amountCents: 5000, method: 'simulated_cash', idempotencyKey: h.key() });
    const admin = await h.makeAdmin('admin');
    const { agent } = await h.adminAgent(admin);
    const token = h.extractCsrf((await agent.get('/admin/deposits')).text);
    await agent.post(`/admin/deposits/${request.id}/review`).type('form').send({ _csrf: token, decision: 'reject' });
    expect((await h.db.query('SELECT status FROM deposit_requests WHERE id = $1', [request.id])).rows[0].status).toBe('pending');
    await agent.post(`/admin/deposits/${request.id}/review`).type('form').send({ _csrf: token, decision: 'reject', note: 'Unverified source' });
    expect((await h.db.query('SELECT status FROM deposit_requests WHERE id = $1', [request.id])).rows[0].status).toBe('rejected');
    expect(await h.balanceOf(account.id)).toBe(0);
  });

  test('suspending a customer is audit-logged, ends access, and reactivation restores it', async () => {
    const { user } = await h.makeUser({ username: 'tobesuspended' });
    const customer = await h.loginAgent('tobesuspended');
    expect((await customer.agent.get('/dashboard')).status).toBe(200);
    const admin = await h.makeAdmin('admin');
    const { agent } = await h.adminAgent(admin);
    const token = h.extractCsrf((await agent.get(`/admin/users/${user.id}`)).text);
    const noReason = await agent.post(`/admin/users/${user.id}/status`).type('form').send({ _csrf: token, status: 'suspended' });
    expect(noReason.status).toBe(302);
    expect((await h.db.query('SELECT status FROM users WHERE id = $1', [user.id])).rows[0].status).toBe('active');
    await agent.post(`/admin/users/${user.id}/status`).type('form').send({ _csrf: token, status: 'suspended', reason: 'Investigation' });
    expect((await h.db.query('SELECT status FROM users WHERE id = $1', [user.id])).rows[0].status).toBe('suspended');
    expect((await customer.agent.get('/dashboard')).status).toBe(302);
    await agent.post(`/admin/users/${user.id}/status`).type('form').send({ _csrf: token, status: 'active', reason: 'Cleared' });
    const actions = (await h.db.query(`SELECT action FROM audit_logs WHERE actor_type = 'admin' AND entity_id = $1 ORDER BY id`, [user.id])).rows.map((r) => r.action);
    expect(actions).toEqual(['customer.suspend', 'customer.reactivate']);
  });

  test('admin can create a customer with an opening deposit that goes through the ledger', async () => {
    const admin = await h.makeAdmin('admin');
    const { agent } = await h.adminAgent(admin);
    const token = h.extractCsrf((await agent.get('/admin/users/new')).text);
    const res = await agent.post('/admin/users').type('form').send({
      _csrf: token, fullName: 'Created By Admin', email: 'cba@example.com', phone: '+1 555 010 9999', username: 'cba',
      country: 'Kenya', accountType: 'business', password: h.PASSWORD, openingDeposit: '250.00' });
    expect(res.status).toBe(302);
    const { rows } = await h.db.query(`SELECT u.created_by_admin, a.balance_cents FROM users u JOIN accounts a ON a.user_id = u.id WHERE u.username = 'cba'`);
    expect(rows[0].created_by_admin).toBe(admin.id);
    expect(rows[0].balance_cents).toBe(25000);
    const logs = (await h.db.query(`SELECT action FROM audit_logs WHERE actor_id = $1 ORDER BY id`, [admin.id])).rows.map((r) => r.action);
    expect(logs).toEqual(expect.arrayContaining(['customer.create', 'deposit.approve']));
  });

  test('admin profile edits are audited and cannot touch balances', async () => {
    const { user, account } = await h.makeUser({ balance: 4000 });
    const admin = await h.makeAdmin('admin');
    const { agent } = await h.adminAgent(admin);
    const token = h.extractCsrf((await agent.get(`/admin/users/${user.id}`)).text);
    const res = await agent.post(`/admin/users/${user.id}/edit`).type('form').send({
      _csrf: token, fullName: 'Renamed Person', email: user.email, phone: user.phone, country: 'Ghana', balance_cents: '99999999' });
    expect(res.status).toBe(302);
    expect(await h.balanceOf(account.id)).toBe(4000);
    const log = (await h.db.query(`SELECT details FROM audit_logs WHERE action = 'customer.profile_edit'`)).rows[0];
    expect(log.details.full_name.to).toBe('Renamed Person');
    expect(log.details.country).toEqual({ from: 'United States', to: 'Ghana' });
  });

  test('admin can search users and transactions by reference', async () => {
    const a = await h.makeUser({ balance: 5000, fullName: 'Searchable Person' });
    const b = await h.makeUser();
    const r = await ledger.transfer({ userId: a.user.id, recipient: b.account.account_number, amountCents: 700, description: 'find me', idempotencyKey: h.key() });
    const admin = await h.makeAdmin('admin');
    const { agent } = await h.adminAgent(admin);
    const users = await agent.get('/admin/users?q=Searchable');
    expect(users.text).toContain('Searchable Person');
    expect(users.text).not.toContain(b.user.email);
    const byAcct = await agent.get(`/admin/users?q=${a.account.account_number}`);
    expect(byAcct.text).toContain('Searchable Person');
    const txs = await agent.get(`/admin/transactions?q=${r.reference}`);
    expect(txs.text).toContain(r.reference);
    expect((await agent.get(`/admin/transactions/${r.reference}`)).text).toContain('immutable');
  });
});

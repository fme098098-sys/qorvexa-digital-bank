'use strict';
const h = require('./helpers');

beforeEach(() => h.resetData());
afterAll(() => h.db.pool.end());

describe('Registration', () => {
  test('registers a customer with hashed password, unique account ID and account number', async () => {
    const agent = h.request.agent(h.app);
    const token = await h.csrfFor(agent, '/register');
    const res = await agent.post('/register').type('form').send({
      _csrf: token, fullName: 'Jane Student', email: 'jane@example.com', phone: '+1 555 010 1234', username: 'jane.s',
      password: h.PASSWORD, confirmPassword: h.PASSWORD, country: 'Canada', accountType: 'savings', terms: '1',
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    const { rows } = await h.db.query('SELECT u.*, a.account_number, a.balance_cents FROM users u JOIN accounts a ON a.user_id = u.id WHERE u.username = $1', ['jane.s']);
    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash).not.toBe(h.PASSWORD);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect(rows[0].customer_id).toMatch(/^QX[A-Z0-9]{8}$/);
    expect(rows[0].account_number).toMatch(/^\d{10}$/);
    expect(rows[0].balance_cents).toBe(0);
    const dash = await agent.get('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('Welcome back, Jane');
    expect(dash.text).toContain('$0.00');
    expect(dash.text).toMatch(/simulated/i);
  });

  test('rejects duplicate username/email and weak passwords', async () => {
    await h.makeUser({ username: 'taken', email: 'taken@example.com' });
    const agent = h.request.agent(h.app);
    const token = await h.csrfFor(agent, '/register');
    const base = { _csrf: token, fullName: 'Another Person', phone: '+1 555 010 1234', country: 'Canada', accountType: 'checking', terms: '1' };
    const dup = await agent.post('/register').type('form').send({ ...base, email: 'new@example.com', username: 'taken', password: h.PASSWORD, confirmPassword: h.PASSWORD });
    expect(dup.status).toBe(409);
    expect(dup.text).toContain('username is already taken');
    const weak = await agent.post('/register').type('form').send({ ...base, email: 'new2@example.com', username: 'newuser', password: 'short', confirmPassword: 'short' });
    expect(weak.status).toBe(422);
    const mismatch = await agent.post('/register').type('form').send({ ...base, email: 'new3@example.com', username: 'newuser3', password: h.PASSWORD, confirmPassword: h.PASSWORD + 'x' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.text).toContain('Passwords do not match');
  });

  test('registration and login pages show the simulated-funds notice', async () => {
    for (const p of ['/register', '/login', '/']) {
      const res = await h.request(h.app).get(p);
      expect(res.text).toMatch(/Educational software project/);
    }
  });
});

describe('Login, sessions and CSRF', () => {
  test('logs in with username or email and rejects bad passwords', async () => {
    const { user } = await h.makeUser({ username: 'loginuser', email: 'login@example.com' });
    const bad = await h.loginAgent('loginuser', 'WrongPassword#1');
    expect(bad.res.status).toBe(401);
    expect(bad.res.text).toContain('Invalid email/username or password');
    const byEmail = await h.loginAgent('LOGIN@example.com');
    expect(byEmail.res.status).toBe(302);
    const ok = await h.loginAgent('loginuser');
    expect(ok.res.status).toBe(302);
    const cookie = ok.res.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const dash = await ok.agent.get('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.text).toContain(user.full_name.split(' ')[0]);
  });

  test('protected pages redirect anonymous visitors to login', async () => {
    for (const p of ['/dashboard', '/transfer', '/transactions', '/profile']) {
      const res = await h.request(h.app).get(p);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
  });

  test('state-changing requests without a valid CSRF token are rejected', async () => {
    await h.makeUser({ username: 'csrfuser' });
    const res = await h.request(h.app).post('/login').type('form').send({ identifier: 'csrfuser', password: h.PASSWORD });
    expect(res.status).toBe(403);
    const { agent } = await h.loginAgent('csrfuser');
    const r2 = await agent.post('/transfer/review').type('form').send({ _csrf: 'forged', recipient: 'x', amount: '1' });
    expect(r2.status).toBe(403);
  });

  test('suspended customers cannot sign in', async () => {
    const { user } = await h.makeUser({ username: 'suspended1' });
    const admin = await h.makeAdmin();
    const users = require('../src/services/userService');
    await users.setStatus(user.id, 'suspended', 'test', admin);
    const { res } = await h.loginAgent('suspended1');
    expect(res.status).toBe(403);
    expect(res.text).toContain('suspended');
  });

  test('locks sign-in after repeated failed attempts', async () => {
    await h.makeUser({ username: 'lockme' });
    for (let i = 0; i < 5; i++) await h.loginAgent('lockme', 'Wrong#Password1');
    const { res } = await h.loginAgent('lockme');
    expect(res.status).toBe(429);
  });

  test('logout ends the session', async () => {
    await h.makeUser({ username: 'logoutuser' });
    const { agent } = await h.loginAgent('logoutuser');
    const token = h.extractCsrf((await agent.get('/dashboard')).text);
    const out = await agent.post('/logout').type('form').send({ _csrf: token });
    expect(out.status).toBe(302);
    expect((await agent.get('/dashboard')).status).toBe(302);
  });
});

describe('Password management', () => {
  test('change password requires the current password', async () => {
    await h.makeUser({ username: 'pwuser' });
    const { agent } = await h.loginAgent('pwuser');
    const token = h.extractCsrf((await agent.get('/profile')).text);
    const wrong = await agent.post('/profile/password').type('form').send({ _csrf: token, currentPassword: 'nope', newPassword: 'N3w#Password99', confirmPassword: 'N3w#Password99' });
    expect(wrong.status).toBe(400);
    const ok = await agent.post('/profile/password').type('form').send({ _csrf: token, currentPassword: h.PASSWORD, newPassword: 'N3w#Password99', confirmPassword: 'N3w#Password99' });
    expect(ok.status).toBe(302);
    expect((await h.loginAgent('pwuser', 'N3w#Password99')).res.status).toBe(302);
  });

  test('forgot/reset password flow uses a single-use token', async () => {
    const { user } = await h.makeUser({ username: 'forgetful', email: 'forgetful@example.com' });
    const users = require('../src/services/userService');
    const token = await users.requestPasswordReset('forgetful@example.com');
    const agent = h.request.agent(h.app);
    const page = await agent.get(`/reset-password/${token}`);
    expect(page.text).toContain('Choose a new password');
    const csrf = h.extractCsrf(page.text);
    const res = await agent.post(`/reset-password/${token}`).type('form').send({ _csrf: csrf, password: 'Reset#Passw0rd', confirmPassword: 'Reset#Passw0rd' });
    expect(res.status).toBe(302);
    const again = await agent.post(`/reset-password/${token}`).type('form').send({ _csrf: csrf, password: 'Other#Passw0rd', confirmPassword: 'Other#Passw0rd' });
    expect(again.status).toBe(400);
    expect((await h.loginAgent(user.username, 'Reset#Passw0rd')).res.status).toBe(302);
  });
});

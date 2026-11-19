'use strict';
const h = require('./helpers');
const loginEvents = require('../src/services/loginEventService');

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
};

async function loginWith(identifier, ua, password = h.PASSWORD) {
  const agent = h.request.agent(h.app);
  const page = await agent.get('/login').set('User-Agent', ua);
  const res = await agent.post('/login').set('User-Agent', ua).type('form')
    .send({ _csrf: h.extractCsrf(page.text), identifier, password });
  return { agent, res };
}
async function adminLoginWith(admin, ua = UA.chromeWin) {
  const agent = h.request.agent(h.app);
  const page = await agent.get('/admin/login').set('User-Agent', ua);
  await agent.post('/admin/login').set('User-Agent', ua).type('form')
    .send({ _csrf: h.extractCsrf(page.text), identifier: admin.username, password: 'AdminPassw0rd#1' });
  return agent;
}
const events = async (where = 'TRUE', params = []) => (await h.db.query(`SELECT * FROM login_events WHERE ${where} ORDER BY id`, params)).rows;

beforeEach(() => h.resetData());
afterAll(() => h.db.pool.end());

describe('recording sign-in activity', () => {
  test('successful login stores IP, raw and parsed user agent, and session metadata', async () => {
    const { user } = await h.makeUser();
    const { res, agent } = await loginWith(user.username, UA.chromeWin);
    expect(res.headers.location).toBe('/dashboard');
    const [e] = await events("event = 'login'");
    expect(e).toMatchObject({ actor_type: 'user', user_id: user.id, success: true, browser: 'Chrome', os: 'Windows', device_type: 'desktop', user_agent: UA.chromeWin, is_new_device: false });
    expect(e.ip).toMatch(/127\.0\.0\.1|::1/);
    expect(e.session_id).toBeTruthy();
    const sessions = await loginEvents.activeSessions('user', user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sid: e.session_id, browser: 'Chrome', os: 'Windows', user_agent: UA.chromeWin });
    expect(sessions[0].signed_in_at).toBeInstanceOf(Date);
    // logout is recorded too and the session no longer holds the customer
    const dash = await agent.get('/dashboard').set('User-Agent', UA.chromeWin);
    await agent.post('/logout').set('User-Agent', UA.chromeWin).type('form').send({ _csrf: h.extractCsrf(dash.text) });
    expect((await events("event = 'logout'"))[0]).toMatchObject({ user_id: user.id, success: true });
    expect(await loginEvents.activeSessions('user', user.id)).toHaveLength(0);
  });

  test('failed attempts record reason; unknown usernames keep the typed identifier with no user_id', async () => {
    const { user } = await h.makeUser();
    await loginWith(user.username, UA.firefoxLinux, 'Wrong#Passw0rd');
    await loginWith('nobody_here', UA.firefoxLinux);
    const rows = await events('NOT success');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ user_id: user.id, failure_reason: 'bad_password', browser: 'Firefox', os: 'Linux' });
    expect(rows[1]).toMatchObject({ user_id: null, identifier: 'nobody_here', failure_reason: 'unknown_user' });
  });

  test('suspended accounts, admin logins and password resets are recorded', async () => {
    const { user } = await h.makeUser();
    const admin = await h.makeAdmin();
    await adminLoginWith(admin);
    const bad = h.request.agent(h.app);
    const p = await bad.get('/admin/login');
    await bad.post('/admin/login').type('form').send({ _csrf: h.extractCsrf(p.text), identifier: admin.username, password: 'nope' });
    const adminRows = await events("actor_type = 'admin'");
    expect(adminRows.map((r) => [r.success, r.failure_reason])).toEqual([[true, null], [false, 'bad_password']]);
    expect(adminRows[0].admin_id).toBe(admin.id);

    const users = require('../src/services/userService');
    const token = await users.requestPasswordReset(user.email, null);
    await users.resetPassword(token, 'N3w#Password!x', null);
    expect((await events("event LIKE 'password_reset%'")).map((r) => [r.event, r.success])).toEqual([['password_reset_request', true], ['password_reset', true]]);

    await h.db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [user.id]);
    await loginWith(user.username, UA.chromeWin, 'N3w#Password!x');
    expect((await events("failure_reason = 'suspended'"))).toHaveLength(1);
  });

  test('login_events is append-only', async () => {
    const { user } = await h.makeUser();
    await loginWith(user.username, UA.chromeWin);
    await expect(h.db.query('UPDATE login_events SET success = false')).rejects.toThrow(/immutable/);
    await expect(h.db.query('DELETE FROM login_events')).rejects.toThrow(/immutable/);
  });
});

describe('new device / browser detection', () => {
  test('first sign-in is the baseline; a different browser+OS is flagged and the customer is notified', async () => {
    const { user } = await h.makeUser();
    await loginWith(user.username, UA.chromeWin);
    await loginWith(user.username, UA.chromeWin);
    await loginWith(user.username, UA.safariIphone);
    const rows = await events("event = 'login' AND success");
    expect(rows.map((r) => r.is_new_device)).toEqual([false, false, true]);
    expect(rows[2]).toMatchObject({ browser: 'Safari', os: 'iOS', device_type: 'mobile', device_model: 'iPhone' });
    const notes = (await h.db.query("SELECT * FROM notifications WHERE user_id = $1 AND category = 'security'", [user.id])).rows;
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toMatch(/New sign-in from Safari on iOS \(mobile\), IP /);
    // Seen again: no longer new
    await loginWith(user.username, UA.safariIphone);
    expect((await events("event = 'login' AND success")).pop().is_new_device).toBe(false);
  });

  test('same browser and OS from a different IP is a new device', async () => {
    const { user } = await h.makeUser();
    const fakeReq = (ip) => ({ ip, get: () => UA.chromeWin });
    await loginEvents.recordSuccessfulLogin({ actorType: 'user', principal: user, req: fakeReq('203.0.113.7') });
    const again = await loginEvents.recordSuccessfulLogin({ actorType: 'user', principal: user, req: fakeReq('203.0.113.7') });
    const moved = await loginEvents.recordSuccessfulLogin({ actorType: 'user', principal: user, req: fakeReq('198.51.100.20') });
    expect([again.is_new_device, moved.is_new_device]).toEqual([false, true]);
  });

  test('registration sets the baseline device', async () => {
    const agent = h.request.agent(h.app);
    const page = await agent.get('/register').set('User-Agent', UA.chromeWin);
    const res = await agent.post('/register').set('User-Agent', UA.chromeWin).type('form').send({
      _csrf: h.extractCsrf(page.text), fullName: 'Reg Person', email: 'reg.person@example.com', phone: '+1 555 010 1234',
      username: 'regperson', password: h.PASSWORD, confirmPassword: h.PASSWORD, country: 'United States', accountType: 'checking', terms: 'on' });
    expect(res.headers.location).toBe('/dashboard');
    await loginWith('regperson', UA.chromeWin);
    await loginWith('regperson', UA.firefoxLinux);
    expect((await events("event = 'login' AND success")).map((r) => r.is_new_device)).toEqual([false, false, true]);
  });

  test('admin sidebar shows a new-device badge', async () => {
    const { user } = await h.makeUser();
    await loginWith(user.username, UA.chromeWin);
    await loginWith(user.username, UA.firefoxLinux);
    const agent = await adminLoginWith(await h.makeAdmin('admin'));
    const page = await agent.get('/admin');
    expect(page.text).toMatch(/<b class="badge"[^>]*>1 new<\/b>/);
  });
});

describe('admin login activity pages and access control', () => {
  test('global page lists, filters and highlights failures; user detail shows activity and sessions', async () => {
    const { user } = await h.makeUser({ username: 'watched' });
    await loginWith('watched', UA.chromeWin);
    await loginWith('watched', UA.safariIphone);
    await loginWith('watched', UA.firefoxLinux, 'Bad#Passw0rd1');
    const agent = await adminLoginWith(await h.makeAdmin('admin'));

    const all = await agent.get('/admin/login-activity');
    expect(all.status).toBe(200);
    expect(all.text).toContain('Recent failed sign-in attempts');
    expect(all.text).toContain('row-failed-recent');
    expect(all.text).toMatch(/UTC/);

    const failed = await agent.get('/admin/login-activity?status=failed&actor=user');
    expect(failed.text).toContain('Bad Password');
    expect(failed.text).not.toContain('>Success<');

    const newOnly = await agent.get('/admin/login-activity?new=1');
    expect((newOnly.text.match(/status-new-device">New device/g) || []).length).toBe(1);
    expect(newOnly.text).toContain('Safari');

    const today = new Date().toISOString().slice(0, 10);
    const ranged = await agent.get(`/admin/login-activity?from=2000-01-01&to=2000-01-02&q=watched`);
    expect(ranged.text).toContain('No sign-in activity recorded.');
    const todayRes = await agent.get(`/admin/login-activity?from=${today}&to=${today}&q=watched`);
    expect(todayRes.text).toContain('Chrome');

    const detail = await agent.get(`/admin/users/${user.id}`);
    expect(detail.text).toContain('Login activity');
    expect(detail.text).toContain('Active sessions');
    expect(detail.text).toContain('Sign out all sessions');
    expect(detail.text).toContain('iOS');
  });

  test('support staff and customers cannot see login activity or force sign-outs', async () => {
    const { user } = await h.makeUser();
    await loginWith(user.username, UA.chromeWin);
    const support = await adminLoginWith(await h.makeAdmin('support'));
    expect((await support.get('/admin/login-activity')).status).toBe(403);
    const detail = await support.get(`/admin/users/${user.id}`);
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain('Sign out all sessions');
    const tok = h.extractCsrf(detail.text);
    expect((await support.post(`/admin/users/${user.id}/sessions/revoke`).type('form').send({ _csrf: tok })).status).toBe(403);

    const { agent: customer } = await loginWith(user.username, UA.chromeWin);
    expect((await customer.get('/admin/login-activity')).headers.location).toBe('/admin/login');
    const anon = h.request(h.app);
    expect((await anon.get('/admin/login-activity')).headers.location).toBe('/admin/login');
    expect(await loginEvents.activeSessions('user', user.id)).toHaveLength(2);
  });
});

describe('force sign-out', () => {
  test('admin "sign out all sessions" ends every customer session, is audited and notifies', async () => {
    const { user } = await h.makeUser();
    const { agent: a1 } = await loginWith(user.username, UA.chromeWin);
    const { agent: a2 } = await loginWith(user.username, UA.safariIphone);
    expect((await a1.get('/dashboard')).status).toBe(200);
    const admin = await h.makeAdmin('admin');
    const agent = await adminLoginWith(admin);
    const page = await agent.get(`/admin/users/${user.id}`);
    const res = await agent.post(`/admin/users/${user.id}/sessions/revoke`).type('form').send({ _csrf: h.extractCsrf(page.text) });
    expect(res.status).toBe(302);
    expect((await a1.get('/dashboard')).headers.location).toBe('/login');
    expect((await a2.get('/dashboard')).headers.location).toBe('/login');
    expect(await loginEvents.activeSessions('user', user.id)).toHaveLength(0);
    // The admin is still signed in
    expect((await agent.get('/admin')).status).toBe(200);
    const log = (await h.db.query("SELECT * FROM audit_logs WHERE action = 'customer.sessions_revoked'")).rows[0];
    expect(log).toMatchObject({ actor_id: admin.id, entity_id: user.id });
    expect(log.details.sessions_ended).toBe(2);
    expect((await events("event = 'forced_logout'"))[0]).toMatchObject({ user_id: user.id, identifier: `admin:${admin.username}` });
    const note = (await h.db.query("SELECT * FROM notifications WHERE user_id = $1 AND title = 'Signed out of all devices'", [user.id])).rows;
    expect(note).toHaveLength(1);
  });

  test('a customer + admin sharing one browser: only the customer part of the session is removed', async () => {
    const { user } = await h.makeUser();
    const admin = await h.makeAdmin('admin');
    const { agent: both } = await loginWith(user.username, UA.chromeWin);
    const p = await both.get('/admin/login');
    await both.post('/admin/login').type('form').send({ _csrf: h.extractCsrf(p.text), identifier: admin.username, password: 'AdminPassw0rd#1' });
    expect(await loginEvents.revokeUserSessions(user.id)).toBe(1);
    expect((await both.get('/dashboard')).headers.location).toBe('/login');
    expect((await both.get('/admin')).status).toBe(200);
  });

  test('customer "sign out other sessions" keeps the current one', async () => {
    const { user } = await h.makeUser();
    const { agent: other } = await loginWith(user.username, UA.safariIphone);
    const { agent: me } = await loginWith(user.username, UA.chromeWin);
    const profile = await me.get('/profile');
    expect(profile.text).toContain('Recent sign-ins');
    expect(profile.text).toContain('This device');
    const res = await me.post('/profile/sessions/revoke-others').type('form').send({ _csrf: h.extractCsrf(profile.text) });
    expect(res.headers.location).toBe('/profile#sign-ins');
    expect((await me.get('/dashboard')).status).toBe(200);
    expect((await other.get('/dashboard')).headers.location).toBe('/login');
    expect((await h.db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'user.sessions_revoked'")).rows[0].n).toBe(1);
    expect(await events("event = 'sessions_revoked'")).toHaveLength(1);
  });
});

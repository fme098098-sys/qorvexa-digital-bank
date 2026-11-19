'use strict';
const { body } = require('express-validator');
const db = require('../db/pool');
const admins = require('../services/adminService');
const users = require('../services/userService');
const txs = require('../services/transactionService');
const ledger = require('../services/ledgerService');
const support = require('../services/supportService');
const audit = require('../services/auditService');
const settings = require('../services/settingsService');
const loginEvents = require('../services/loginEventService');
const { collect, profileFields, password, COUNTRIES } = require('../middleware/validate');
const { parseAmountToCents, formatUSD } = require('../utils/money');
const { flash } = require('../utils/flash');
const { isUuid, notFound, pageNum } = require('../utils/http');
const { TYPE_LABELS } = require('../utils/format');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const actor = (req) => ({ type: 'admin', id: req.admin.id, label: req.admin.username });

// ---------------------------------------------------------------- dashboard
exports.dashboard = async (req, res) => {
  const [overview, totals, recentTx, recentLogs] = await Promise.all([
    admins.overview(), txs.systemTotals(), txs.list({ perPage: 8 }), audit.list({ perPage: 8 })]);
  const chart = {
    labels: overview.volume.map((v) => v.label),
    deposits: overview.volume.map((v) => v.deposits / 100),
    withdrawals: overview.volume.map((v) => v.withdrawals / 100),
    transfers: overview.volume.map((v) => v.transfers / 100),
    registrations: overview.registrations.map((r) => r.n),
  };
  res.render('admin/dashboard', { title: 'Admin dashboard', layout: 'layouts/admin', overview, totals, recentTx: recentTx.rows, recentLogs: recentLogs.rows, chart, TYPE_LABELS });
};

// ---------------------------------------------------------------- users
exports.users = async (req, res) => {
  const q = String(req.query.q || '').slice(0, 64);
  const status = ['active', 'suspended'].includes(req.query.status) ? req.query.status : '';
  const result = await users.search({ q, status, page: pageNum(req.query.page) });
  res.render('admin/users', { title: 'User management', layout: 'layouts/admin', result, q, status });
};

exports.newUserForm = (req, res) => res.render('admin/user-new', { title: 'Create customer', layout: 'layouts/admin', countries: COUNTRIES });

exports.createUserValidators = [
  ...profileFields,
  body('username').trim().matches(/^[A-Za-z0-9_.]{3,32}$/).withMessage('Username must be 3-32 characters: letters, numbers, dot or underscore.'),
  password('password'),
  body('accountType').isIn(['checking', 'savings', 'business']).withMessage('Choose an account type.'),
  body('openingDeposit').optional({ values: 'falsy' }).custom((v) => { parseAmountToCents(v); return true; }).withMessage('Opening deposit must be a valid USD amount.'),
  collect,
];

exports.createUser = async (req, res) => {
  const render = (errors, status) => res.status(status).render('admin/user-new', { title: 'Create customer', layout: 'layouts/admin', countries: COUNTRIES, errors, form: { ...req.body, password: '' } });
  if (req.validationErrors.length) return render(req.validationErrors, 422);
  try {
    const user = await db.withTransaction(async (client) => {
      const { user: u } = await users.createCustomer({
        fullName: req.body.fullName, email: req.body.email, phone: req.body.phone, username: req.body.username,
        password: req.body.password, country: req.body.country, accountType: req.body.accountType,
      }, { createdByAdmin: req.admin, req, client });
      if (req.body.openingDeposit) {
        // Opening balance is posted as a ledgered, admin-approved deposit request (fully auditable).
        const { request } = await ledger.createDepositRequest({ userId: u.id, amountCents: parseAmountToCents(req.body.openingDeposit), method: 'simulated_cash', note: `Opening deposit by ${req.admin.username}`, req, client });
        await ledger.reviewDepositRequest({ requestId: request.id, decision: 'approve', note: 'Opening deposit at account creation', admin: req.admin, req, client });
      }
      return u;
    });
    flash(req, 'success', `Customer ${user.full_name} created.`);
    res.redirect(`/admin/users/${user.id}`);
  } catch (e) {
    if (!e.expose) throw e;
    render([e.message], e.status || 400);
  }
};

async function renderUser(req, res, { errors = [], status = 200, form = null } = {}) {
  if (!isUuid(req.params.id)) throw notFound();
  const user = await users.getById(req.params.id);
  if (!user) throw notFound();
  const account = await users.getPrimaryAccount(user.id);
  const [recent, stats, deposits, logs] = await Promise.all([
    txs.list({ accountId: account.id, perPage: 15 }),
    txs.dashboardStats(account.id),
    ledger.listDepositRequests({ userId: user.id, perPage: 10 }),
    db.query(`SELECT * FROM audit_logs WHERE entity_id = $1::text OR actor_id = $1::uuid ORDER BY created_at DESC LIMIT 15`, [user.id]),
  ]);
  // Sign-in data (IP addresses, devices) is limited to operations staff.
  const canSeeLogins = req.admin.role !== 'support';
  const [loginActivity, sessions] = canSeeLogins
    ? await Promise.all([loginEvents.forUser(user.id, 25), loginEvents.activeSessions('user', user.id)])
    : [[], []];
  res.status(status).render('admin/user-detail', {
    title: user.full_name, layout: 'layouts/admin', user, account, recent: recent.rows, stats, deposits: deposits.rows,
    logs: logs.rows, countries: COUNTRIES, errors, form: form || user, TYPE_LABELS, canSeeLogins, loginActivity, sessions });
}
exports.userDetail = (req, res) => renderUser(req, res);

exports.editUserValidators = [...profileFields, collect];
exports.editUser = async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const form = { full_name: req.body.fullName, email: req.body.email, phone: req.body.phone, country: req.body.country };
  if (req.validationErrors.length) return renderUser(req, res, { errors: req.validationErrors, status: 422, form });
  try {
    await users.updateProfile(req.params.id, req.body, actor(req), req);
  } catch (e) {
    if (!e.expose) throw e;
    return renderUser(req, res, { errors: [e.message], status: e.status || 400, form });
  }
  flash(req, 'success', 'Customer profile updated and recorded in the audit log.');
  res.redirect(`/admin/users/${req.params.id}`);
};

exports.statusValidators = [
  body('status').isIn(['active', 'suspended']).withMessage('Invalid status.'),
  body('reason').trim().isLength({ min: 3, max: 200 }).withMessage('Please give a reason (3-200 characters); it is recorded in the audit log.'),
  collect,
];
exports.setStatus = async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  if (req.validationErrors.length) { flash(req, 'error', req.validationErrors.join(' ')); return res.redirect(`/admin/users/${req.params.id}`); }
  try {
    await users.setStatus(req.params.id, req.body.status, req.body.reason, req.admin, req);
    flash(req, 'success', req.body.status === 'active' ? 'Account reactivated.' : 'Account suspended and active sessions ended.');
  } catch (e) {
    if (!e.expose) throw e;
    flash(req, 'error', e.message);
  }
  res.redirect(`/admin/users/${req.params.id}`);
};

exports.revokeSessions = async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const user = await users.getById(req.params.id);
  if (!user) throw notFound();
  const ended = await db.withTransaction(async (client) => {
    const n = await loginEvents.revokeUserSessions(user.id, {}, client);
    await loginEvents.record({ actorType: 'user', userId: user.id, identifier: `admin:${req.admin.username}`, event: 'forced_logout', success: true, req }, client);
    await audit.log({ actorType: 'admin', actorId: req.admin.id, actorLabel: req.admin.username, action: 'customer.sessions_revoked', entityType: 'user', entityId: user.id, details: { username: user.username, sessions_ended: n }, req }, client);
    await require('../services/notificationService').create(user.id, { category: 'security', title: 'Signed out of all devices', body: 'Qorvexa staff signed you out of all active sessions. Sign in again to continue.', link: '/profile#sign-ins' }, client);
    return n;
  });
  flash(req, 'success', `Signed ${user.full_name} out of ${ended} active session${ended === 1 ? '' : 's'}. Recorded in the audit log.`);
  res.redirect(`/admin/users/${user.id}#sessions`);
};

// ---------------------------------------------------------------- login activity
exports.loginActivity = async (req, res) => {
  const filters = {
    q: String(req.query.q || '').slice(0, 64),
    status: ['success', 'failed'].includes(req.query.status) ? req.query.status : '',
    actorType: ['user', 'admin'].includes(req.query.actor) ? req.query.actor : '',
    event: loginEvents.EVENTS.includes(req.query.event) ? req.query.event : '',
    from: DATE_RE.test(req.query.from || '') ? req.query.from : '',
    to: DATE_RE.test(req.query.to || '') ? req.query.to : '',
    newOnly: req.query.new === '1',
  };
  const [result, hotspots, counts] = await Promise.all([
    loginEvents.list({ ...filters, page: pageNum(req.query.page), perPage: 50 }),
    loginEvents.failedHotspots(), loginEvents.alertCounts()]);
  res.render('admin/login-activity', {
    title: 'Login activity', layout: 'layouts/admin', result, filters, hotspots, counts, EVENTS: loginEvents.EVENTS, displayTz: process.env.DISPLAY_TIMEZONE || 'UTC',
    query: { q: filters.q, status: filters.status, actor: filters.actorType, event: filters.event, from: filters.from, to: filters.to, new: filters.newOnly ? '1' : '' },
  });
};

// ---------------------------------------------------------------- transactions
exports.transactions = async (req, res) => {
  const filters = {
    q: String(req.query.q || '').slice(0, 64),
    type: txs.TYPES.includes(req.query.type) ? req.query.type : '',
    from: DATE_RE.test(req.query.from || '') ? req.query.from : '',
    to: DATE_RE.test(req.query.to || '') ? req.query.to : '',
  };
  const result = await txs.list({ ...filters, page: pageNum(req.query.page), perPage: 25 });
  const totals = await txs.systemTotals();
  res.render('admin/transactions', { title: 'Transaction management', layout: 'layouts/admin', result, filters, totals, TYPE_LABELS });
};

exports.transactionDetail = async (req, res) => {
  const legs = await txs.getByReference(String(req.params.reference).slice(0, 24));
  if (!legs.length) throw notFound();
  let depositRequest = null;
  if (legs[0].deposit_request_id) {
    depositRequest = (await db.query('SELECT d.*, a.username AS reviewer FROM deposit_requests d LEFT JOIN admin_users a ON a.id = d.reviewed_by WHERE d.id = $1', [legs[0].deposit_request_id])).rows[0];
  }
  res.render('admin/transaction-detail', { title: `Transaction ${legs[0].reference}`, layout: 'layouts/admin', legs, depositRequest, TYPE_LABELS });
};

// ---------------------------------------------------------------- deposit requests
exports.deposits = async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : (req.query.status === 'all' ? '' : 'pending');
  const result = await ledger.listDepositRequests({ status, page: pageNum(req.query.page) });
  res.render('admin/deposits', { title: 'Deposit requests', layout: 'layouts/admin', result, status: status || 'all' });
};
exports.reviewValidators = [
  body('decision').isIn(['approve', 'reject']).withMessage('Invalid decision.'),
  body('note').optional({ values: 'falsy' }).trim().isLength({ max: 200 }).withMessage('Note must be at most 200 characters.'),
  collect,
];
exports.reviewDeposit = async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  if (req.validationErrors.length) { flash(req, 'error', req.validationErrors.join(' ')); return res.redirect('/admin/deposits'); }
  if (req.body.decision === 'reject' && !req.body.note) { flash(req, 'error', 'Please give a reason when rejecting a deposit request.'); return res.redirect('/admin/deposits'); }
  try {
    const r = await ledger.reviewDepositRequest({ requestId: req.params.id, decision: req.body.decision, note: req.body.note, admin: req.admin, req });
    flash(req, 'success', r.status === 'approved'
      ? `Deposit ${r.request.reference} approved: ${formatUSD(r.request.amount_cents)} credited.`
      : `Deposit ${r.request.reference} rejected.`);
  } catch (e) {
    if (!e.expose) throw e;
    flash(req, 'error', e.message);
  }
  res.redirect('/admin/deposits');
};

// ---------------------------------------------------------------- support
exports.supportList = async (req, res) => {
  const status = support.STATUSES.includes(req.query.status) ? req.query.status : '';
  const q = String(req.query.q || '').slice(0, 64);
  const result = await support.list({ status, q, page: pageNum(req.query.page) });
  res.render('admin/support', { title: 'Support management', layout: 'layouts/admin', result, status, q });
};
exports.supportDetail = async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const ticket = await support.get(req.params.id);
  if (!ticket) throw notFound();
  res.render('admin/support-detail', { title: `Ticket ${ticket.ticket_number}`, layout: 'layouts/admin', ticket, statuses: support.STATUSES });
};
exports.supportValidators = [
  body('status').isIn(support.STATUSES).withMessage('Invalid status.'),
  body('priority').isIn(['low', 'normal', 'high']).withMessage('Invalid priority.'),
  body('response').optional({ values: 'falsy' }).trim().isLength({ max: 4000 }).withMessage('Response must be at most 4000 characters.'),
  collect,
];
exports.updateTicket = async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  if (req.validationErrors.length) { flash(req, 'error', req.validationErrors.join(' ')); return res.redirect(`/admin/support/${req.params.id}`); }
  await support.update(req.params.id, { status: req.body.status, priority: req.body.priority, response: req.body.response }, req.admin, req);
  flash(req, 'success', 'Ticket updated.');
  res.redirect(`/admin/support/${req.params.id}`);
};

// ---------------------------------------------------------------- audit logs
exports.auditLogs = async (req, res) => {
  const actorType = ['admin', 'user', 'system', 'guest'].includes(req.query.actor) ? req.query.actor : '';
  const q = String(req.query.q || '').slice(0, 64);
  const result = await audit.list({ actorType, q, page: pageNum(req.query.page), perPage: 50 });
  res.render('admin/audit-logs', { title: 'System activity logs', layout: 'layouts/admin', result, actorType, q });
};

// ---------------------------------------------------------------- settings
exports.settings = async (req, res) => {
  const all = await settings.getAll();
  res.render('admin/settings', { title: 'System settings', layout: 'layouts/admin', all, canEdit: req.admin.role === 'super_admin' });
};
exports.updateSettings = async (req, res) => {
  const changes = {};
  try {
    for (const key of settings.NUMERIC_KEYS) if (req.body[key] !== undefined) changes[key] = parseAmountToCents(req.body[key]);
  } catch (e) {
    flash(req, 'error', 'Limits must be valid USD amounts.');
    return res.redirect('/admin/settings');
  }
  changes.registration_open = req.body.registration_open === 'on';
  changes.maintenance_banner = req.body.maintenance_banner || '';
  try {
    const applied = await settings.update(req.admin, changes, req);
    const n = Object.keys(applied).length;
    flash(req, 'success', n ? `${n} setting${n === 1 ? '' : 's'} updated and recorded in the audit log.` : 'No changes to save.');
  } catch (e) {
    if (!e.expose) throw e;
    flash(req, 'error', e.message);
  }
  res.redirect('/admin/settings');
};

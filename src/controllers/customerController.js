'use strict';
const { body } = require('express-validator');
const db = require('../db/pool');
const users = require('../services/userService');
const audit = require('../services/auditService');
const loginEvents = require('../services/loginEventService');
const txs = require('../services/transactionService');
const notifications = require('../services/notificationService');
const beneficiaries = require('../services/beneficiaryService');
const support = require('../services/supportService');
const pdf = require('../services/pdfService');
const { collect, password, profileFields, COUNTRIES } = require('../middleware/validate');
const { flash } = require('../utils/flash');
const { isUuid, notFound, pageNum } = require('../utils/http');
const { TYPE_LABELS } = require('../utils/format');

const REF_RE = /^[A-Z]{3}\d{8}[A-Z0-9]{8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- dashboard
exports.dashboard = async (req, res) => {
  const account = await users.getPrimaryAccount(req.user.id);
  const [stats, recent] = await Promise.all([
    txs.dashboardStats(account.id),
    txs.list({ accountId: account.id, perPage: 6 }),
  ]);
  const chart = {
    labels: stats.monthly.map((m) => m.label),
    credits: stats.monthly.map((m) => m.credits / 100),
    debits: stats.monthly.map((m) => m.debits / 100),
  };
  res.render('customer/dashboard', { title: 'Dashboard', layout: 'layouts/app', account, stats, recent: recent.rows, chart });
};

// ---------------------------------------------------------------- history
function historyFilters(q) {
  return {
    q: q.q ? String(q.q).slice(0, 64) : '',
    type: txs.TYPES.includes(q.type) ? q.type : '',
    from: DATE_RE.test(q.from || '') ? q.from : '',
    to: DATE_RE.test(q.to || '') ? q.to : '',
  };
}

exports.history = async (req, res) => {
  const account = await users.getPrimaryAccount(req.user.id);
  const filters = historyFilters(req.query);
  const result = await txs.list({ ...filters, accountId: account.id, page: pageNum(req.query.page), perPage: 20 });
  res.render('customer/transactions', { title: 'Transaction history', layout: 'layouts/app', account, filters, result, TYPE_LABELS });
};

exports.exportCsv = async (req, res) => {
  const account = await users.getPrimaryAccount(req.user.id);
  const filters = historyFilters(req.query);
  const result = await txs.list({ ...filters, accountId: account.id, page: 1, perPage: 100 });
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [['Date', 'Reference', 'Type', 'Description', 'Counterparty', 'Amount (USD)', 'Balance after (USD)'].map(esc).join(',')];
  for (const t of result.rows) {
    lines.push([t.created_at.toISOString(), t.reference, TYPE_LABELS[t.type], t.description, t.counterparty_name,
      ((t.direction === 'debit' ? -1 : 1) * t.amount_cents / 100).toFixed(2), (t.balance_after_cents / 100).toFixed(2)].map(esc).join(','));
  }
  lines.push(esc('Educational software project - all balances and transactions are simulated. Not a real bank.'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="qorvexa-transactions.csv"');
  res.send(lines.join('\r\n'));
};

async function loadOwnTx(req) {
  if (!REF_RE.test(req.params.reference)) throw notFound();
  const account = await users.getPrimaryAccount(req.user.id);
  const tx = await txs.getForAccount(account.id, req.params.reference);
  if (!tx) throw notFound();
  return { account, tx };
}

exports.transactionDetail = async (req, res) => {
  const { account, tx } = await loadOwnTx(req);
  res.render('customer/transaction', { title: `Transaction ${tx.reference}`, layout: 'layouts/app', account, tx, TYPE_LABELS, isReceipt: req.query.receipt === '1' });
};

exports.receiptPdf = async (req, res) => {
  const { tx } = await loadOwnTx(req);
  pdf.receipt(res, tx);
};

// ---------------------------------------------------------------- statements
function statementRange(q) {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let from = DATE_RE.test(q.from || '') ? q.from : iso(first);
  let to = DATE_RE.test(q.to || '') ? q.to : iso(today);
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

exports.statements = async (req, res) => {
  const account = await users.getPrimaryAccount(req.user.id);
  const { from, to } = statementRange(req.query);
  const data = await txs.statement(account.id, from, to);
  res.render('customer/statements', { title: 'Account statement', layout: 'layouts/app', account, from, to, data, TYPE_LABELS });
};

exports.statementPdf = async (req, res) => {
  const account = await users.getPrimaryAccount(req.user.id);
  const { from, to } = statementRange(req.query);
  const data = await txs.statement(account.id, from, to);
  pdf.statement(res, { user: req.user, account, from, to, data });
};

// ---------------------------------------------------------------- profile
async function securityData(req) {
  const [signIns, sessions] = await Promise.all([loginEvents.forUser(req.user.id, 10), loginEvents.activeSessions('user', req.user.id)]);
  return { signIns, sessions, currentSid: req.sessionID };
}
exports.profile = async (req, res) => {
  const account = await users.getPrimaryAccount(req.user.id);
  res.render('customer/profile', { title: 'Profile settings', layout: 'layouts/app', account, countries: COUNTRIES, form: req.user, pwErrors: [], ...(await securityData(req)) });
};
exports.revokeOtherSessions = async (req, res) => {
  const ended = await db.withTransaction(async (client) => {
    const n = await loginEvents.revokeUserSessions(req.user.id, { exceptSid: req.sessionID }, client);
    await loginEvents.record({ actorType: 'user', userId: req.user.id, identifier: req.user.username, event: 'sessions_revoked', success: true, req, sessionId: req.sessionID }, client);
    await audit.log({ actorType: 'user', actorId: req.user.id, actorLabel: req.user.username, action: 'user.sessions_revoked', details: { sessions_ended: n }, req }, client);
    return n;
  });
  flash(req, 'success', ended ? `Signed out of ${ended} other session${ended === 1 ? '' : 's'}.` : 'No other active sessions were found.');
  res.redirect('/profile#sign-ins');
};
exports.profileValidators = [...profileFields, collect];
exports.updateProfile = async (req, res) => {
  const account = await users.getPrimaryAccount(req.user.id);
  const render = async (errors, status) => res.status(status).render('customer/profile', { title: 'Profile settings', layout: 'layouts/app', account, countries: COUNTRIES, form: { ...req.user, full_name: req.body.fullName, email: req.body.email, phone: req.body.phone, country: req.body.country }, errors, pwErrors: [], ...(await securityData(req)) });
  if (req.validationErrors.length) return render(req.validationErrors, 422);
  try {
    await users.updateProfile(req.user.id, req.body, { type: 'user', id: req.user.id, label: req.user.username }, req);
  } catch (e) {
    if (!e.expose) throw e;
    return render([e.message], e.status || 400);
  }
  flash(req, 'success', 'Your profile has been updated.');
  res.redirect('/profile');
};
exports.passwordValidators = [
  body('currentPassword').notEmpty().withMessage('Enter your current password.'),
  password('newPassword'),
  body('confirmPassword').custom((v, { req }) => v === req.body.newPassword).withMessage('New passwords do not match.'),
  collect,
];
exports.changePassword = async (req, res) => {
  const account = await users.getPrimaryAccount(req.user.id);
  const render = async (pwErrors, status) => res.status(status).render('customer/profile', { title: 'Profile settings', layout: 'layouts/app', account, countries: COUNTRIES, form: req.user, pwErrors, ...(await securityData(req)) });
  if (req.validationErrors.length) return render(req.validationErrors, 422);
  try {
    await users.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword, req);
  } catch (e) {
    if (!e.expose) throw e;
    return render([e.message], e.status || 400);
  }
  flash(req, 'success', 'Your password has been changed.');
  res.redirect('/profile');
};

// ---------------------------------------------------------------- notifications
exports.notifications = async (req, res) => {
  const filter = req.query.filter === 'unread' ? 'unread' : 'all';
  const items = await notifications.list(req.user.id, { unreadOnly: filter === 'unread' });
  res.render('customer/notifications', { title: 'Notifications', layout: 'layouts/app', items, filter });
};
exports.markRead = async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  await notifications.markRead(req.user.id, req.params.id);
  const n = (await notifications.list(req.user.id)).find((x) => x.id === req.params.id);
  if (req.body.go === '1' && n && n.link && n.link.startsWith('/')) return res.redirect(n.link);
  res.redirect('/notifications');
};
exports.markAllRead = async (req, res) => {
  const n = await notifications.markAllRead(req.user.id);
  flash(req, 'success', n ? `${n} notification${n === 1 ? '' : 's'} marked as read.` : 'You have no unread notifications.');
  res.redirect('/notifications');
};
exports.deleteNotification = async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const n = await notifications.remove(req.user.id, req.params.id);
  flash(req, n ? 'success' : 'error', n ? 'Notification deleted.' : 'Notification not found.');
  res.redirect('/notifications');
};

// ---------------------------------------------------------------- beneficiaries
async function renderBeneficiaries(req, res, { errors = [], form = {}, status = 200 } = {}) {
  const items = await beneficiaries.list(req.user.id);
  res.status(status).render('customer/beneficiaries', { title: 'Beneficiaries', layout: 'layouts/app', items, errors, form });
}
exports.beneficiaries = (req, res) => renderBeneficiaries(req, res);
exports.beneficiaryValidators = [
  body('identifier').trim().isLength({ min: 3, max: 32 }).withMessage('Enter an account number or username.'),
  body('nickname').optional({ values: 'falsy' }).trim().isLength({ max: 60 }).withMessage('Nickname must be at most 60 characters.'),
  collect,
];
exports.addBeneficiary = async (req, res) => {
  if (req.validationErrors.length) return renderBeneficiaries(req, res, { errors: req.validationErrors, form: req.body, status: 422 });
  try {
    const { recipient } = await beneficiaries.add(req.user, req.body.identifier, req.body.nickname, req);
    flash(req, 'success', `${recipient.full_name} (${recipient.account_number}) was added to your beneficiaries.`);
    res.redirect('/beneficiaries');
  } catch (e) {
    if (!e.expose) throw e;
    renderBeneficiaries(req, res, { errors: [e.message], form: req.body, status: e.status || 400 });
  }
};
exports.removeBeneficiary = async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  await beneficiaries.remove(req.user, req.params.id, req);
  flash(req, 'success', 'Beneficiary removed.');
  res.redirect('/beneficiaries');
};

// ---------------------------------------------------------------- support (customer)
async function renderSupport(req, res, { errors = [], form = {}, status = 200 } = {}) {
  const tickets = await support.listForUser(req.user.id);
  res.status(status).render('customer/support', { title: 'Support centre', layout: 'layouts/app', tickets, errors, form, categories: support.CATEGORIES });
}
exports.support = (req, res) => renderSupport(req, res);
exports.supportValidators = [
  body('subject').trim().isLength({ min: 3, max: 140 }).withMessage('Enter a subject (3-140 characters).'),
  body('category').isIn(support.CATEGORIES).withMessage('Choose a topic.'),
  body('message').trim().isLength({ min: 10, max: 4000 }).withMessage('Your message should be 10-4000 characters.'),
  collect,
];
exports.createTicket = async (req, res) => {
  if (req.validationErrors.length) return renderSupport(req, res, { errors: req.validationErrors, form: req.body, status: 422 });
  const t = await support.create({ user: req.user, subject: req.body.subject, category: req.body.category, message: req.body.message, req });
  flash(req, 'success', `Support ticket ${t.ticket_number} created. We'll respond here and notify you.`);
  res.redirect('/support');
};

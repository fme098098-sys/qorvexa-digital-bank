'use strict';
const { body } = require('express-validator');
const config = require('../config');
const users = require('../services/userService');
const admins = require('../services/adminService');
const settings = require('../services/settingsService');
const audit = require('../services/auditService');
const { collect, password, COUNTRIES } = require('../middleware/validate');
const { flash } = require('../utils/flash');

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
}
function save(req) {
  return new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
}

// ---------------------------------------------------------------- customer login
exports.loginForm = (req, res) => res.render('auth/login', { title: 'Sign in', layout: 'layouts/auth' });

exports.login = async (req, res) => {
  const { identifier, password: pw, remember } = req.body;
  try {
    const user = await users.authenticate(identifier, pw, req);
    const returnTo = req.session.returnTo;
    const adminId = req.session.adminId; // keep a concurrent admin session if present
    await regenerate(req);
    req.session.userId = user.id;
    if (adminId) req.session.adminId = adminId;
    if (remember) req.session.cookie.maxAge = config.rememberMeDays * 24 * 60 * 60 * 1000;
    req.session.remember = Boolean(remember);
    req.session.flash = { type: 'success', message: `Welcome back, ${user.full_name.split(' ')[0]}.` };
    await save(req);
    res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/dashboard');
  } catch (e) {
    if (!e.expose) throw e;
    res.status(e.status || 401).render('auth/login', { title: 'Sign in', errors: [e.message], form: { identifier }, layout: 'layouts/auth' });
  }
};

exports.logout = async (req, res) => {
  if (req.user) await audit.log({ actorType: 'user', actorId: req.user.id, actorLabel: req.user.username, action: 'auth.logout', req });
  delete req.session.userId;
  delete req.session.transferDraft;
  req.session.flash = { type: 'success', message: 'You have been signed out securely.' };
  res.redirect('/login');
};

// ---------------------------------------------------------------- registration
exports.registerForm = async (req, res) => {
  const s = await settings.getMap();
  res.render('auth/register', { title: 'Open an account', countries: COUNTRIES, registrationOpen: s.registration_open, layout: 'layouts/auth' });
};

exports.register = async (req, res) => {
  const s = await settings.getMap();
  const render = (status, errors) => res.status(status).render('auth/register', {
    title: 'Open an account', countries: COUNTRIES, registrationOpen: s.registration_open, errors,
    form: { ...req.body, password: '', confirmPassword: '' }, layout: 'layouts/auth' });
  if (!s.registration_open) return render(403, ['Online registration is currently closed.']);
  if (req.validationErrors.length) return render(422, req.validationErrors);
  if (!req.body.terms) return render(422, ['Please confirm you understand that Qorvexa is an educational platform using simulated funds.']);
  try {
    const { user, account } = await users.createCustomer({
      fullName: req.body.fullName, email: req.body.email, phone: req.body.phone, username: req.body.username,
      password: req.body.password, country: req.body.country, accountType: req.body.accountType,
    }, { req });
    await regenerate(req);
    req.session.userId = user.id;
    req.session.flash = { type: 'success', message: `Your account ${account.account_number} is ready. Welcome to Qorvexa, ${user.full_name.split(' ')[0]}!` };
    await save(req);
    res.redirect('/dashboard');
  } catch (e) {
    if (!e.expose) throw e;
    render(e.status || 400, [e.message]);
  }
};

// ---------------------------------------------------------------- forgot / reset password
exports.forgotForm = (req, res) => res.render('auth/forgot', { title: 'Forgot password', layout: 'layouts/auth' });

exports.forgotValidators = [body('email').trim().isEmail().withMessage('Enter a valid email address.'), collect];

exports.forgot = async (req, res) => {
  if (req.validationErrors.length) {
    return res.status(422).render('auth/forgot', { title: 'Forgot password', errors: req.validationErrors, form: req.body, layout: 'layouts/auth' });
  }
  await users.requestPasswordReset(req.body.email, req);
  flash(req, 'success', 'If an account is registered with that email address, a password reset link valid for 30 minutes has been sent to it.');
  res.redirect('/forgot-password');
};

exports.resetForm = async (req, res) => {
  const valid = await users.validateResetToken(req.params.token);
  res.render('auth/reset', { title: 'Choose a new password', token: req.params.token, valid: Boolean(valid), layout: 'layouts/auth' });
};

exports.resetValidators = [password('password'), body('confirmPassword').custom((v, { req }) => v === req.body.password).withMessage('Passwords do not match.'), collect];

exports.reset = async (req, res) => {
  const render = (errors, status = 422) => res.status(status).render('auth/reset', { title: 'Choose a new password', token: req.params.token, valid: true, errors, layout: 'layouts/auth' });
  if (req.validationErrors.length) return render(req.validationErrors);
  try {
    await users.resetPassword(req.params.token, req.body.password, req);
  } catch (e) {
    if (!e.expose) throw e;
    return render([e.message], 400);
  }
  flash(req, 'success', 'Your password has been reset. You can now sign in.');
  res.redirect('/login');
};

// ---------------------------------------------------------------- admin login
exports.adminLoginForm = (req, res) => {
  if (req.admin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Administrator sign in', layout: 'layouts/auth' });
};

exports.adminLogin = async (req, res) => {
  try {
    const admin = await admins.authenticate(req.body.identifier, req.body.password, req);
    const userId = req.session.userId;
    await regenerate(req);
    req.session.adminId = admin.id;
    if (userId) req.session.userId = userId;
    req.session.flash = { type: 'success', message: `Signed in as ${admin.full_name} (${admin.role.replace('_', ' ')}).` };
    await save(req);
    res.redirect('/admin');
  } catch (e) {
    if (!e.expose) throw e;
    res.status(e.status || 401).render('admin/login', { title: 'Administrator sign in', errors: [e.message], form: { identifier: req.body.identifier }, layout: 'layouts/auth' });
  }
};

exports.adminLogout = async (req, res) => {
  if (req.admin) await audit.log({ actorType: 'admin', actorId: req.admin.id, actorLabel: req.admin.username, action: 'admin.logout', req });
  delete req.session.adminId;
  req.session.flash = { type: 'success', message: 'Administrator session ended.' };
  res.redirect('/admin/login');
};

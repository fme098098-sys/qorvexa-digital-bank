'use strict';
/** Authentication + role-based authorization middleware. */
const userService = require('../services/userService');
const adminService = require('../services/adminService');
const notifications = require('../services/notificationService');

/** Loads the signed-in customer and admin (if any) on every request. */
async function loadPrincipals(req, res, next) {
  try {
    res.locals.currentUser = null;
    res.locals.currentAdmin = null;
    if (req.session.userId) {
      const user = await userService.getById(req.session.userId);
      if (!user || user.status !== 'active') {
        delete req.session.userId;
        if (user && user.status !== 'active') req.session.flash = { type: 'error', message: 'Your account is suspended. Please contact support.' };
      } else {
        req.user = user;
        res.locals.currentUser = user;
        res.locals.unreadCount = await notifications.unreadCount(user.id);
      }
    }
    if (req.session.adminId) {
      const admin = await adminService.getById(req.session.adminId);
      if (!admin || !admin.is_active) delete req.session.adminId;
      else { req.admin = admin; res.locals.currentAdmin = admin; }
    }
    next();
  } catch (e) { next(e); }
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.accepts(['html', 'json']) === 'json' && !req.accepts('html')) return res.status(401).json({ error: 'Authentication required' });
  req.session.returnTo = req.method === 'GET' ? req.originalUrl : undefined;
  return res.redirect('/login');
}

function redirectIfUser(req, res, next) {
  if (req.user) return res.redirect('/dashboard');
  next();
}

function requireAdmin(...roles) {
  return (req, res, next) => {
    if (!req.admin) return res.redirect('/admin/login');
    if (roles.length && !roles.includes(req.admin.role)) {
      const err = new Error('You do not have permission to perform this action.');
      err.status = 403; err.expose = true;
      return next(err);
    }
    next();
  };
}

module.exports = { loadPrincipals, requireUser, redirectIfUser, requireAdmin };

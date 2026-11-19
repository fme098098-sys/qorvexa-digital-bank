'use strict';
const router = require('express').Router();
const a = require('../controllers/authController');
const c = require('../controllers/adminController');
const { requireAdmin } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

// Separate, protected administrator login.
router.get('/login', a.adminLoginForm);
router.post('/login', authLimiter, a.adminLogin);
router.post('/logout', a.adminLogout);

const ANY = requireAdmin('super_admin', 'admin', 'support');
const OPS = requireAdmin('super_admin', 'admin');
const SUPER = requireAdmin('super_admin');

router.get('/', ANY, c.dashboard);

router.get('/users', ANY, c.users);
router.get('/users/new', OPS, c.newUserForm);
router.post('/users', OPS, c.createUserValidators, c.createUser);
router.get('/users/:id', ANY, c.userDetail);
router.post('/users/:id/edit', OPS, c.editUserValidators, c.editUser);
router.post('/users/:id/status', OPS, c.statusValidators, c.setStatus);

router.get('/transactions', OPS, c.transactions);
router.get('/transactions/:reference', OPS, c.transactionDetail);

router.get('/deposits', OPS, c.deposits);
router.post('/deposits/:id/review', OPS, c.reviewValidators, c.reviewDeposit);

router.get('/support', ANY, c.supportList);
router.get('/support/:id', ANY, c.supportDetail);
router.post('/support/:id', ANY, c.supportValidators, c.updateTicket);

router.get('/audit-logs', OPS, c.auditLogs);

router.get('/settings', OPS, c.settings);
router.post('/settings', SUPER, c.updateSettings);

module.exports = router;

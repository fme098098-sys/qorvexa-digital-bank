'use strict';
const router = require('express').Router();
const c = require('../controllers/authController');
const { redirectIfUser } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { registration } = require('../middleware/validate');

router.get('/login', redirectIfUser, c.loginForm);
router.post('/login', authLimiter, c.login);
router.post('/logout', c.logout);
router.get('/register', redirectIfUser, c.registerForm);
router.post('/register', authLimiter, registration, c.register);
router.get('/forgot-password', c.forgotForm);
router.post('/forgot-password', authLimiter, c.forgotValidators, c.forgot);
router.get('/reset-password/:token', c.resetForm);
router.post('/reset-password/:token', authLimiter, c.resetValidators, c.reset);

module.exports = router;

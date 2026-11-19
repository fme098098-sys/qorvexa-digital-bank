'use strict';
const router = require('express').Router();
const c = require('../controllers/publicController');
const { authLimiter } = require('../middleware/rateLimit');

router.get('/', c.home);
router.get('/about', c.about);
router.get('/contact', c.contact);
router.post('/contact', authLimiter, c.contactValidators, c.submitContact);
router.get('/healthz', (req, res) => res.json({ status: 'ok' }));

module.exports = router;

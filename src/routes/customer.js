'use strict';
const router = require('express').Router();
const c = require('../controllers/customerController');
const b = require('../controllers/bankingController');
const { requireUser } = require('../middleware/auth');
const { sensitiveLimiter } = require('../middleware/rateLimit');
const v = require('../middleware/validate');

const U = requireUser;

router.get('/dashboard', U, c.dashboard);

router.get('/transfer', U, b.transferForm);
router.get('/api/recipient', U, sensitiveLimiter, b.lookupRecipient);
router.post('/transfer/review', U, sensitiveLimiter, v.transfer, b.reviewTransfer);
router.post('/transfer/confirm', U, sensitiveLimiter, b.confirmTransfer);

router.get('/deposit', U, b.depositForm);
router.post('/deposit', U, sensitiveLimiter, b.depositValidators, b.deposit);
router.get('/withdraw', U, b.withdrawForm);
router.post('/withdraw', U, sensitiveLimiter, b.withdrawValidators, b.withdraw);

router.get('/transactions', U, c.history);
router.get('/transactions/export.csv', U, c.exportCsv);
router.get('/transactions/:reference', U, c.transactionDetail);
router.get('/transactions/:reference/receipt.pdf', U, c.receiptPdf);

router.get('/statements', U, c.statements);
router.get('/statements/download', U, c.statementPdf);

router.get('/profile', U, c.profile);
router.post('/profile', U, c.profileValidators, c.updateProfile);
router.post('/profile/password', U, sensitiveLimiter, c.passwordValidators, c.changePassword);
router.post('/profile/sessions/revoke-others', U, sensitiveLimiter, c.revokeOtherSessions);

router.get('/notifications', U, c.notifications);
router.post('/notifications/read-all', U, c.markAllRead);
router.post('/notifications/:id/read', U, c.markRead);
router.post('/notifications/:id/delete', U, c.deleteNotification);

router.get('/beneficiaries', U, c.beneficiaries);
router.post('/beneficiaries', U, sensitiveLimiter, c.beneficiaryValidators, c.addBeneficiary);
router.post('/beneficiaries/:id/delete', U, c.removeBeneficiary);

router.get('/support', U, c.support);
router.post('/support', U, sensitiveLimiter, c.supportValidators, c.createTicket);

module.exports = router;

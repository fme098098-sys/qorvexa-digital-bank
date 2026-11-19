'use strict';
const crypto = require('crypto');
const { body } = require('express-validator');
const ledger = require('../services/ledgerService');
const users = require('../services/userService');
const beneficiaries = require('../services/beneficiaryService');
const settings = require('../services/settingsService');
const db = require('../db/pool');
const { collect, amountField } = require('../middleware/validate');
const { parseAmountToCents, formatUSD } = require('../utils/money');
const { flash } = require('../utils/flash');

const newKey = () => crypto.randomUUID();

// ---------------------------------------------------------------- transfers
async function renderTransferForm(req, res, { errors = [], form = {}, status = 200 } = {}) {
  const account = await users.getPrimaryAccount(req.user.id);
  const [bens, limits] = await Promise.all([beneficiaries.list(req.user.id), settings.getMap()]);
  res.status(status).render('customer/transfer', {
    title: 'Transfer funds', layout: 'layouts/app', account, beneficiaries: bens, limits, errors,
    form: { recipient: req.query.to || '', ...form },
  });
}

exports.transferForm = (req, res) => renderTransferForm(req, res);

/** JSON name-enquiry used by the transfer and beneficiary forms. */
exports.lookupRecipient = async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3 || q.length > 32) return res.status(400).json({ error: 'Enter at least 3 characters.' });
  const r = await users.findRecipient(q);
  if (!r) return res.status(404).json({ error: 'No Qorvexa account matches that account number or username.' });
  if (r.user_id === req.user.id) return res.status(400).json({ error: 'That is your own account.' });
  if (r.user_status !== 'active' || r.account_status !== 'active') return res.status(422).json({ error: 'This account cannot receive transfers at the moment.' });
  res.json({ name: r.full_name, accountNumber: r.account_number });
};

exports.reviewTransfer = async (req, res) => {
  if (req.validationErrors.length) return renderTransferForm(req, res, { errors: req.validationErrors, form: req.body, status: 422 });
  const amountCents = parseAmountToCents(req.body.amount);
  const account = await users.getPrimaryAccount(req.user.id);
  const r = await users.findRecipient(req.body.recipient);
  const errors = [];
  if (!r) errors.push('Recipient account not found. Check the account number or username.');
  else if (r.user_id === req.user.id) errors.push('You cannot transfer money to your own account.');
  else if (r.user_status !== 'active' || r.account_status !== 'active') errors.push('The recipient account cannot receive transfers at this time.');
  if (amountCents > account.balance_cents - account.hold_cents) errors.push(`Insufficient funds. Your available balance is ${formatUSD(account.balance_cents - account.hold_cents)}.`);
  if (errors.length) return renderTransferForm(req, res, { errors, form: req.body, status: 422 });

  const draft = {
    recipientAccountId: r.account_id, recipientAccountNumber: r.account_number, recipientName: r.full_name,
    amountCents, description: req.body.description, reference: req.body.reference || '', idempotencyKey: newKey(),
  };
  req.session.transferDraft = draft;
  res.render('customer/transfer-review', { title: 'Review transfer', layout: 'layouts/app', draft, account });
};

exports.confirmTransfer = async (req, res) => {
  const draft = req.session.transferDraft;
  const key = String(req.body.idempotencyKey || '');
  if (!draft || draft.idempotencyKey !== key) {
    // Possible double-submit after success: show the original result instead of re-sending.
    const acct = await users.getPrimaryAccount(req.user.id);
    if (key && acct) {
      const { rows } = await db.query('SELECT reference FROM transactions WHERE account_id = $1 AND idempotency_key = $2', [acct.id, key]);
      if (rows[0]) {
        flash(req, 'info', 'This transfer was already completed. It was not sent twice.');
        return res.redirect(`/transactions/${rows[0].reference}`);
      }
    }
    flash(req, 'error', 'Your transfer session expired. Please start again.');
    return res.redirect('/transfer');
  }
  if (!req.body.confirmName) {
    return res.status(422).render('customer/transfer-review', {
      title: 'Review transfer', layout: 'layouts/app', draft, account: await users.getPrimaryAccount(req.user.id),
      errors: [`Please confirm that ${draft.recipientName} is the person you intend to pay.`] });
  }
  try {
    const result = await ledger.transfer({
      userId: req.user.id, recipient: draft.recipientAccountNumber, amountCents: draft.amountCents,
      description: draft.description, userReference: draft.reference, idempotencyKey: draft.idempotencyKey,
      expectedRecipientAccountId: draft.recipientAccountId, req,
    });
    delete req.session.transferDraft;
    flash(req, 'success', result.duplicate ? 'This transfer was already completed. It was not sent twice.' : `Transfer of ${formatUSD(draft.amountCents)} to ${draft.recipientName} completed successfully.`);
    res.redirect(`/transactions/${result.reference}?receipt=1`);
  } catch (e) {
    if (!e.expose) throw e;
    delete req.session.transferDraft;
    renderTransferForm(req, res, { errors: [e.message], form: { recipient: draft.recipientAccountNumber, amount: (draft.amountCents / 100).toFixed(2), description: draft.description, reference: draft.reference }, status: e.status || 400 });
  }
};

// ---------------------------------------------------------------- withdrawals
async function renderWithdraw(req, res, { errors = [], form = {}, status = 200 } = {}) {
  const [account, limits] = await Promise.all([users.getPrimaryAccount(req.user.id), settings.getMap()]);
  res.status(status).render('customer/withdraw', { title: 'Withdraw funds', layout: 'layouts/app', account, limits, errors, form, idempotencyKey: newKey() });
}
exports.withdrawForm = (req, res) => renderWithdraw(req, res);
exports.withdrawValidators = [
  amountField(),
  body('description').optional({ values: 'falsy' }).trim().isLength({ max: 140 }).withMessage('Description must be at most 140 characters.'),
  body('confirm').equals('on').withMessage('Please confirm the withdrawal.'),
  collect,
];
exports.withdraw = async (req, res) => {
  if (req.validationErrors.length) return renderWithdraw(req, res, { errors: req.validationErrors, form: req.body, status: 422 });
  try {
    const r = await ledger.withdraw({ userId: req.user.id, amountCents: parseAmountToCents(req.body.amount), description: req.body.description, idempotencyKey: req.body.idempotencyKey, req });
    flash(req, 'success', r.duplicate ? 'This withdrawal was already processed. It was not repeated.' : `Withdrawal of ${formatUSD(r.tx.amount_cents)} completed.`);
    res.redirect(`/transactions/${r.reference}?receipt=1`);
  } catch (e) {
    if (!e.expose) throw e;
    renderWithdraw(req, res, { errors: [e.message], form: req.body, status: e.status || 400 });
  }
};

// ---------------------------------------------------------------- deposits
async function renderDeposit(req, res, { errors = [], form = {}, status = 200 } = {}) {
  const [account, limits, requests] = await Promise.all([
    users.getPrimaryAccount(req.user.id), settings.getMap(), ledger.listDepositRequests({ userId: req.user.id, perPage: 20 })]);
  res.status(status).render('customer/deposit', { title: 'Deposit funds', layout: 'layouts/app', account, limits, requests: requests.rows, errors, form, idempotencyKey: newKey() });
}
exports.depositForm = (req, res) => renderDeposit(req, res);
exports.depositValidators = [
  amountField(),
  body('method').isIn(['simulated_card', 'simulated_wire', 'simulated_cash']).withMessage('Choose a deposit method.'),
  body('note').optional({ values: 'falsy' }).trim().isLength({ max: 200 }).withMessage('Note must be at most 200 characters.'),
  collect,
];
exports.deposit = async (req, res) => {
  if (req.validationErrors.length) return renderDeposit(req, res, { errors: req.validationErrors, form: req.body, status: 422 });
  try {
    const r = await ledger.createDepositRequest({ userId: req.user.id, amountCents: parseAmountToCents(req.body.amount), method: req.body.method, note: req.body.note, idempotencyKey: req.body.idempotencyKey, req });
    flash(req, 'success', r.duplicate
      ? `Deposit request ${r.request.reference} was already submitted.`
      : `Deposit request ${r.request.reference} for ${formatUSD(r.request.amount_cents)} submitted. Funds are credited once an administrator approves it.`);
    res.redirect('/deposit');
  } catch (e) {
    if (!e.expose) throw e;
    renderDeposit(req, res, { errors: [e.message], form: req.body, status: e.status || 400 });
  }
};

'use strict';
const { body, validationResult } = require('express-validator');
const { parseAmountToCents } = require('../utils/money');

const COUNTRIES = require('../utils/countries');

/** Collects express-validator errors into req.validationErrors (array of messages). */
function collect(req, res, next) {
  const result = validationResult(req);
  req.validationErrors = result.isEmpty() ? [] : [...new Set(result.array().map((e) => e.msg))];
  next();
}

const password = (field) => body(field)
  .isLength({ min: 10, max: 128 }).withMessage('Password must be 10-128 characters.')
  .matches(/[a-z]/).withMessage('Password must include a lowercase letter.')
  .matches(/[A-Z]/).withMessage('Password must include an uppercase letter.')
  .matches(/\d/).withMessage('Password must include a number.')
  .matches(/[^A-Za-z0-9]/).withMessage('Password must include a symbol.');

const profileFields = [
  body('fullName').trim().isLength({ min: 3, max: 120 }).withMessage('Enter your full name (3-120 characters).')
    .matches(/^[\p{L}\p{M}' .-]+$/u).withMessage('Full name may only contain letters, spaces, apostrophes, periods and hyphens.'),
  body('email').trim().isEmail().withMessage('Enter a valid email address.').isLength({ max: 254 }).normalizeEmail({ gmail_remove_dots: false }),
  body('phone').trim().matches(/^\+?[0-9 ()-]{7,20}$/).withMessage('Enter a valid phone number (digits, spaces, +, -, parentheses).'),
  body('country').trim().isIn(COUNTRIES).withMessage('Select a country from the list.'),
];

const registration = [
  ...profileFields,
  body('username').trim().matches(/^[A-Za-z0-9_.]{3,32}$/).withMessage('Username must be 3-32 characters: letters, numbers, dot or underscore.'),
  password('password'),
  body('confirmPassword').custom((v, { req }) => v === req.body.password).withMessage('Passwords do not match.'),
  body('accountType').isIn(['checking', 'savings', 'business']).withMessage('Choose an account type.'),
  collect,
];

const amountField = (field = 'amount') => body(field).custom((v) => { parseAmountToCents(v); return true; })
  .withMessage('Enter a valid USD amount greater than $0.00 with up to two decimals.');

const transfer = [
  body('recipient').trim().isLength({ min: 3, max: 32 }).withMessage('Enter the recipient account number or username.'),
  amountField(),
  body('description').trim().isLength({ min: 2, max: 140 }).withMessage('Enter a transfer description (2-140 characters).'),
  body('reference').optional({ values: 'falsy' }).trim().isLength({ max: 40 }).withMessage('Reference must be at most 40 characters.')
    .matches(/^[A-Za-z0-9 \-_/#.]*$/).withMessage('Reference may only contain letters, numbers, spaces and - _ / # .'),
  collect,
];

module.exports = { collect, password, profileFields, registration, transfer, amountField, COUNTRIES };

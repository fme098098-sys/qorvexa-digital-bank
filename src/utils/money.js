'use strict';
const { AppError } = require('./errors');

const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;

/** Parse a user-entered USD amount ("1,250.50", "$20") into integer cents. */
function parseAmountToCents(input) {
  if (input === undefined || input === null) throw new AppError('Please enter an amount.');
  const cleaned = String(input).trim().replace(/[$,\s]/g, '');
  if (!AMOUNT_RE.test(cleaned)) throw new AppError('Enter a valid USD amount with up to two decimal places.');
  const [whole, frac = ''] = cleaned.split('.');
  const cents = parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  if (cents <= 0) throw new AppError('Amount must be greater than $0.00.');
  return cents;
}

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function formatUSD(cents) {
  return fmt.format((Number(cents) || 0) / 100);
}

module.exports = { parseAmountToCents, formatUSD };

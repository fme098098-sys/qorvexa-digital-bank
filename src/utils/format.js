'use strict';
const { formatUSD } = require('./money');

function formatDate(d, withTime = true) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  const opts = withTime
    ? { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: '2-digit' };
  return date.toLocaleString('en-US', opts);
}

const TYPE_LABELS = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_in: 'Transfer received',
  transfer_out: 'Transfer sent',
};

function maskAccount(num) {
  if (!num) return '';
  return '•••• ' + String(num).slice(-4);
}

function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = { formatUSD, formatDate, TYPE_LABELS, maskAccount, titleCase };

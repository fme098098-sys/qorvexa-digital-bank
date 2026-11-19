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

const DISPLAY_TZ = process.env.DISPLAY_TIMEZONE || 'UTC';
/** Unambiguous timestamp for security logs, e.g. "Thu, 19 Nov 2026, 13:05:22 UTC". */
function formatDateTime(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  try {
    return date.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: DISPLAY_TZ, timeZoneName: 'short' });
  } catch (_) {
    return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }
}

/** "5 min ago" style helper for recent events. */
function timeAgo(d) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
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

module.exports = { formatUSD, formatDate, formatDateTime, timeAgo, TYPE_LABELS, maskAccount, titleCase };

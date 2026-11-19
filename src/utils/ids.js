'use strict';
const crypto = require('crypto');

const ALPHANUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

function randomString(len, alphabet = ALPHANUM) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function randomDigits(len) {
  let out = '';
  while (out.length < len) out += crypto.randomInt(0, 10).toString();
  return out;
}

/** Customer-facing unique account ID, e.g. QX7F3K9P2M */
const genCustomerId = () => 'QX' + randomString(8);
/** 10-digit account number starting with 40 */
const genAccountNumber = () => '40' + randomDigits(8);
/** Transaction reference e.g. TRF-20261119-7KD2M9QX */
function genReference(prefix, at) {
  const d = at ? new Date(at) : new Date();
  const ymd = d.getUTCFullYear().toString() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
  return `${prefix}${ymd}${randomString(8)}`;
}
const genTicketNumber = () => 'TKT-' + randomString(8);
const genToken = () => crypto.randomBytes(32).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = { genCustomerId, genAccountNumber, genReference, genTicketNumber, genToken, sha256, randomString };

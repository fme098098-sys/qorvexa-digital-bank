'use strict';
const nodemailer = require('nodemailer');
const config = require('../config');

let transport;
function getTransport() {
  if (!transport) {
    transport = config.smtpUrl
      ? nodemailer.createTransport(config.smtpUrl)
      : nodemailer.createTransport({ jsonTransport: true });
  }
  return transport;
}

/** Sends mail through SMTP when configured; otherwise logs it to the server console. */
async function send({ to, subject, text }) {
  const info = await getTransport().sendMail({ from: config.mailFrom, to, subject, text });
  if (!config.smtpUrl && !config.isTest) {
    console.log(`[mail:console] To: ${to}\nSubject: ${subject}\n${text}\n`);
  }
  return info;
}

module.exports = { send };

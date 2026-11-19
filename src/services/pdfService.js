'use strict';
/** PDF receipts and account statements (pdfkit). Every document carries the simulation disclaimer. */
const PDFDocument = require('pdfkit');
const config = require('../config');
const { formatUSD, formatDate, TYPE_LABELS } = require('../utils/format');

const NAVY = '#0B1F3A';
const GOLD = '#C9A227';
const GREY = '#5B6576';

function header(doc, title) {
  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(20).text('QORVEXA', 50, 30, { continued: true })
    .fillColor('#FFFFFF').font('Helvetica').text('  DIGITAL BANK');
  doc.fillColor('#C8D1E0').fontSize(10).text(title, 50, 58);
  doc.fillColor('#000000');
  doc.moveDown(3);
}

function disclaimer(doc) {
  const y = doc.page.height - 85;
  doc.save();
  doc.rect(40, y, doc.page.width - 80, 40).fillAndStroke('#FFF8E1', GOLD);
  doc.fillColor('#6B5300').font('Helvetica-Bold').fontSize(8.5)
    .text('SIMULATED FUNDS NOTICE', 52, y + 7, { width: doc.page.width - 104 });
  doc.font('Helvetica').fontSize(8)
    .text(config.brand.disclaimer + ' This document has no monetary value and is not proof of any real payment.', 52, y + 18, { width: doc.page.width - 104 });
  doc.restore();
}

function row(doc, label, value, y) {
  doc.font('Helvetica').fontSize(10).fillColor(GREY).text(label, 60, y, { width: 170 });
  doc.font('Helvetica-Bold').fillColor('#111111').text(value || '—', 230, y, { width: 320 });
}

function receipt(res, tx) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, left: 50, right: 50, bottom: 15 }, info: { Title: `Receipt ${tx.reference}`, Author: config.brand.name } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="qorvexa-receipt-${tx.reference}.pdf"`);
  doc.pipe(res);
  header(doc, 'Transaction receipt');

  doc.font('Helvetica-Bold').fontSize(26).fillColor(tx.direction === 'credit' ? '#11804A' : NAVY)
    .text(`${tx.direction === 'credit' ? '+' : '-'}${formatUSD(tx.amount_cents)}`, 50, 120);
  doc.font('Helvetica').fontSize(11).fillColor(GREY).text(`${TYPE_LABELS[tx.type]} · ${tx.status.toUpperCase()}`, 50, 154);

  let y = 195;
  const rows = [
    ['Reference', tx.reference],
    ['Date & time', formatDate(tx.created_at)],
    ['Account holder', tx.owner_name],
    ['Account number', tx.account_number],
    ['Transaction type', TYPE_LABELS[tx.type]],
    ['Amount (USD)', formatUSD(tx.amount_cents)],
    ['Balance after', formatUSD(tx.balance_after_cents)],
  ];
  if (tx.counterparty_name) {
    rows.push([tx.direction === 'debit' ? 'Recipient' : 'Sender', tx.counterparty_name]);
    rows.push([tx.direction === 'debit' ? 'Recipient account' : 'Sender account', tx.counterparty_account_number]);
  }
  rows.push(['Description', tx.description]);
  if (tx.user_reference) rows.push(['Your reference', tx.user_reference]);
  for (const [l, v] of rows) {
    row(doc, l, String(v), y);
    y += 24;
    doc.moveTo(60, y - 6).lineTo(535, y - 6).strokeColor('#E6E9EF').lineWidth(0.5).stroke();
  }
  doc.font('Helvetica').fontSize(9).fillColor(GREY)
    .text(`Generated ${formatDate(new Date())}. Questions? ${config.brand.supportEmail}`, 60, y + 20);
  disclaimer(doc);
  doc.end();
}

function statement(res, { user, account, from, to, data }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, left: 50, right: 50, bottom: 15 }, bufferPages: true, info: { Title: `Statement ${from} to ${to}`, Author: config.brand.name } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="qorvexa-statement-${account.account_number}-${from}_${to}.pdf"`);
  doc.pipe(res);
  header(doc, `Account statement · ${from} to ${to}`);

  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(user.full_name, 50, 110);
  doc.font('Helvetica').fontSize(10).fillColor(GREY)
    .text(`Account ${account.account_number} · ${account.account_type} · Customer ID ${user.customer_id}`, 50, 128);

  const boxes = [
    ['Opening balance', formatUSD(data.openingBalance)],
    ['Money in', formatUSD(data.credits)],
    ['Money out', formatUSD(data.debits)],
    ['Closing balance', formatUSD(data.closingBalance)],
  ];
  boxes.forEach(([l, v], i) => {
    const x = 50 + i * 125;
    doc.rect(x, 152, 117, 48).fill('#F3F5F9');
    doc.fillColor(GREY).fontSize(8).text(l.toUpperCase(), x + 8, 160);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12).text(v, x + 8, 176);
    doc.font('Helvetica');
  });

  const cols = [50, 125, 225, 395, 470];
  let y = 220;
  const drawHead = () => {
    doc.rect(50, y - 4, 495, 18).fill(NAVY);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8.5);
    ['Date', 'Reference', 'Description', 'Amount', 'Balance'].forEach((h, i) => doc.text(h, cols[i] + 3, y, { width: i === 2 ? 165 : 72 }));
    doc.font('Helvetica').fillColor('#111111');
    y += 20;
  };
  drawHead();
  if (!data.rows.length) {
    doc.fontSize(10).fillColor(GREY).text('No transactions in this period.', 53, y + 4);
  }
  for (const t of data.rows) {
    if (y > doc.page.height - 130) { doc.addPage(); y = 60; drawHead(); }
    const desc = t.counterparty_name ? `${t.description} — ${t.counterparty_name}` : t.description;
    doc.fontSize(8.5).fillColor('#111111');
    doc.text(formatDate(t.created_at, false), cols[0] + 3, y, { width: 72 });
    doc.text(t.reference, cols[1] + 3, y, { width: 98 });
    doc.text(desc.slice(0, 70), cols[2] + 3, y, { width: 165 });
    doc.fillColor(t.direction === 'credit' ? '#11804A' : '#9B1C1C').text(`${t.direction === 'credit' ? '+' : '-'}${formatUSD(t.amount_cents)}`, cols[3] + 3, y, { width: 72 });
    doc.fillColor('#111111').text(formatUSD(t.balance_after_cents), cols[4] + 3, y, { width: 72 });
    y += 22;
    doc.moveTo(50, y - 5).lineTo(545, y - 5).strokeColor('#E6E9EF').lineWidth(0.5).stroke();
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    disclaimer(doc);
    doc.fontSize(8).fillColor(GREY).text(`Page ${i + 1} of ${range.count}`, 50, doc.page.height - 38, { align: 'right', width: 495, lineBreak: false });
  }
  doc.end();
}

module.exports = { receipt, statement };

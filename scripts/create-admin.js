#!/usr/bin/env node
'use strict';
/**
 * Create an administrator account.
 *
 *   npm run create-admin -- --email admin@example.com --username admin --name "Ada Admin" --role super_admin
 *
 * The password is read from --password, the ADMIN_PASSWORD env var, or prompted (hidden input).
 * Roles: super_admin (all permissions incl. settings), admin (operations), support (support desk only).
 */
const readline = require('readline');
const { pool } = require('../src/db/pool');
const admins = require('../src/services/adminService');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = function (s) { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function main() {
  const email = arg('email');
  const username = arg('username');
  const fullName = arg('name') || 'Qorvexa Administrator';
  const role = arg('role') || 'super_admin';
  if (!email || !username) {
    console.error('Usage: npm run create-admin -- --email <email> --username <username> [--name "Full Name"] [--role super_admin|admin|support] [--password <pw>]');
    process.exit(1);
  }
  if (!['super_admin', 'admin', 'support'].includes(role)) throw new Error('Invalid role');
  let password = arg('password') || process.env.ADMIN_PASSWORD;
  if (!password) password = await promptHidden('Admin password (min 12 chars): ');
  if (!password || password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Admin password must be at least 12 characters and include upper and lowercase letters and a number.');
  }
  const admin = await admins.createAdmin({ fullName, email, username, password, role });
  console.log(`Created administrator ${admin.username} <${admin.email}> with role ${admin.role}.`);
  console.log('Sign in at /admin/login');
}

main().then(() => pool.end()).catch((e) => { console.error(`Error: ${e.message}`); pool.end(); process.exit(1); });

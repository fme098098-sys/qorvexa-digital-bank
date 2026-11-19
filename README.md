# QORVEXA DIGITAL BANK

> **Educational software project — all balances and transactions are simulated; Qorvexa is not a real bank.**
> It holds no banking licence, offers no deposit insurance, and never connects to real payment networks.
> The notice appears in the footer of every page, on the login and registration pages, and on every receipt and statement (screen, print, and PDF).

A full-stack digital banking application built as an academic software engineering project with
**Node.js, Express 5, PostgreSQL and server-rendered EJS views**. Everything is wired to a real
backend: authentication, an append-only ledger with atomic internal transfers, deposit requests
reviewed by administrators, PDF receipts and statements, notifications, beneficiaries, support
tickets, a role-based admin console and an immutable audit log.

---

## Contents
1. [Features](#features)
2. [Architecture](#architecture)
3. [Installation](#installation)
4. [Environment configuration](#environment-configuration)
5. [Creating the first administrator](#creating-the-first-administrator)
6. [Sample data](#sample-data)
7. [Testing](#testing)
8. [Deployment](#deployment)
9. [Security design](#security-design)
10. [Database schema](#database-schema)
11. [Pages and routes](#pages-and-routes)

---

## Features

**Customers**
- Registration (full name, email, phone, username, password + confirmation, country, account type) with server-side validation
- Login by email **or** username, *Remember me*, account lockout after 5 failed attempts, forgot/reset password (single-use, 30-minute tokens)
- Unique **Account ID** (`QX…`) and 10-digit **account number** per customer
- Dashboard: welcome, balance and available balance (USD), account number/status, total incoming/outgoing transfers, recent transactions, 6-month spending summary and chart
- **Internal transfers** by account number or username → review page showing the recipient's name → explicit name confirmation → receipt
- Deposits (simulated card / wire / cash *requests*, credited only after admin approval) and simulated withdrawals
- Transaction history with search, type and date filters, pagination and CSV export; transaction details; PDF receipts; printable views
- Account statements for any date range (opening/closing balance, money in/out) as page, print, or PDF
- Profile management, change password, notification centre (read / read all / delete), beneficiaries (verify, add, pay, remove), support tickets

**Administrators** (separate login at `/admin/login`, separate session key, roles `super_admin`, `admin`, `support`)
- Dashboard: total simulated funds, total deposits/withdrawals/transfers, registered and new customers, pending deposits, open tickets, 14-day volume and registration charts, recent activity
- User management: search by name/email/username/account number/ID, view details, create customers (optional opening deposit posted through the ledger), edit profiles, suspend/reactivate with a mandatory reason (suspension ends active sessions)
- Transaction management: search by reference/account/name, filter by type/date, view both legs of any transfer (read-only)
- Deposit request review (approve → ledgered credit; reject → reason required)
- Support desk (status, priority, response; customers are notified)
- System activity & audit log (filter by actor type, search)
- System settings (limits, registration on/off, customer banner) — editable by `super_admin` only, every change audited with old/new values

**Administrators cannot edit balances or transactions.** There is no such route, and the database itself
rejects it: a trigger blocks any balance change that doesn't come from the ledger service, and
`transactions` and `audit_logs` are append-only (UPDATE and DELETE raise errors).

## Architecture

```
src/
  app.js                 Express app factory (helmet, sessions, CSRF, rate limits, routes, errors)
  server.js              HTTP entry point
  config/                Environment configuration
  db/pool.js             pg Pool + withTransaction helper
  middleware/            auth (requireUser / requireAdmin(roles)), csrf, rateLimit, validate
  services/              Business logic (ledgerService = the ONLY code that moves money)
    ledgerService.js       transfers, withdrawals, deposit requests & reviews (row locks, idempotency)
    userService.js         registration, authentication, profile, password reset, suspension
    transactionService.js  history, details, dashboard metrics, statements, system totals
    adminService.js        admin auth + overview metrics
    auditService.js, notificationService.js, beneficiaryService.js, supportService.js,
    settingsService.js, pdfService.js, mailService.js
  controllers/           HTTP handlers (public, auth, customer, banking, admin)
  routes/                Routers (public, auth, customer, admin)
  views/                 EJS layouts, partials and pages
  utils/                 money parsing/formatting, ID generation, helpers
public/                  CSS, JS (progressive enhancement), logo
db/migrations/           SQL migrations (applied by scripts/migrate.js)
db/schema.sql            Full schema in one file
scripts/                 migrate, seed, create-admin, smoke.sh
tests/                   Jest + Supertest suites
```

Money is stored as **integer cents (BIGINT)** and displayed in USD (`$25,450.00`).

## Installation

Prerequisites: **Node.js 18+** (tested on Node 24) and **PostgreSQL 13+** (tested on 18).

```bash
# 1. Install dependencies
npm install

# 2. Create a database user and databases (or use `docker compose up -d db`)
psql -U postgres -c "CREATE ROLE qorvexa LOGIN PASSWORD 'change_me';"
psql -U postgres -c "CREATE DATABASE qorvexa OWNER qorvexa;"
psql -U postgres -c "CREATE DATABASE qorvexa_test OWNER qorvexa;"

# 3. Configure the environment
cp .env.example .env        # then edit DATABASE_URL, TEST_DATABASE_URL and SESSION_SECRET

# 4. Create the schema and load fictional sample data
npm run migrate
npm run seed

# 5. Create the first administrator (see below)
npm run create-admin -- --email admin@example.com --username qadmin --name "Your Name" --role super_admin

# 6. Start the server
npm start                   # or: npm run dev (auto-reload)
# open http://localhost:3000
```

`npm run db:reset` drops and rebuilds the development schema and re-seeds it (refuses to run when `NODE_ENV=production`).

## Environment configuration

See [`.env.example`](.env.example). Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_SSL` | `true` for managed Postgres requiring TLS |
| `TEST_DATABASE_URL` | Database used (and **wiped**) by `npm test` |
| `SESSION_SECRET` | Long random secret (required in production) |
| `SESSION_TTL_MINUTES` / `REMEMBER_ME_DAYS` | Session idle timeout / *Remember me* lifetime |
| `COOKIE_SECURE` | Force `Secure` cookies (default `true` in production) |
| `TRUST_PROXY` | Number of reverse proxies (set `1` on Render/Railway) |
| `BCRYPT_ROUNDS` | bcrypt cost factor (default 12) |
| `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_GENERAL_MAX` | Requests per 15 minutes per IP |
| `APP_BASE_URL` | Used to build password-reset links |
| `SMTP_URL` / `MAIL_FROM` | Outgoing mail for reset links; if `SMTP_URL` is empty, messages are written to the server log (development) |

## Creating the first administrator

Administrators are stored in a separate `admin_users` table and can only be created from the command line:

```bash
npm run create-admin -- --email admin@example.com --username qadmin --name "Grace Adeyemi" --role super_admin
# You will be prompted for the password (hidden). Alternatively pass --password '<pw>' or set ADMIN_PASSWORD.
```

Roles:
- `super_admin` — everything, including system settings
- `admin` — users, transactions, deposits, support, audit log (settings read-only)
- `support` — dashboard, read-only user lookup, support desk

Admin passwords must be 12+ characters with upper- and lowercase letters and a number. The creation itself is audit-logged.

## Sample data

`npm run seed` creates **fictional** customers (all with password `Qorvexa#2026`, override with `SEED_PASSWORD`):

| Username | Name | Country | Type |
|---|---|---|---|
| `amara` | Amara Okafor | Nigeria | checking |
| `daniel.mercer` | Daniel Mercer | United States | checking |
| `sofia` | Sofia Lindqvist | Sweden | savings |
| `kenji` | Kenji Tanaka | Japan | business |
| `lucia` | Lucía Fernández | Spain | checking |
| `kwame` | Kwame Mensah | Ghana | savings |
| `mei` | Mei Chen | Singapore | checking |
| `oliver` | Oliver Brandt | Germany | savings |

…plus approved opening deposits, ~6 months of transfers and withdrawals (all posted through the ledger
service), three pending deposit requests and two support tickets. Emails use the reserved `example.com` domain.

## Testing

```bash
npm test            # Jest + Supertest, runs in band against TEST_DATABASE_URL (schema is rebuilt first)
bash scripts/smoke.sh   # end-to-end curl smoke test against a running server (BASE=http://localhost:3000)
```

The suites cover:
- **auth** — registration (hashing, unique IDs, duplicates, weak passwords), login by username/email, secure cookie flags, CSRF rejection, protected-route redirects, suspended users, lockout, logout, change password, single-use reset tokens
- **transfers** — atomic two-leg posting, username recipients, insufficient funds, nonexistent recipient, self-transfer, invalid amounts, suspended recipient, **12 concurrent transfers racing for the same balance** (no overdraft, ledger reconciles), **6 concurrent duplicates with one idempotency key** (exactly one transfer), limits, DB-level balance guard / immutability / CHECK constraint, full HTTP review → confirm → re-submit flow, receipt access control, withdrawals, deposit approval
- **admin** — separate admin login, customers blocked from admin, role restrictions (support/admin/super_admin), deposit approval/rejection audited, suspend/reactivate audited and enforced, admin-created customer with ledgered opening deposit, profile edits audited without touching balances, search by name/account/reference

## Deployment

The app is a standard Node.js web service plus PostgreSQL. **Deploy it only to localhost or a generic
student/staging host using the platform's default subdomain** (e.g. `your-app.onrender.com`,
`your-app.up.railway.app`). Do not put it on a domain that looks like a real bank's, and keep the simulated-funds notices in place.

### Render (example)
1. Push the repository to GitHub.
2. Create a **PostgreSQL** instance; copy its *Internal Database URL*.
3. Create a **Web Service** from the repo:
   - Build command: `npm ci && npm run migrate`
   - Start command: `npm start`
   - Environment: `NODE_ENV=production`, `DATABASE_URL=<internal url>`, `DATABASE_SSL=true` (if required), `SESSION_SECRET=<random>`, `TRUST_PROXY=1`, `APP_BASE_URL=https://<your-app>.onrender.com`
4. Open the Render shell and run `npm run create-admin -- --email … --username … --role super_admin`.
5. Optional: `npm run seed` for fictional sample data.

### Railway (example)
Add a PostgreSQL plugin, set the same variables (`DATABASE_URL` is provided), use `npm run migrate && npm start`
as the start command, then run `npm run create-admin` from the Railway CLI (`railway run npm run create-admin -- …`).

### Production checklist
- `NODE_ENV=production`, strong `SESSION_SECRET`, HTTPS (cookies become `Secure` automatically), `TRUST_PROXY` set correctly
- Configure `SMTP_URL` if password-reset emails should actually be delivered
- Regular PostgreSQL backups

## Security design

| Requirement | Implementation |
|---|---|
| Password hashing | bcrypt (cost 12), never stored or logged in plain text; timing-equalised failed lookups |
| Authentication & sessions | `express-session` stored in PostgreSQL (`connect-pg-simple`), session ID regenerated on login, `HttpOnly`, `SameSite=Lax`, `Secure` in production, idle timeout, *Remember me* |
| Role-based authorization | `requireUser`, `requireAdmin(...roles)`; admin and customer identities are separate tables and session keys |
| Server-side validation | `express-validator` on every form; strict amount parser (max 2 decimals, > 0) |
| SQL injection | Parameterised queries only (`pg`) |
| XSS | EJS auto-escaping (`<%= %>`), strict Content-Security-Policy (no inline scripts), Helmet headers |
| CSRF | Per-session synchronizer token on every POST (hidden field or `X-CSRF-Token` header), constant-time comparison |
| Rate limiting | `express-rate-limit` on auth endpoints (20/15 min/IP), money-moving endpoints and globally; account lockout after 5 failures |
| Transaction integrity | Single DB transaction, `SELECT … FOR UPDATE` on both accounts in a consistent order, idempotency keys (unique index), `CHECK (balance_cents >= 0)`, unique references, balance-guard trigger, append-only ledger |
| Audit logging | Append-only `audit_logs` for all admin actions and security-relevant customer events (logins, failures, transfers, password changes, settings changes) |

## Database schema

Tables: `users`, `admin_users`, `accounts`, `transactions`, `beneficiaries`, `notifications`,
`deposit_requests`, `support_tickets`, `password_resets`, `audit_logs`, `system_settings`, `session`
(plus `schema_migrations`). See [`db/schema.sql`](db/schema.sql) for constraints, indexes, foreign keys and triggers.

## Pages and routes

| # | Page | Route |
|---|---|---|
| 1 | Home | `/` |
| 2 | About Qorvexa | `/about` |
| 3 | Contact us | `/contact` |
| 4 | Login | `/login` |
| 5 | Registration | `/register` |
| 6 | Forgot password | `/forgot-password` (+ `/reset-password/:token`) |
| 7 | Customer dashboard | `/dashboard` |
| 8 | Transfer funds | `/transfer` → `/transfer/review` → `/transfer/confirm` |
| 9 | Deposit | `/deposit` |
| 10 | Withdraw | `/withdraw` |
| 11 | Transaction history | `/transactions` (+ `/transactions/:ref`, `/transactions/:ref/receipt.pdf`, `/transactions/export.csv`) |
| 12 | Account statement | `/statements` (+ `/statements/download`) |
| 13 | Profile settings | `/profile` (+ change password) |
| 14 | Notifications | `/notifications` |
| 15 | Admin login | `/admin/login` |
| 16 | Admin dashboard | `/admin` |
| 17 | User management | `/admin/users`, `/admin/users/new`, `/admin/users/:id` |
| 18 | Transaction management | `/admin/transactions`, `/admin/transactions/:ref`, `/admin/deposits` |
| 19 | Support management | `/admin/support`, `/admin/support/:id` |
| 20 | System settings | `/admin/settings` (+ `/admin/audit-logs`) |

Additional customer pages: `/beneficiaries`, `/support`.

---
*Qorvexa Digital Bank is a fictional brand created for an academic project. Any resemblance to real institutions is unintended.*

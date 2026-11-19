-- QORVEXA DIGITAL BANK - full database schema (generated from db/migrations/001_initial_schema.sql + 002_login_events.sql).
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql   (or preferably: npm run migrate)

-- QORVEXA DIGITAL BANK - initial schema
-- Educational software project: all balances and transactions are simulated.
-- Money is stored as BIGINT cents (USD) to avoid floating point errors.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      VARCHAR(12)  NOT NULL UNIQUE,              -- public unique account ID e.g. QX7F3K9P2M
  full_name        VARCHAR(120) NOT NULL,
  email            VARCHAR(254) NOT NULL,
  phone            VARCHAR(32)  NOT NULL,
  username         VARCHAR(32)  NOT NULL,
  password_hash    VARCHAR(255) NOT NULL,
  country          VARCHAR(64)  NOT NULL,
  status           VARCHAR(16)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  status_reason    TEXT,
  failed_logins    INTEGER      NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until     TIMESTAMPTZ,
  last_login_at    TIMESTAMPTZ,
  created_by_admin UUID,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq    ON users (lower(email));
CREATE UNIQUE INDEX users_username_lower_uq ON users (lower(username));
CREATE INDEX users_created_at_idx ON users (created_at);

-- ---------------------------------------------------------------- admin_users
CREATE TABLE admin_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     VARCHAR(120) NOT NULL,
  email         VARCHAR(254) NOT NULL,
  username      VARCHAR(32)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(16)  NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin','admin','support')),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_users_email_lower_uq    ON admin_users (lower(email));
CREATE UNIQUE INDEX admin_users_username_lower_uq ON admin_users (lower(username));
ALTER TABLE users ADD CONSTRAINT users_created_by_admin_fk FOREIGN KEY (created_by_admin) REFERENCES admin_users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- accounts
CREATE TABLE accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_number CHAR(10)    NOT NULL UNIQUE CHECK (account_number ~ '^[0-9]{10}$'),
  account_type   VARCHAR(16) NOT NULL CHECK (account_type IN ('checking','savings','business')),
  currency       CHAR(3)     NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  balance_cents  BIGINT      NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  hold_cents     BIGINT      NOT NULL DEFAULT 0 CHECK (hold_cents >= 0),
  status         VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounts_hold_le_balance CHECK (hold_cents <= balance_cents)
);
CREATE INDEX accounts_user_idx ON accounts (user_id);

-- Balances may only change through the ledger service, which sets
-- "qorvexa.ledger_write" for the current transaction (SET LOCAL).
CREATE OR REPLACE FUNCTION guard_account_balance() RETURNS trigger AS $$
BEGIN
  IF (NEW.balance_cents IS DISTINCT FROM OLD.balance_cents OR NEW.hold_cents IS DISTINCT FROM OLD.hold_cents)
     AND coalesce(current_setting('qorvexa.ledger_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Account balances can only be changed through ledgered transactions';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER accounts_balance_guard BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION guard_account_balance();

CREATE OR REPLACE FUNCTION guard_account_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.balance_cents <> 0 OR NEW.hold_cents <> 0 THEN
    RAISE EXCEPTION 'New accounts must open with a zero balance; fund them with a ledgered deposit';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER accounts_insert_guard BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION guard_account_insert();

-- ---------------------------------------------------------------- transactions (immutable ledger)
CREATE TABLE transactions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference              VARCHAR(24) NOT NULL,      -- shared by both legs of a transfer
  account_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  type                   VARCHAR(16) NOT NULL CHECK (type IN ('deposit','withdrawal','transfer_in','transfer_out')),
  direction              VARCHAR(6)  NOT NULL CHECK (direction IN ('credit','debit')),
  amount_cents           BIGINT      NOT NULL CHECK (amount_cents > 0),
  balance_after_cents    BIGINT      NOT NULL CHECK (balance_after_cents >= 0),
  counterparty_account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  counterparty_name      VARCHAR(120),
  counterparty_account_number CHAR(10),
  description            VARCHAR(140) NOT NULL,
  user_reference         VARCHAR(40),
  status                 VARCHAR(12) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  idempotency_key        VARCHAR(64),
  deposit_request_id     UUID,
  initiated_by_admin     UUID REFERENCES admin_users(id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tx_direction_matches_type CHECK (
    (type IN ('deposit','transfer_in') AND direction = 'credit') OR
    (type IN ('withdrawal','transfer_out') AND direction = 'debit')),
  CONSTRAINT tx_transfer_has_counterparty CHECK (
    type NOT IN ('transfer_in','transfer_out') OR counterparty_account_id IS NOT NULL),
  CONSTRAINT tx_no_self_transfer CHECK (counterparty_account_id IS NULL OR counterparty_account_id <> account_id)
);
CREATE UNIQUE INDEX transactions_reference_direction_uq ON transactions (reference, direction);
CREATE UNIQUE INDEX transactions_idempotency_uq ON transactions (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX transactions_account_created_idx ON transactions (account_id, created_at DESC);
CREATE INDEX transactions_reference_idx ON transactions (reference);
CREATE INDEX transactions_type_idx ON transactions (type);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (append-only ledger)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_immutable BEFORE UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- beneficiaries
CREATE TABLE beneficiaries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  beneficiary_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  nickname           VARCHAR(60),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, beneficiary_account_id)
);

-- ---------------------------------------------------------------- notifications
CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   VARCHAR(16) NOT NULL DEFAULT 'info' CHECK (category IN ('info','transfer','deposit','withdrawal','security','support','account')),
  title      VARCHAR(120) NOT NULL,
  body       TEXT NOT NULL,
  link       VARCHAR(200),
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, is_read, created_at DESC);

-- ---------------------------------------------------------------- deposit_requests
CREATE TABLE deposit_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference     VARCHAR(24) NOT NULL UNIQUE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  method        VARCHAR(24) NOT NULL CHECK (method IN ('simulated_card','simulated_wire','simulated_cash')),
  note          VARCHAR(200),
  status        VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by   UUID REFERENCES admin_users(id) ON DELETE RESTRICT,
  reviewed_at   TIMESTAMPTZ,
  review_note   VARCHAR(200),
  transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deposit_review_consistency CHECK (
    (status = 'pending' AND reviewed_by IS NULL) OR (status <> 'pending' AND reviewed_at IS NOT NULL)),
  CONSTRAINT deposit_approved_has_tx CHECK (status <> 'approved' OR transaction_id IS NOT NULL)
);
CREATE UNIQUE INDEX deposit_requests_idem_uq ON deposit_requests (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX deposit_requests_status_idx ON deposit_requests (status, created_at);
ALTER TABLE transactions ADD CONSTRAINT transactions_deposit_request_fk FOREIGN KEY (deposit_request_id) REFERENCES deposit_requests(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------- support_tickets
CREATE TABLE support_tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number VARCHAR(16) NOT NULL UNIQUE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,   -- NULL for public contact-form messages
  name         VARCHAR(120) NOT NULL,
  email        VARCHAR(254) NOT NULL,
  subject      VARCHAR(140) NOT NULL,
  category     VARCHAR(24) NOT NULL DEFAULT 'general' CHECK (category IN ('general','account','transfer','deposit','technical','other')),
  message      TEXT NOT NULL,
  status       VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  priority     VARCHAR(8)  NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  admin_response TEXT,
  assigned_admin UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  responded_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX support_tickets_status_idx ON support_tickets (status, created_at DESC);

-- ---------------------------------------------------------------- password resets
CREATE TABLE password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- audit_logs (append-only)
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_type  VARCHAR(8)  NOT NULL CHECK (actor_type IN ('admin','user','system','guest')),
  actor_id    UUID,
  actor_label VARCHAR(140),
  action      VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32),
  entity_id   VARCHAR(64),
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address  VARCHAR(64),
  user_agent  VARCHAR(255),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_type, actor_id);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- system settings
CREATE TABLE system_settings (
  key         VARCHAR(48) PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_by  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value, description) VALUES
  ('registration_open',          'true',    'Allow new customers to register online'),
  ('max_single_transfer_cents',  '2500000', 'Maximum amount for a single transfer (cents)'),
  ('daily_transfer_limit_cents', '5000000', 'Maximum total outgoing transfers per customer per day (cents)'),
  ('daily_withdrawal_limit_cents','1000000','Maximum total withdrawals per customer per day (cents)'),
  ('max_deposit_request_cents',  '10000000','Maximum amount for a single simulated deposit request (cents)'),
  ('maintenance_banner',         '',        'Optional banner text shown to signed-in customers');

-- ---------------------------------------------------------------- sessions (connect-pg-simple)
CREATE TABLE "session" (
  "sid"    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX "IDX_session_expire" ON "session" ("expire");

-- 002: sign-in activity tracking (login attempts, logouts, password resets,
-- forced sign-outs) and a view of active sessions per customer/administrator.
-- Written to be idempotent: safe to re-run on a database that already has it.

CREATE TABLE IF NOT EXISTS login_events (
  id              BIGSERIAL PRIMARY KEY,
  actor_type      VARCHAR(8)  NOT NULL CHECK (actor_type IN ('user','admin')),
  user_id         UUID REFERENCES users(id) ON DELETE RESTRICT,        -- NULL when the identifier matched no customer
  admin_id        UUID REFERENCES admin_users(id) ON DELETE RESTRICT,  -- NULL when the identifier matched no administrator
  identifier      VARCHAR(254),                                        -- username/email that was typed
  event           VARCHAR(24) NOT NULL CHECK (event IN ('login','logout','password_reset_request','password_reset','forced_logout','sessions_revoked')),
  success         BOOLEAN NOT NULL,
  failure_reason  VARCHAR(48),
  ip              VARCHAR(64),
  user_agent      VARCHAR(512),
  browser         VARCHAR(64),
  browser_version VARCHAR(32),
  os              VARCHAR(64),
  os_version      VARCHAR(32),
  device_type     VARCHAR(16),   -- desktop | mobile | tablet | tv | bot | unknown
  device_vendor   VARCHAR(64),
  device_model    VARCHAR(64),
  device_key      CHAR(64),      -- sha256(browser|os|ip) used for new-device detection
  is_new_device   BOOLEAN NOT NULL DEFAULT FALSE,
  session_id      VARCHAR(128),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_events_created_idx ON login_events (created_at DESC);
CREATE INDEX IF NOT EXISTS login_events_user_idx ON login_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS login_events_admin_idx ON login_events (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS login_events_device_idx ON login_events (actor_type, coalesce(user_id, admin_id), device_key) WHERE success AND event = 'login';
CREATE INDEX IF NOT EXISTS login_events_failed_idx ON login_events (created_at DESC) WHERE NOT success;

-- Sign-in history is evidence: append-only, like audit_logs.
DROP TRIGGER IF EXISTS login_events_immutable ON login_events;
CREATE TRIGGER login_events_immutable BEFORE UPDATE OR DELETE ON login_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Active sessions. connect-pg-simple stores everything in the JSON "sess"
-- column; the app puts userId/adminId plus sign-in metadata (ip, user agent,
-- parsed browser/OS/device) there, and this view exposes them as columns.
CREATE INDEX IF NOT EXISTS session_user_id_idx ON "session" ((sess ->> 'userId'));
CREATE INDEX IF NOT EXISTS session_admin_id_idx ON "session" ((sess ->> 'adminId'));

CREATE OR REPLACE VIEW user_sessions AS
SELECT s.sid,
       'user'::text                                        AS actor_type,
       (s.sess ->> 'userId')::uuid                         AS user_id,
       s.sess -> 'userLogin' ->> 'ip'                      AS ip,
       s.sess -> 'userLogin' ->> 'userAgent'               AS user_agent,
       s.sess -> 'userLogin' ->> 'browser'                 AS browser,
       s.sess -> 'userLogin' ->> 'os'                      AS os,
       s.sess -> 'userLogin' ->> 'deviceType'              AS device_type,
       (s.sess -> 'userLogin' ->> 'at')::timestamptz       AS signed_in_at,
       s.expire
  FROM "session" s
 WHERE s.sess ->> 'userId' IS NOT NULL AND s.expire > now()
UNION ALL
SELECT s.sid,
       'admin'::text,
       (s.sess ->> 'adminId')::uuid,
       s.sess -> 'adminLogin' ->> 'ip',
       s.sess -> 'adminLogin' ->> 'userAgent',
       s.sess -> 'adminLogin' ->> 'browser',
       s.sess -> 'adminLogin' ->> 'os',
       s.sess -> 'adminLogin' ->> 'deviceType',
       (s.sess -> 'adminLogin' ->> 'at')::timestamptz,
       s.expire
  FROM "session" s
 WHERE s.sess ->> 'adminId' IS NOT NULL AND s.expire > now();

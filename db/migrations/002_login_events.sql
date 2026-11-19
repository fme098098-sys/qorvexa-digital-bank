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

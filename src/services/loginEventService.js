'use strict';
/**
 * Sign-in activity: records every customer/admin login attempt, logout,
 * password reset and forced sign-out in the append-only login_events table,
 * detects sign-ins from a new browser/OS/IP combination, and lists/revokes
 * active sessions (stored by connect-pg-simple in the "session" table).
 */
const crypto = require('crypto');
const Bowser = require('bowser');
const db = require('../db/pool');
const notifications = require('./notificationService');

const EVENTS = ['login', 'logout', 'password_reset_request', 'password_reset', 'forced_logout', 'sessions_revoked'];
const cut = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

/** Parse a User-Agent string into browser / OS / device fields. Never throws. */
function parseUserAgent(ua) {
  const out = { browser: null, browserVersion: null, os: null, osVersion: null, deviceType: 'unknown', deviceVendor: null, deviceModel: null };
  if (!ua) return out;
  try {
    const p = Bowser.parse(String(ua));
    out.browser = cut(p.browser && p.browser.name, 64);
    out.browserVersion = cut(p.browser && p.browser.version && String(p.browser.version).split('.')[0], 32);
    out.os = cut(p.os && p.os.name, 64);
    out.osVersion = cut(p.os && (p.os.versionName || p.os.version), 32);
    out.deviceType = cut(p.platform && p.platform.type, 16) || 'unknown';
    out.deviceVendor = cut(p.platform && p.platform.vendor, 64);
    out.deviceModel = cut(p.platform && p.platform.model, 64);
  } catch (_) { /* unparseable user agent: keep the raw string only */ }
  return out;
}

/** Request client details: IP (honours TRUST_PROXY), raw and parsed user agent. */
function clientInfo(req) {
  const userAgent = cut(req && req.get && req.get('user-agent'), 512);
  return { ip: cut(req && req.ip, 64), userAgent, ...parseUserAgent(userAgent) };
}

const deviceLabel = (e) => `${e.browser || 'Unknown browser'} on ${e.os || 'unknown OS'}`;

/** Key identifying a browser + OS + IP combination for new-device detection. */
function deviceKey(info) {
  return crypto.createHash('sha256')
    .update([(info.browser || '?').toLowerCase(), (info.os || '?').toLowerCase(), info.ip || '?'].join('|'))
    .digest('hex');
}

/** Metadata stored on the session row (exposed through the user_sessions view). */
function sessionMeta(req) {
  const i = clientInfo(req);
  return { ip: i.ip, userAgent: i.userAgent, browser: i.browser, os: i.os, deviceType: i.deviceType, at: new Date().toISOString() };
}

async function record({ actorType, userId = null, adminId = null, identifier = null, event, success, failureReason = null, req = null, sessionId = null, isNewDevice = false, info = null, at = null }, client) {
  if (!EVENTS.includes(event)) throw new Error(`Unknown login event ${event}`);
  const i = info || clientInfo(req);
  const { rows } = await (client || db).query(
    `INSERT INTO login_events (actor_type, user_id, admin_id, identifier, event, success, failure_reason, ip, user_agent,
        browser, browser_version, os, os_version, device_type, device_vendor, device_model, device_key, is_new_device, session_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, coalesce($20::timestamptz, now())) RETURNING *`,
    [actorType, userId, adminId, cut(identifier, 254), event, Boolean(success), cut(failureReason, 48), i.ip, i.userAgent,
      i.browser, i.browserVersion, i.os, i.osVersion, i.deviceType, i.deviceVendor, i.deviceModel, deviceKey(i), Boolean(isNewDevice), cut(sessionId, 128), at]);
  return rows[0];
}

/**
 * Record a successful sign-in. It is flagged as a new device when this
 * browser + OS + IP combination has never signed in to the principal before
 * (a principal's very first recorded sign-in is their baseline, not "new").
 * Customers get a security notification for new-device sign-ins.
 */
async function recordSuccessfulLogin({ actorType, principal, identifier, req, sessionId, firstDevice = false }) {
  const info = clientInfo(req);
  const key = deviceKey(info);
  const col = actorType === 'admin' ? 'admin_id' : 'user_id';
  let isNewDevice = false;
  if (!firstDevice) {
    const { rows: [h] } = await db.query(
      `SELECT count(*)::int AS logins, count(*) FILTER (WHERE device_key = $2)::int AS same_device
         FROM login_events WHERE ${col} = $1 AND actor_type = $3 AND event = 'login' AND success`, [principal.id, key, actorType]);
    isNewDevice = h.logins > 0 && h.same_device === 0;
  }
  return db.withTransaction(async (client) => {
    const ev = await record({
      actorType, userId: actorType === 'user' ? principal.id : null, adminId: actorType === 'admin' ? principal.id : null,
      identifier: identifier || principal.username, event: 'login', success: true, sessionId, isNewDevice, info,
    }, client);
    if (isNewDevice && actorType === 'user') {
      await notifications.create(principal.id, {
        category: 'security',
        title: 'New sign-in to your account',
        body: `New sign-in from ${deviceLabel(info)}${info.deviceType && info.deviceType !== 'unknown' ? ` (${info.deviceType})` : ''}, IP ${info.ip || 'unknown'}. If this wasn't you, change your password and sign out other sessions from Profile settings.`,
        link: '/profile#sign-ins',
      }, client);
    }
    return ev;
  });
}

// ---------------------------------------------------------------- queries
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function list({ q = '', status = '', actorType = '', event = '', from = '', to = '', newOnly = false, userId = null, page = 1, perPage = 50 } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (userId) where.push(`e.user_id = ${p(userId)}`);
  if (actorType) where.push(`e.actor_type = ${p(actorType)}`);
  if (event) where.push(`e.event = ${p(event)}`);
  if (status === 'success') where.push('e.success');
  if (status === 'failed') where.push('NOT e.success');
  if (newOnly) where.push('e.is_new_device');
  if (DATE_RE.test(from)) where.push(`e.created_at >= ${p(from)}::date`);
  if (DATE_RE.test(to)) where.push(`e.created_at < ${p(to)}::date + 1`);
  if (q) {
    const x = p(`%${q.trim()}%`);
    where.push(`(e.identifier ILIKE ${x} OR u.username ILIKE ${x} OR u.email ILIKE ${x} OR u.full_name ILIKE ${x} OR a.username ILIKE ${x} OR e.ip ILIKE ${x})`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from_ = 'FROM login_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN admin_users a ON a.id = e.admin_id';
  const total = (await db.query(`SELECT count(*)::int AS n ${from_} ${w}`, params)).rows[0].n;
  const lim = p(perPage); const off = p((page - 1) * perPage);
  const { rows } = await db.query(
    `SELECT e.*, u.username AS user_username, u.full_name AS user_full_name, a.username AS admin_username,
            (NOT e.success AND e.created_at > now() - interval '24 hours') AS recent_failure
       ${from_} ${w} ORDER BY e.created_at DESC, e.id DESC LIMIT ${lim} OFFSET ${off}`, params);
  return { rows, total, page, perPage };
}

async function forUser(userId, limit = 20) {
  const { rows } = await db.query(
    `SELECT * FROM login_events WHERE user_id = $1 AND actor_type = 'user' ORDER BY created_at DESC, id DESC LIMIT $2`, [userId, limit]);
  return rows;
}

/** Counts for the admin sidebar badge and page header. */
async function alertCounts() {
  const { rows: [r] } = await db.query(
    `SELECT count(*) FILTER (WHERE is_new_device)::int AS new_devices,
            count(*) FILTER (WHERE NOT success AND event = 'login')::int AS failed
       FROM login_events WHERE created_at > now() - interval '24 hours'`);
  return r;
}

/** Identifiers with repeated failed sign-ins in the last 24 hours. */
async function failedHotspots(limit = 8) {
  const { rows } = await db.query(
    `SELECT e.actor_type, coalesce(u.username, a.username, e.identifier) AS who, e.user_id,
            count(*)::int AS attempts, count(DISTINCT e.ip)::int AS ips, max(e.created_at) AS last_at,
            (array_agg(e.ip ORDER BY e.created_at DESC))[1] AS last_ip,
            (array_agg(e.failure_reason ORDER BY e.created_at DESC))[1] AS last_reason
       FROM login_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN admin_users a ON a.id = e.admin_id
      WHERE NOT e.success AND e.event = 'login' AND e.created_at > now() - interval '24 hours'
      GROUP BY 1, 2, 3 ORDER BY attempts DESC, last_at DESC LIMIT $1`, [limit]);
  return rows;
}

async function activeSessions(actorType, id) {
  const { rows } = await db.query(
    'SELECT * FROM user_sessions WHERE actor_type = $1 AND user_id = $2 ORDER BY signed_in_at DESC NULLS LAST', [actorType, id]);
  return rows;
}

/**
 * Sign a customer out of their sessions (optionally keeping one). Session rows
 * that belong only to the customer are deleted; a row shared with an admin
 * sign-in in the same browser keeps the admin but loses the customer.
 * Returns the number of sessions ended.
 */
async function revokeUserSessions(userId, { exceptSid = null } = {}, client) {
  const { rows: [r] } = await (client || db).query(
    `WITH d AS (
       DELETE FROM "session" WHERE sess ->> 'userId' = $1 AND sess ->> 'adminId' IS NULL AND ($2::text IS NULL OR sid <> $2) RETURNING 1),
     u AS (
       UPDATE "session" SET sess = (sess::jsonb - 'userId' - 'userLogin' - 'transferDraft' - 'remember')::json
        WHERE sess ->> 'userId' = $1 AND sess ->> 'adminId' IS NOT NULL AND ($2::text IS NULL OR sid <> $2) RETURNING 1)
     SELECT (SELECT count(*) FROM d)::int + (SELECT count(*) FROM u)::int AS n`, [String(userId), exceptSid]);
  return r.n;
}

module.exports = {
  EVENTS, parseUserAgent, clientInfo, deviceKey, deviceLabel, sessionMeta, record, recordSuccessfulLogin,
  list, forUser, alertCounts, failedHotspots, activeSessions, revokeUserSessions,
};

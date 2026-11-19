'use strict';
const config = require('./config');
const { createApp } = require('./app');
const { pool } = require('./db/pool');
const { migrate, schemaStatus } = require('./db/migrator');

// ---------------------------------------------------------------- process guards
// A rejected promise nobody handled is a bug, but not a reason to take every
// other user's request down with it: log it loudly with its stack.
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason);
});
// A synchronous exception thrown outside any request leaves the process in an
// unknown state. Log it and exit so the platform (Render/Railway) restarts a
// clean instance, but first stop accepting new connections and let in-flight
// requests finish. A late write to an already-finished response is logged
// and ignored: it cannot corrupt state.
let server;
process.on('uncaughtException', (err) => {
  if (err && err.code === 'ERR_HTTP_HEADERS_SENT') {
    console.error('[process] Ignored late write to a finished response:', err);
    return;
  }
  console.error('[process] Uncaught exception, shutting down:', err);
  process.exitCode = 1;
  shutdown(1);
});

async function prepareDatabase() {
  if (config.autoMigrate) {
    console.log('[db] AUTO_MIGRATE is on: applying pending migrations...');
    await migrate({ allowReset: false });
  }
  const { pending, missingTables } = await schemaStatus();
  if (pending.length || missingTables.length) {
    const detail = [
      pending.length ? `pending migrations: ${pending.join(', ')}` : '',
      missingTables.length ? `missing tables: ${missingTables.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    const e = new Error(`Database not migrated (${detail}). Run \`npm run migrate\`, or start with AUTO_MIGRATE=true.`);
    e.code = 'DB_NOT_MIGRATED';
    throw e;
  }
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => process.exit(code || 1), 10000);
  force.unref();
  const finish = () => pool.end().catch(() => {}).then(() => process.exit(code));
  if (server) server.close(finish); else finish();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

async function main() {
  try {
    await prepareDatabase();
  } catch (e) {
    console.error(`[startup] ${e.message}`);
    if (e.code !== 'DB_NOT_MIGRATED') console.error(e);
    await pool.end().catch(() => {});
    process.exit(1);
  }
  const app = createApp();
  server = app.listen(config.port, () => {
    console.log(`QORVEXA DIGITAL BANK (educational, simulated funds) listening on http://localhost:${config.port}`);
  });
}

main();

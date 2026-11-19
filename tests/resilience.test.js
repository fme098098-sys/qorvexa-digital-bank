'use strict';
const express = require('express');
const h = require('./helpers');
const { errorHandler, safeRender } = require('../src/app');
const { schemaStatus, migrate, REQUIRED_TABLES } = require('../src/db/migrator');

afterAll(() => h.db.pool.end());

describe('response already sent (ERR_HTTP_HEADERS_SENT regression)', () => {
  test('session store failure after the page is written does not crash or double-send', async () => {
    // Reproduces the production crash: the "session" table is missing, so
    // express-session's save fails (Postgres 42P01) after the page has been
    // written and calls next(err). Previously the error handler then rendered a
    // second response, and res.send threw from a process tick.
    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await h.db.query('ALTER TABLE "session" RENAME TO session_moved_for_test');
    try {
      const res = await h.request(h.app).get('/login'); // creates a CSRF token -> session save
      expect(res.status).toBe(200);
      // Wait for the deferred next(err) from the failed session save to run.
      const logged = () => errSpy.mock.calls.flat().map(String).join('\n');
      for (let i = 0; i < 60 && !/not migrated/i.test(logged()); i += 1) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 50)); // a tick for any (formerly crashing) re-render
      expect(uncaught).toEqual([]);
      expect(logged()).toMatch(/not migrated/i);
    } finally {
      await h.db.query('ALTER TABLE session_moved_for_test RENAME TO "session"');
      process.removeListener('uncaughtException', onUncaught);
      errSpy.mockRestore();
    }
    // The app keeps serving afterwards.
    expect((await h.request(h.app).get('/')).status).toBe(200);
  });

  test('error handler never writes to a finished response', async () => {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', require('path').join(__dirname, '..', 'src', 'views'));
    app.get('/x', (req, res, next) => { res.send('first'); next(new Error('late failure')); });
    app.use(errorHandler);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await h.request(app).get('/x');
    errSpy.mockRestore();
    expect(res.status).toBe(200);
    expect(res.text).toBe('first');
  });

  test('safeRender reports a template error once instead of throwing', async () => {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', require('path').join(__dirname, '..', 'src', 'views'));
    app.get('/y', (req, res) => safeRender(res, 'does/not/exist', {}));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await h.request(app).get('/y');
    errSpy.mockRestore();
    expect(res.status).toBe(500);
  });
});

describe('schema checks', () => {
  test('migrations are idempotent and every required table (incl. session) exists', async () => {
    const applied = await migrate({ quiet: true });
    expect(applied).toEqual([]);
    const status = await schemaStatus();
    expect(status).toEqual({ pending: [], missingTables: [] });
    expect(REQUIRED_TABLES).toContain('session');
  });

  test('migrator refuses --reset unless explicitly allowed', async () => {
    await expect(migrate({ reset: true, quiet: true })).rejects.toThrow(/Refusing to reset/);
  });
});

'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const expressLayouts = require('express-ejs-layouts');

const config = require('./config');
const { pool } = require('./db/pool');
const { csrfProtection } = require('./middleware/csrf');
const { loadPrincipals } = require('./middleware/auth');
const { generalLimiter } = require('./middleware/rateLimit');
const fmt = require('./utils/format');
const settings = require('./services/settingsService');

function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('layout', 'layouts/public');
  app.use(expressLayouts);
  app.disable('x-powered-by');

  // Base view helpers (set before CSRF so error pages always render)
  app.use((req, res, next) => {
    res.locals.brand = config.brand;
    res.locals.fmt = fmt;
    res.locals.path = req.path;
    res.locals.title = config.brand.name;
    res.locals.errors = [];
    res.locals.form = {};
    res.locals.year = new Date().getFullYear();
    res.locals.currentUser = null;
    res.locals.currentAdmin = null;
    res.locals.csrfToken = '';
    res.locals.flash = null;
    res.locals.unreadCount = 0;
    res.locals.banner = '';
    res.locals.icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': config.cookieSecure ? [] : null,
      },
    },
    referrerPolicy: { policy: 'same-origin' },
  }));
  app.use(compression());
  if (!config.isTest) app.use(morgan(config.isProd ? 'combined' : 'dev'));

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  const chartJs = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
  app.get('/static/vendor/chart.umd.js', (req, res) => res.sendFile(chartJs, { maxAge: config.isProd ? '7d' : 0 }));
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'img', 'favicon.svg'), { headers: { 'Content-Type': 'image/svg+xml' } }));

  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(express.json({ limit: '50kb' }));

  app.use(session({
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false, pruneSessionInterval: config.isTest ? false : 60 * 15 }),
    name: 'qdb.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: config.sessionTtlMinutes * 60 * 1000,
    },
  }));

  app.use(generalLimiter);
  app.use(csrfProtection);
  app.use(loadPrincipals);
  app.use(async (req, res, next) => {
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    if (req.user) {
      try { res.locals.banner = (await settings.getMap()).maintenance_banner || ''; } catch (e) { return next(e); }
    }
    next();
  });

  app.use('/', require('./routes/public'));
  app.use('/', require('./routes/auth'));
  app.use('/', require('./routes/customer'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('errors/error', { title: 'Page not found', status: 404, message: 'The page you are looking for does not exist.', layout: 'layouts/public' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const message = err.expose ? err.message : 'Something went wrong on our side. Please try again.';
    if (req.xhr || (req.get('accept') || '').includes('application/json')) return res.status(status).json({ error: message });
    res.status(status).render('errors/error', { title: 'Error', status, message, layout: 'layouts/public' });
  });

  return app;
}

module.exports = { createApp };

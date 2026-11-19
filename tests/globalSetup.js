'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  // Rebuild the TEST database schema from migrations before the suite runs.
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate.js'), '--reset'], {
    env: { ...process.env, NODE_ENV: 'test' }, stdio: 'inherit',
  });
};

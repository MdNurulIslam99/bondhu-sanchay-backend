// The way a serverless host starts the app: loaded with require(), without server.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const load = code => spawnSync(process.execPath, ['-e', code], {
  encoding: 'utf8', timeout: 60000,
  env: { PATH: process.env.PATH, NODE_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/x' },
});

test('the app can be loaded with require()', () => {
  const result = load("const app = require('./src/app.js').default; if (typeof app !== 'function') process.exit(2); process.exit(0)");
  assert.equal(result.status, 0, result.stderr);
});

// Starts the real app against a disposable replica set. Never touches the configured database.
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/test';
process.env.PUBLIC_API_URL = 'http://localhost:5001';
process.env.CORS_ORIGIN = 'http://localhost:3000';

export const PASSWORD = 'Password123';

export async function startApp() {
  const { default: app } = await import('../src/app.js');
  const models = await import('../src/models/index.js');
  const { hashPassword } = await import('../src/lib/security.js');
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await models.ensureIndexes();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const passwordHash = await hashPassword(PASSWORD);

  async function request(path, { method = 'GET', body, token, headers = {}, raw } = {}) {
    const response = await fetch(`${root}/api/v1${path}`, { method, headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
    }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json() : await response.text();
    return { status: response.status, body: data, headers: response.headers };
  }
  /** A signed-in client. `ok` asserts the status and returns `data`. */
  function client(token) {
    const call = (method, path, body, extra) => request(path, { method, body, token, ...extra });
    const ok = async (method, path, body, status = method === 'POST' ? 201 : 200) => {
      const result = await call(method, path, body);
      assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.body)}`);
      return result.body.data;
    };
    return { token, call, ok, get: path => ok('GET', path) };
  }
  async function login(email, password = PASSWORD) {
    const result = await request('/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return client(result.body.data.accessToken);
  }
  async function staff(role, { pages, email = `${role}@example.test` } = {}) {
    const user = await models.User.create({ name: `Test ${role}`, email, role, status: 'active', passwordHash });
    const { DEFAULT_PAGES } = await import('../src/lib/permissions.js');
    if (role !== 'super_admin') await models.UserPermission.create({ userId: user._id, status: 'active', pages: pages || DEFAULT_PAGES[role] });
    return { ...await login(email), id: String(user._id) };
  }
  const stop = async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    await replica.stop();
  };
  return { request, client, login, staff, stop, models, root };
}

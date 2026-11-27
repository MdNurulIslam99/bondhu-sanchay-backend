import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, startApp } from './helpers.js';

test('authentication, permissions, member privacy and password reset', { timeout: 180000 }, async t => {
  const app = await startApp();
  t.after(app.stop);
  const { outbox } = await import('../src/lib/notify.js');
  const root = await app.staff('super_admin');
  const post = (path, body, options) => app.request(path, { method: 'POST', body, ...options });

  await t.test('five wrong passwords lock the account, even for the right password', async () => {
    await app.models.User.create({ name: 'Lock', email: 'lock@example.test', role: 'viewer', status: 'active', passwordHash: (await app.models.User.findOne({ email: 'super_admin@example.test' }).select('+passwordHash')).passwordHash });
    for (let n = 0; n < 5; n++) {
      const result = await post('/auth/login', { email: 'lock@example.test', password: 'wrong' });
      assert.equal(result.status, 401);
      assert.equal(result.body.message, 'Incorrect email or password.');
    }
    const locked = await post('/auth/login', { email: 'lock@example.test', password: PASSWORD });
    assert.equal(locked.status, 429);
    assert.match(locked.body.message, /Try again in 5 minutes/);
    await app.models.LoginAttempt.deleteMany({});
  });

  await t.test('unknown and inactive accounts get the same generic answer', async () => {
    await app.models.User.create({ name: 'Off', email: 'off@example.test', role: 'viewer', status: 'inactive' });
    for (const email of ['nobody@example.test', 'off@example.test']) {
      assert.equal((await post('/auth/login', { email, password: PASSWORD })).body.message, 'Incorrect email or password.');
    }
    await app.models.LoginAttempt.deleteMany({});
  });

  await t.test('cookie sessions need an allowed origin for writes; bearer does not', async () => {
    const login = await post('/auth/login', { email: 'super_admin@example.test', password: PASSWORD }, { headers: { origin: 'http://localhost:3000' } });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    assert.match(login.headers.getSetCookie()[0], /HttpOnly/);
    assert.equal((await app.request('/auth/me', { headers: { cookie } })).status, 200);
    const faq = { question: 'Cookie?', answer: 'Yes.' };
    assert.equal((await post('/faqs', faq, { headers: { cookie } })).status, 403);
    assert.equal((await post('/faqs', faq, { headers: { cookie, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await post('/faqs', faq, { headers: { cookie, origin: 'http://localhost:3000' } })).status, 201);
    assert.equal((await post('/auth/login', { email: 'a@b.test', password: 'x' }, { headers: { origin: 'https://evil.example' } })).status, 403);
  });

  await t.test('permission matrix: pages come from the user, actions from the role', async () => {
    const viewer = await app.staff('viewer');
    const accountant = await app.staff('accountant');
    const admin = await app.staff('admin');
    const limited = await app.staff('admin', { email: 'limited@example.test', pages: ['faqs'] });
    const member = { name: 'Perm Member', phone: '01711111111' };
    assert.equal((await app.request('/members')).status, 401);
    await viewer.get('/members');
    assert.equal((await viewer.call('POST', '/members', member)).status, 403);
    assert.equal((await accountant.call('POST', '/members', member)).status, 403);
    const row = await admin.ok('POST', '/members', member);
    await accountant.ok('PATCH', `/members/${row.id}`, { address: 'Dhaka' });
    assert.equal((await accountant.call('DELETE', `/members/${row.id}`)).status, 403);
    assert.equal((await limited.call('GET', '/payments')).status, 403);
    await limited.get('/faqs');
    for (const path of ['/users', '/user-permissions', '/role-actions']) assert.equal((await admin.call('GET', path)).status, 403, path);
    assert.equal((await admin.call('PUT', '/role-actions', {})).status, 403);
    // A role change applies to the very next request.
    const roles = await root.get('/role-actions');
    await root.ok('PUT', '/role-actions', { ...roles, viewer: { ...roles.viewer, faqs: ['view', 'create'], messages: ['view'] } });
    await viewer.ok('POST', '/faqs', { question: 'Now?', answer: 'Allowed.' });
    await root.ok('POST', '/role-actions/reset', undefined, 200);
    assert.equal((await viewer.call('POST', '/faqs', { question: 'Again?', answer: 'No.' })).status, 403);
    // An inactive permission row removes every page.
    const permission = (await root.get(`/user-permissions?userId=${viewer.id}`))[0];
    await root.ok('PUT', `/user-permissions/${permission.id}`, { status: 'inactive' });
    assert.equal((await viewer.call('GET', '/members')).status, 403);
    const me = (await limited.call('GET', '/auth/me')).body.data;
    assert.deepEqual(me.pages, ['faqs']);
    assert.deepEqual(me.actions.faqs, ['view', 'create', 'update', 'delete']);
  });

  await t.test('users: temporary password, self protection and last super admin', async () => {
    const created = await root.ok('POST', '/users', { name: 'New Staff', email: 'new@example.test', role: 'accountant', status: 'active', password: 'Temp12345' });
    assert.equal(created.passwordHash, undefined);
    const fresh = await app.login('new@example.test', 'Temp12345');
    assert.equal((await fresh.call('GET', '/members')).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    const changed = await fresh.ok('POST', '/auth/change-password', { currentPassword: 'Temp12345', password: 'Better12345' }, 200);
    assert.equal((await fresh.call('GET', '/auth/me')).status, 401); // old session revoked
    await app.client(changed.accessToken).get('/auth/me');
    assert.equal((await root.call('DELETE', `/users/${root.id}`)).status, 409);
    assert.equal((await root.call('PATCH', `/users/${root.id}`, { status: 'inactive' })).status, 409);
    await root.ok('POST', '/user-permissions', { userId: created.id, pages: ['faqs', 'messages'] });
    await root.ok('DELETE', `/users/${created.id}`);
    assert.equal(await app.models.UserPermission.countDocuments({ userId: created.id }), 0);
    assert.equal((await app.client(changed.accessToken).call('GET', '/auth/me')).status, 401);
  });

  await t.test('refresh replaces the token; logout ends it', async () => {
    const first = await app.login('super_admin@example.test');
    const next = await first.ok('POST', '/auth/refresh', undefined, 200);
    assert.equal((await first.call('GET', '/auth/me')).status, 401);
    const second = app.client(next.accessToken);
    await second.get('/auth/me');
    await second.ok('POST', '/auth/logout', undefined, 200);
    assert.equal((await second.call('GET', '/auth/me')).status, 401);
  });

  await t.test('idle sessions expire after 30 minutes', async () => {
    const idle = await app.login('super_admin@example.test');
    await app.models.Session.updateMany({}, { lastSeenAt: new Date(Date.now() - 31 * 60 * 1000) });
    assert.equal((await idle.call('GET', '/auth/me')).status, 401);
  });

  await t.test('website sign-up cannot see member data until an admin approves it', async () => {
    const boss = await app.login('super_admin@example.test');
    const target = await boss.ok('POST', '/members', { name: 'Real Member', phone: '01722222222', status: 'active', nid: '1234567890' });
    await boss.ok('POST', '/members', { name: 'Other Member', phone: '01733333333', status: 'active', nid: '9999999999' });
    const signup = { name: 'Real Member', email: 'real@example.test', phone: '+8801722222222', password: PASSWORD, agreeToTerms: true };
    assert.equal((await post('/auth/signup', { ...signup, role: 'super_admin' })).status, 422);
    const created = await post('/auth/signup', signup);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.user.role, 'member');
    assert.equal(created.body.data.user.membershipStatus, 'pending');
    assert.equal((await post('/auth/signup', { ...signup, email: 'second@example.test' })).status, 409);
    const person = app.client(created.body.data.accessToken);
    for (const path of ['/members', `/members/${target.id}`, '/dashboard', '/reports/monthly', '/profit-sheet']) {
      assert.equal((await person.call('GET', path)).status, 403, path);
    }
    for (const path of ['/payment-submissions', '/admin/payments', '/payments', '/dues', '/audit-logs', '/settings', '/faqs', '/users']) {
      assert.equal((await person.call('GET', path)).status, 403, path);
    }
    assert.equal((await person.get('/me/account')).member, null);
    const accounts = await boss.get('/member-accounts?status=pending');
    await boss.ok('POST', `/member-accounts/${accounts[0].id}/approve`, undefined, 200);
    const directory = await person.get('/members');
    assert.equal(directory.length >= 2, true);
    assert.equal(directory.some(row => row.phone === '01733333333'), true);
    assert.equal(directory.some(row => 'nid' in row || 'address' in row), false);
    const detail = await person.get(`/members/${target.id}`);
    assert.equal('nid' in detail || 'payments' in detail, false);
    assert.equal((await person.get('/me/account')).member.name, 'Real Member');
    await person.get('/dashboard');
    await person.get('/reports/monthly');
    await person.get('/profit-sheet');
    assert.equal((await person.call('GET', '/dues')).status, 403);
    await boss.ok('POST', `/member-accounts/${accounts[0].id}/reject`, undefined, 200);
    assert.equal((await person.call('GET', '/members')).status, 403);
  });

  await t.test('one-time code: same answer for any account, limited tries, never returned', async () => {
    const forgot = identifier => post('/auth/password/forgot', { identifier });
    const unknown = await forgot('ghost@example.test');
    const known = await forgot('real@example.test');
    assert.deepEqual([unknown.status, known.status], [202, 202]);
    assert.deepEqual(Object.keys(unknown.body.data), Object.keys(known.body.data));
    assert.equal(outbox.length, 1);
    assert.equal(JSON.stringify(known.body).includes(outbox[0].code), false);
    assert.equal((await forgot('real@example.test')).status, 429);
    const { resetToken } = known.body.data;
    const wrong = outbox[0].code === '000000' ? '111111' : '000000';
    assert.equal((await post('/auth/password/reset', { resetToken, password: 'Another123' })).status, 400);
    assert.match((await post('/auth/password/verify-otp', { resetToken, code: wrong })).body.message, /4 attempts left/);
    assert.equal((await post('/auth/password/verify-otp', { resetToken, code: outbox[0].code })).status, 200);
    assert.equal((await post('/auth/password/reset', { resetToken, password: 'Another123' })).status, 200);
    assert.equal((await post('/auth/password/reset', { resetToken, password: 'Another1234' })).status, 400);
    await app.login('real@example.test', 'Another123');
    // Five wrong guesses end the code.
    await app.models.PasswordReset.deleteMany({});
    const again = await forgot('real@example.test');
    for (let n = 0; n < 5; n++) await post('/auth/password/verify-otp', { resetToken: again.body.data.resetToken, code: '999999' === outbox.at(-1).code ? '888888' : '999999' });
    assert.equal((await post('/auth/password/verify-otp', { resetToken: again.body.data.resetToken, code: outbox.at(-1).code })).status, 400);
  });
});

// Sends data shaped exactly like the admin panel's forms (src/lib/store.jsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, startApp } from './helpers.js';

test('admin panel form payloads are accepted', { timeout: 180000 }, async t => {
  const app = await startApp();
  t.after(app.stop);
  const root = await app.staff('super_admin');

  await t.test('members, including empty optional fields and a full edit', async () => {
    const form = { status: 'pending', monthly: 500, joinDate: '', name: 'Form Member', phone: '', nid: '', address: '', nominee: '' };
    const first = await root.ok('POST', '/members', form);
    await root.ok('POST', '/members', { ...form, name: 'Second Without Phone' });
    await root.ok('PATCH', `/members/${first.id}`, { ...form, address: 'Dhaka' });
    await root.ok('PATCH', `/members/${first.id}`, { status: 'active' });
  });

  await t.test('settings saved with everything that was read', async () => {
    const read = await root.get('/settings');
    await root.ok('PUT', '/settings', { ...read, phone: '01700000000' });
  });

  await t.test('investment, profit, project and section forms', async () => {
    await root.ok('POST', '/investments', { status: 'running', name: 'Mukto', investDate: '2026-07-01', amount: 20000, monthlyProfit: 700, firstProfitMonth: '2026-07' });
    const record = await root.ok('POST', '/profits', { account: 'Mukto', month: '2026-07', collected: 700, cost: 0, note: '' });
    await root.ok('PATCH', `/profits/${record.id}`, { collected: 650, cost: 50, note: 'fee' });
    const project = { name: 'Form Project', account: 'Mukto', businessType: 'Other', status: 'running', startDate: '2026-07-01', location: '', contactPerson: '',
      contactMobile: '', showOnWebsite: 'yes', summary: '', images: [], description: '' };
    const saved = await root.ok('POST', '/projects', project);
    await root.ok('PATCH', `/projects/${saved.id}`, { ...project, name: 'Renamed Project' });
    const page = await root.ok('POST', '/page-names', { status: 'active', name: 'হোম' });
    assert.match(page.slug, /^page-[a-f0-9]{6}$/);
    await root.ok('POST', '/page-sections', { pageId: page.id, sectionHeader: 'Section 1', title: 'T', subTitle: '', status: 'active', position: 1, images: [], description: '' });
    await root.ok('PUT', '/role-actions', await root.get('/role-actions'));
  });

  await t.test('profit payments can be booked on an account without being counted twice', async () => {
    const signup = await app.request('/auth/signup', { method: 'POST', body: { name: 'Payer', email: 'payer@example.test', phone: '01744444444', password: PASSWORD, agreeToTerms: true } });
    const payer = app.client(signup.body.data.accessToken);
    const payment = (await payer.call('POST', '/payments', { paymentDate: '2026-08-02', amount: 300, months: [], category: 'profit', method: 'cash' })).body.data;
    assert.equal(payment.memberId, null);
    const before = (await root.get('/dashboard')).profit;
    const [account] = await root.get('/investment-accounts');
    await root.ok('POST', `/admin/payments/${payment.id}/approve`, { accountId: account.id, month: '2026-08' }, 200);
    assert.equal((await root.get('/dashboard')).profit, before + 300);
    await root.ok('POST', `/payment-submissions/${payment.id}/reopen`, { reason: 'Wrong account' }, 200);
    assert.equal((await root.get('/dashboard')).profit, before);
  });

  await t.test('a savings payment from an unlinked account needs a member first', async () => {
    const signup = await app.request('/auth/signup', { method: 'POST', body: { name: 'Stranger', email: 'stranger@example.test', phone: '01766666666', password: PASSWORD, agreeToTerms: true } });
    const stranger = app.client(signup.body.data.accessToken);
    const payment = (await stranger.call('POST', '/payments', { paymentDate: '2026-08-02', amount: 500, months: ['2026-08'], category: 'savings', method: 'cash' })).body.data;
    assert.equal((await root.call('POST', `/admin/payments/${payment.id}/approve`, {})).status, 422);
    await root.ok('PATCH', `/payment-submissions/${payment.id}`, { member: 'Form Member' });
    await root.ok('POST', `/payment-submissions/${payment.id}/review`, { decision: 'verified' }, 200);
  });
});

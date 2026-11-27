import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startApp } from './helpers.js';

test('admin changes appear on the public website, and private data never does', { timeout: 180000 }, async t => {
  const app = await startApp();
  t.after(app.stop);
  const root = await app.staff('super_admin');
  const open = async path => {
    const result = await app.request(path);
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };

  await t.test('notices follow the published switch immediately', async () => {
    const notice = await root.ok('POST', '/notices', { title: 'Meeting', body: 'Friday', date: '2026-11-01', published: 'yes' });
    assert.equal((await open('/public/notices'))[0].title, 'Meeting');
    await root.ok('PATCH', `/notices/${notice.id}`, { published: 'no' });
    assert.deepEqual(await open('/public/notices'), []);
  });

  await t.test('pages and sections: order, sanitising, deactivation and cascade', async () => {
    const page = await root.ok('POST', '/page-names', { name: 'About Us', status: 'active' });
    assert.equal(page.slug, 'about-us');
    assert.equal((await root.call('POST', '/page-names', { name: 'about us' })).status, 409);
    const add = body => root.ok('POST', '/page-sections', { pageId: page.id, sectionHeader: 'Section 1', status: 'active', ...body });
    await add({ title: 'Third', position: 3 });
    await add({ title: 'Later section', sectionHeader: 'Section 2', position: 1 });
    await add({ title: 'First', position: 1, description: '<p onclick="x()" style="color:red">Hi <b>there</b></p><script>alert(1)</script><a href="javascript:alert(1)">x</a>' });
    assert.deepEqual(await root.get(`/page-sections/next-position?pageId=${page.id}&sectionHeader=Section%201`), { position: 4 });
    await add({ title: 'Second', position: 2 });
    const published = await open('/public/pages/about-us');
    assert.deepEqual(published.sections.map(row => row.title), ['First', 'Second', 'Third', 'Later section']);
    assert.equal(published.sections[0].description, '<p>Hi <strong>there</strong></p><a rel="noopener noreferrer">x</a>');
    assert.equal((await root.get('/page-names'))[0].sectionCount, 4);
    await root.ok('PATCH', `/page-names/${page.id}`, { status: 'inactive' });
    assert.equal((await app.request('/public/pages/about-us')).status, 404);
    assert.deepEqual((await open('/public/site-content')).pages, []);
    await root.ok('DELETE', `/page-names/${page.id}`);
    assert.equal(await app.models.PageSection.countDocuments(), 0);
  });

  await t.test('projects: hidden unless published; contact data never public; money follows the setting', async () => {
    await root.ok('POST', '/investments', { name: 'SecretInvestor', investDate: '2026-04-01', amount: 40000, monthlyProfit: 2000, firstProfitMonth: '2026-04' });
    const project = await root.ok('POST', '/projects', { name: 'Shop', account: 'SecretInvestor', businessType: 'Retail Shop', status: 'running', startDate: '2026-04-01',
      location: 'Dhaka', contactPerson: 'HiddenPerson', contactMobile: '01799999999', showOnWebsite: 'yes', summary: 'A shop', description: '<p>Ok</p>', images: ['https://images.example.com/a.jpg'] });
    assert.equal(project.invested, 40000);
    assert.equal((await root.call('POST', '/projects', { name: 'Bad', account: 'SecretInvestor', businessType: 'Retail Shop', startDate: '2026-04-01', images: ['javascript:alert(1)'] })).status, 422);
    const shown = await open('/public/investments/shop');
    assert.deepEqual([shown.amount, shown.partner, shown.tranches.length], [40000, 'SecretInvestor', 1]);
    await root.ok('PUT', '/settings', { publicShowMoney: false, phone: '01800000000', monthlyAmount: 600 });
    const bundle = JSON.stringify([await open('/public/site-content'), await open('/public/projects/shop'), await open('/public/summary'), await open('/public/projects')]);
    for (const secret of ['SecretInvestor', 'HiddenPerson', '01799999999', '40000', '"amount"', '"profit"', '"invested"', 'contactMobile', 'accountId']) assert.equal(bundle.includes(secret), false, secret);
    const settings = await open('/public/settings');
    assert.deepEqual([settings.phone, settings.monthlyAmount], ['01800000000', 600]);
    await root.ok('PATCH', `/projects/${project.id}`, { showOnWebsite: 'no' });
    assert.deepEqual(await open('/public/projects'), []);
    assert.equal((await app.request('/public/projects/shop')).status, 404);
    await root.ok('PUT', '/settings', { publicShowMoney: true });
  });

  await t.test('FAQs, ETag revalidation and member applications', async () => {
    const faq = await root.ok('POST', '/faqs', { question: 'Q?', answer: 'A.' });
    const first = await app.request('/public/faqs');
    assert.equal(first.body.data.length, 1);
    const etag = first.headers.get('etag');
    const cached = await app.request('/public/faqs', { headers: { 'if-none-match': etag, 'cache-control': 'max-age=0' } });
    assert.equal(cached.status, 304);
    await root.ok('PATCH', `/faqs/${faq.id}`, { published: 'no' });
    assert.deepEqual(await open('/public/faqs'), []);
    const apply = body => app.request('/public/member-applications', { method: 'POST', body: { name: 'Applicant', phone: '01755555555', ...body } });
    assert.equal((await apply({ website: 'spam' })).status, 202);
    assert.equal(await app.models.Member.countDocuments(), 0);
    const replies = [await apply({}), await apply({})];
    assert.deepEqual(replies.map(reply => reply.status), [202, 202]);
    assert.equal(replies[0].body.data, null);
    assert.equal(await app.models.Member.countDocuments(), 1);
    const [pending] = await root.get('/members?status=pending');
    assert.deepEqual(await open('/public/members'), []);
    await root.ok('PATCH', `/members/${pending.id}/status`, { status: 'active' });
    const [listed] = await open('/public/members');
    assert.equal(listed.phoneMasked, '0175•••5555');
    assert.equal(JSON.stringify(listed).includes('01755555555'), false);
    assert.equal((await root.get(`/members/${pending.id}`)).joinDate.length, 10);
  });

  await t.test('images are checked by content and served publicly', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const send = async (data, name, token = root.token) => {
      const form = new FormData();
      form.set('file', new Blob([data], { type: 'image/png' }), name);
      return app.request('/uploads', { method: 'POST', raw: form, token });
    };
    assert.equal((await send(Buffer.from('<script>'), 'fake.png')).status, 422);
    assert.equal((await send(Buffer.alloc(5 * 1024 * 1024 + 1), 'big.png')).status, 422);
    const viewer = await app.staff('viewer');
    assert.equal((await send(png, 'a.png', viewer.token)).status, 403);
    const uploaded = await send(png, 'a.png');
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const file = await fetch(uploaded.body.data.url.replace('http://localhost:5001', app.root));
    assert.deepEqual([file.status, file.headers.get('content-type'), file.headers.get('cross-origin-resource-policy')], [200, 'image/png', 'cross-origin']);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  });

  await t.test('the message inbox is switched off', async () => {
    assert.equal((await app.request('/public/messages', { method: 'POST', body: {} })).status, 404);
    assert.equal((await root.call('GET', '/messages')).status, 404);
    assert.equal((await root.call('GET', '/auth/me')).body.data.pages.includes('messages'), false);
  });

  await t.test('the switched-off message module still loads and registers its routes', async () => {
    const { createApi } = await import('../src/lib/api.js');
    const { default: routes } = await import('../src/modules/messages.js');
    const api = createApi();
    routes(api);
    assert.equal(api.routes.length, 4);
    express().use(api.router);
  });

  await t.test('the API document covers the routes', async () => {
    const result = await app.request('/openapi.json');
    assert.equal(result.status, 200);
    assert.ok(result.body.paths['/auth/login'].post.requestBody);
    assert.equal(result.body.paths['/messages'], undefined);
  });
});

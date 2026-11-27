// Every admin change that visitors can see must be on the very next public read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

test('every admin write is visible on the public API at once', { timeout: 180000 }, async t => {
  const app = await startApp();
  t.after(app.stop);
  const root = await app.staff('super_admin');
  const open = async path => {
    const result = await app.request(path);
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };
  const gone = async path => assert.equal((await app.request(path)).status, 404, path);
  const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row?.[key]]));
  const has = (row, expected) => assert.deepEqual(pick(row, Object.keys(expected)), expected);

  await t.test('every setting', async () => {
    const values = { orgName: 'New Name', tagline: 'New tagline', about: 'New about', phone: '01812345678', monthlyAmount: 700, dueDay: 5, fine: 35,
      collectionStart: '2026-01', lastCollectionMonth: '2026-06', profitThroughMonth: '2026-05', publicShowMoney: true };
    for (const [method, path] of [['PUT', '/settings'], ['PUT', '/admin/settings']]) {
      for (const [key, value] of Object.entries(values)) {
        await root.ok(method, path, { [key]: value });
        assert.deepEqual((await open('/public/settings'))[key], value, `settings.${key}`);
        assert.deepEqual((await open('/public/site-content')).settings[key], value, `site-content.settings.${key}`);
      }
    }
    await root.ok('PUT', '/admin/settings/profit-sheet-through', { month: '2026-06' });
    has(await open('/public/settings'), { ...values, profitThroughMonth: '2026-06' });
  });

  let member;
  await t.test('members: add, edit, deactivate, reactivate, delete', async () => {
    member = await root.ok('POST', '/members', { name: 'Rahim Uddin', phone: '01711000001', status: 'active', joinDate: '2026-01-01' });
    const listed = async () => (await open('/public/members')).find(row => row.id === member.id);
    has(await listed(), { name: 'Rahim Uddin', phoneMasked: '0171•••0001' });
    await root.ok('PATCH', `/members/${member.id}`, { name: 'Karim Ali', phone: '01922000002' });
    has(await listed(), { name: 'Karim Ali', initials: 'KA', phoneMasked: '0192•••0002' });
    await root.ok('PUT', `/admin/members/${member.id}`, { name: 'Karim Mia' });
    has(await listed(), { name: 'Karim Mia' });
    await root.ok('PATCH', `/members/${member.id}/status`, { status: 'inactive' });
    assert.equal(await listed(), undefined);
    assert.equal((await open('/public/summary')).members, 0);
    await root.ok('PATCH', `/members/${member.id}/status`, { status: 'active' });
    assert.equal((await open('/public/summary')).members, 1);
    const other = await root.ok('POST', '/members', { name: 'Temp', phone: '01711000003', status: 'active' });
    assert.equal((await open('/public/summary')).members, 2);
    await root.ok('DELETE', `/members/${other.id}`);
    assert.equal((await open('/public/summary')).members, 1);
  });

  const totals = async expected => {
    has(await open('/public/summary'), expected);
    has((await open('/public/site-content')).summary, expected);
  };

  await t.test('deposits and payment submissions change the public totals', async () => {
    const deposit = await root.ok('POST', '/admin/deposits', { memberId: member.id, month: '2026-01', amount: 700, status: 'verified' });
    await totals({ collected: 700 });
    await root.ok('PATCH', `/payments/${deposit.id}/status`, { status: 'reversed' });
    await totals({ collected: 0 });
    const pay = body => root.ok('POST', '/payment-submissions', { memberId: member.id, date: '2026-01-10', type: 'Cash', ...body });
    const savings = await pay({ amount: 700, category: 'savings', months: ['2026-02'] });
    await totals({ collected: 0 });
    await root.ok('POST', `/payment-submissions/${savings.id}/review`, { decision: 'verified' }, 200);
    await totals({ collected: 700 });
    await root.ok('POST', `/payment-submissions/${savings.id}/reopen`, { reason: 'Check again' }, 200);
    await totals({ collected: 0 });
    await root.ok('POST', `/admin/payments/${savings.id}/approve`, {}, 200);
    await totals({ collected: 700 });
    await root.ok('DELETE', `/payment-submissions/${savings.id}`);
    await totals({ collected: 0 });
    const profit = await pay({ amount: 300, category: 'profit' });
    await root.ok('POST', `/payment-submissions/${profit.id}/review`, { decision: 'verified' }, 200);
    await totals({ profit: 300 });
    await root.ok('DELETE', `/payment-submissions/${profit.id}`);
    await totals({ profit: 0 });
  });

  await t.test('investments, profit records and account names', async () => {
    const entry = await root.ok('POST', '/investments', { name: 'Partner', investDate: '2026-01-05', amount: 10000, monthlyProfit: 400, firstProfitMonth: '2026-01' });
    const project = await root.ok('POST', '/projects', { name: 'Mill', accountId: entry.accountId, businessType: 'Agriculture', startDate: '2026-01-05', showOnWebsite: 'yes' });
    const money = async expected => {
      for (const path of ['/public/projects', '/public/investments']) has((await open(path)).find(row => row.id === 'mill'), expected);
      has((await open('/public/projects/mill')), expected);
      has((await open('/public/site-content')).projects[0], expected);
    };
    await money({ partner: 'Partner', amount: 10000, monthlyProfit: 400, profit: 0 });
    await totals({ invested: 10000 });
    await root.ok('PATCH', `/investments/${entry.id}`, { amount: 12000, monthlyProfit: 500 });
    await money({ amount: 12000, monthlyProfit: 500 });
    const record = await root.ok('POST', '/profits', { accountId: entry.accountId, month: '2026-01', collected: 450 });
    await money({ profit: 450 });
    await totals({ profit: 450 });
    await root.ok('PATCH', `/profits/${record.id}`, { collected: 480, cost: 20 });
    await money({ profit: 480 });
    // A month after the closed profit sheet still counts in the public totals.
    await root.ok('POST', '/profits', { accountId: entry.accountId, month: '2026-11', collected: 100 });
    await money({ profit: 580 });
    await totals({ invested: 12000, profit: 580 });
    await root.ok('PATCH', `/investment-accounts/${entry.accountId}`, { name: 'New Partner' });
    await money({ partner: 'New Partner' });
    const more = await root.ok('POST', '/investments', { accountId: entry.accountId, investDate: '2026-02-01', amount: 1000, monthlyProfit: 50, firstProfitMonth: '2026-02' });
    assert.equal((await open('/public/projects/mill')).tranches.length, 2);
    await root.ok('DELETE', `/investments/${more.id}?confirm=true`);
    await money({ amount: 12000, monthlyProfit: 500 });
    await totals({ invested: 12000 });
    await root.ok('PUT', `/projects/${project.id}`, { name: 'Rice Mill', description: '<p>New</p>', facts: [['Where', 'Jashore']], sortOrder: 3 });
    await money({ name: 'Rice Mill' });
    has(await open('/public/projects/mill'), { description: '<p>New</p>', facts: [['Where', 'Jashore']], sortOrder: 3 });
    await root.ok('DELETE', `/projects/${project.id}`);
    assert.deepEqual(await open('/public/projects'), []);
    await gone('/public/projects/mill');
  });

  await t.test('pages and sections', async () => {
    const page = await root.ok('POST', '/page-names', { name: 'Home', status: 'active' });
    const next = await root.ok('POST', '/page-names', { name: 'About', status: 'active' });
    const section = await root.ok('POST', '/page-sections', { pageId: page.id, sectionHeader: 'Section 1', title: 'Old', status: 'active' });
    const shown = async () => (await open('/public/pages/home')).sections[0];
    const everywhere = async expected => {
      has(await shown(), expected);
      has((await open('/public/pages')).find(row => row.slug === 'home').sections[0], expected);
      has((await open('/public/site-content')).pages.find(row => row.slug === 'home').sections[0], expected);
    };
    await everywhere({ title: 'Old' });
    const changes = { title: 'New', subTitle: 'Sub', description: '<p>Text</p>', images: ['https://images.example.com/c.jpg'], sectionHeader: 'Section 2', position: 4 };
    await root.ok('PATCH', `/page-sections/${section.id}`, changes);
    await everywhere(changes);
    await root.ok('PUT', `/admin/page-sections/${section.id}`, { title: 'Newer' });
    await everywhere({ title: 'Newer' });
    await root.ok('PATCH', `/page-sections/${section.id}`, { status: 'inactive' });
    assert.equal(await shown(), undefined);
    await root.ok('PATCH', `/page-sections/${section.id}`, { status: 'active', pageId: next.id });
    assert.equal(await shown(), undefined);
    assert.equal((await open('/public/pages/about')).sections[0].title, 'Newer');
    await root.ok('PATCH', `/page-names/${next.id}`, { name: 'Our Story', order: 0 });
    assert.equal((await open('/public/pages'))[0].name, 'Our Story');
    await root.ok('DELETE', `/page-sections/${section.id}`);
    assert.deepEqual((await open('/public/pages/about')).sections, []);
    await root.ok('DELETE', `/page-names/${next.id}`);
    await gone('/public/pages/about');
  });

  for (const [path, created, changed] of [
    ['faqs', { question: 'Old?', answer: 'Old.' }, { question: 'New?', answer: 'New.' }],
    ['notices', { title: 'Old', body: 'Old', date: '2026-01-01', published: 'yes' }, { title: 'New', body: 'New', date: '2026-02-01' }],
  ]) {
    await t.test(path, async () => {
      const row = await root.ok('POST', `/${path}`, { published: 'yes', ...created });
      const both = async () => {
        const list = await open(`/public/${path}`);
        assert.deepEqual((await open('/public/site-content'))[path], list);
        return list;
      };
      const { published, ...first } = created;
      has((await both())[0], first);
      await root.ok('PATCH', `/${path}/${row.id}`, changed);
      has((await both())[0], changed);
      await root.ok('PATCH', `/${path}/${row.id}`, { published: 'no' });
      assert.deepEqual(await both(), []);
      await root.ok('PUT', `/admin/${path}/${row.id}`, { published: 'yes' });
      assert.equal((await both()).length, 1);
      await root.ok('DELETE', `/${path}/${row.id}`);
      assert.deepEqual(await both(), []);
    });
  }
});

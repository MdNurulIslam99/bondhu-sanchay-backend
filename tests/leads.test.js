// Website applications wait as lead members until staff accept them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

test('lead members', { timeout: 180000 }, async t => {
  const app = await startApp();
  t.after(app.stop);
  const root = await app.staff('super_admin');
  await root.ok('PUT', '/settings', { monthlyAmount: 600 });
  const apply = async (name, phone, extra = {}) => {
    const result = await app.request('/public/member-applications', { method: 'POST', body: { name, phone, ...extra } });
    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.data, null);
  };
  const members = () => app.models.Member.countDocuments();
  const publicCount = async () => (await app.request('/public/summary')).body.data.members;

  await apply('Rahim Uddin', '+8801711000001', { nid: '1234567890', address: 'Dhaka', nominee: 'Karim' });
  let lead;

  await t.test('an application is a lead, not a member', async () => {
    assert.equal(await members(), 0);
    assert.deepEqual(await root.get('/members'), []);
    [lead] = await root.get('/member-leads');
    assert.deepEqual([lead.name, lead.phone, lead.nid, lead.address, lead.nominee], ['Rahim Uddin', '01711000001', '1234567890', 'Dhaka', 'Karim']);
    assert.deepEqual(await root.get(`/admin/member-leads/${lead.id}`), lead);
    assert.equal((await root.get('/member-leads?search=rahim')).length, 1);
    assert.equal((await root.get('/member-leads?search=nobody')).length, 0);
    const csv = await root.call('GET', '/member-leads?format=csv');
    assert.match(csv.body, /01711000001/);
    await apply('Same number', '01711000001');
    assert.equal(await app.models.MemberLead.countDocuments(), 1);
  });

  await t.test('only the right staff can read and change leads', async () => {
    const viewer = await app.staff('viewer');
    const accountant = await app.staff('accountant');
    assert.equal((await app.request('/member-leads')).status, 401);
    await viewer.get('/member-leads');
    for (const [method, path, body] of [['PATCH', '', { name: 'Changed' }], ['DELETE', ''], ['POST', '/accept']]) {
      assert.equal((await viewer.call(method, `/member-leads/${lead.id}${path}`, body)).status, 403, method);
    }
    await accountant.ok('PATCH', `/member-leads/${lead.id}`, { note: 'Called him' });
    assert.equal((await accountant.call('POST', `/member-leads/${lead.id}/accept`)).status, 403);
    assert.equal((await accountant.call('DELETE', `/member-leads/${lead.id}`)).status, 403);
  });

  await t.test('update checks the details', async () => {
    await apply('Second', '01711000002');
    assert.equal((await root.call('PATCH', `/member-leads/${lead.id}`, { phone: '123' })).status, 422);
    assert.equal((await root.call('PATCH', `/member-leads/${lead.id}`, { phone: '01711000002' })).status, 409);
    assert.equal((await root.call('PATCH', `/member-leads/${lead.id}`, { status: 'active' })).status, 422);
    const saved = await root.ok('PUT', `/member-leads/${lead.id}`, { name: 'Rahim Mia', nid: '' });
    assert.deepEqual([saved.name, saved.nid, saved.phone, saved.note], ['Rahim Mia', '', '01711000001', 'Called him']);
  });

  await t.test('accepting makes exactly one active member, even when clicked twice', async () => {
    const results = await Promise.all([1, 2, 3].map(() => root.call('POST', `/member-leads/${lead.id}/accept`, { joinDate: '2026-11-01' })));
    assert.deepEqual(results.map(result => result.status).sort(), [201, 404, 404], JSON.stringify(results.map(result => result.body.message)));
    const [member] = await root.get('/members');
    assert.deepEqual([member.name, member.phone, member.address, member.nominee, member.status, member.monthly, member.joinDate, member.sl],
      ['Rahim Mia', '01711000001', 'Dhaka', 'Karim', 'active', 600, '2026-11-01', 1]);
    assert.equal(await members(), 1);
    assert.equal(await publicCount(), 1);
    assert.deepEqual((await root.get('/member-leads')).map(row => row.name), ['Second']);
    // A number that already belongs to a member does not become a lead again.
    await apply('Rahim again', '01711000001');
    assert.equal(await app.models.MemberLead.countDocuments(), 1);
  });

  await t.test('a lead whose number a member now has cannot be accepted', async () => {
    const [second] = await root.get('/member-leads');
    await root.ok('POST', '/members', { name: 'Added by hand', phone: '01711000002' });
    const refused = await root.call('POST', `/member-leads/${second.id}/accept`);
    assert.deepEqual([refused.status, refused.body.error.code], [409, 'DUPLICATE_RECORD']);
    assert.equal(await app.models.MemberLead.countDocuments(), 1);
    const corrected = await root.ok('PATCH', `/member-leads/${second.id}`, { phone: '01711000003' });
    assert.equal(corrected.phone, '01711000003');
    const member = await root.ok('POST', `/member-leads/${second.id}/accept`, { monthly: 1000 });
    assert.deepEqual([member.monthly, member.joinDate.length, member.sl], [1000, 10, 3]);
  });

  await t.test('delete removes only the lead', async () => {
    await apply('Spam', '01711000009');
    const [spam] = await root.get('/member-leads');
    await root.ok('DELETE', `/member-leads/${spam.id}`);
    assert.deepEqual(await root.get('/member-leads'), []);
    assert.equal((await root.call('GET', `/member-leads/${spam.id}`)).status, 404);
    assert.equal(await members(), 3);
  });
});

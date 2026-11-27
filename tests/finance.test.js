import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, startApp } from './helpers.js';

test('payments, submissions, withdrawals, investments and reports', { timeout: 180000 }, async t => {
  const app = await startApp();
  t.after(app.stop);
  const root = await app.staff('super_admin');
  await root.ok('PUT', '/settings', { collectionStart: '2026-01', lastCollectionMonth: '2026-03', profitThroughMonth: '2026-03', monthlyAmount: 500 });
  const rahim = await root.ok('POST', '/members', { name: 'Rahim', phone: '01711000001', status: 'active', joinDate: '2026-01-01' });
  const karim = await root.ok('POST', '/members', { name: 'Karim', phone: '01711000002', status: 'active', joinDate: '2026-01-01' });
  assert.deepEqual([rahim.sl, karim.sl], [1, 2]);
  const signup = await app.request('/auth/signup', { method: 'POST', body: { name: 'Rahim', email: 'rahim@example.test', phone: '01711000001', password: PASSWORD, agreeToTerms: true } });
  const member = app.client(signup.body.data.accessToken);
  await root.ok('POST', `/member-accounts/${signup.body.data.user.id}/approve`, undefined, 200);
  const submit = (body, who = member) => who.call('POST', '/payments', { paymentDate: '2026-03-05', amount: 500, months: ['2026-01'], category: 'savings', method: 'bkash', transactionId: 'TRX-0001', ...body });
  const collection = async () => (await root.get('/dashboard')).totalCollection;
  let first;

  await t.test('a member submission is always pending and tied to the session', async () => {
    const result = await submit({ status: 'approved', member_id: karim.id, memberId: karim.id, memberName: 'Karim' });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    first = result.body.data;
    assert.deepEqual([first.status, first.memberId, first.memberName, first.type], ['pending', rahim.id, 'Rahim', 'bkash']);
    assert.equal(await collection(), 0);
    assert.deepEqual((await member.get('/payments/mine')).map(row => row.id), [first.id]);
    assert.equal((await submit({ transactionId: ' trx-0001 ' })).status, 409);
    assert.equal((await submit({ transactionId: '' })).status, 422);
    assert.equal((await submit({ transactionId: 'TRX-9', paymentDate: '2999-01-01' })).status, 422);
    assert.equal((await submit({ transactionId: 'TRX-10', amount: 10.5 })).status, 422);
    assert.equal((await app.request('/public/payment-submissions', { method: 'POST', body: {} })).status, 401);
  });

  await t.test('members cannot review or read other submissions', async () => {
    assert.equal((await member.call('POST', `/admin/payments/${first.id}/approve`, {})).status, 403);
    assert.equal((await member.call('POST', `/payment-submissions/${first.id}/review`, { decision: 'verified' })).status, 403);
    assert.equal((await member.call('GET', `/payment-submissions/${first.id}`)).status, 403);
    assert.equal((await member.call('POST', '/payments', { memberId: rahim.id, month: '2026-02', status: 'verified' })).status, 403);
  });

  await t.test('concurrent approvals make exactly one deposit and one ledger entry', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => root.call('POST', `/admin/payments/${first.id}/approve`, {})));
    assert.deepEqual(results.map(result => result.status), Array(6).fill(200), JSON.stringify(results.map(result => result.body.message)));
    assert.equal(results.filter(result => result.body.changed).length, 1);
    assert.equal(results[0].body.data.status, 'approved');
    assert.equal(await app.models.LedgerEntry.countDocuments(), 1);
    assert.equal(await app.models.Payment.countDocuments({ submissionId: first.id }), 1);
    assert.equal(await collection(), 500);
    const again = await root.call('POST', `/payment-submissions/${first.id}/review`, { decision: 'verified' });
    assert.deepEqual([again.status, again.body.message], [409, 'Only pending payments can be reviewed.']);
  });

  await t.test('rejection changes no balance and frees the transaction ID', async () => {
    const second = (await submit({ transactionId: 'TRX-0002', months: ['2026-02'] })).body.data;
    assert.equal((await root.call('POST', `/admin/payments/${second.id}/reject`, {})).status, 422);
    const rejected = await root.call('POST', `/admin/payments/${second.id}/reject`, { note: 'Wrong number' });
    assert.equal(rejected.body.data.status, 'rejected');
    assert.deepEqual(rejected.body.balances.before, rejected.body.balances.after);
    assert.equal((await root.call('POST', `/admin/payments/${second.id}/approve`, {})).status, 409);
    assert.equal(await collection(), 500);
    assert.equal((await submit({ transactionId: 'TRX-0002', months: ['2026-02'] })).status, 201);
  });

  await t.test('paid months and wrong amounts need the admin to decide', async () => {
    const duplicate = (await submit({ transactionId: 'TRX-0003' })).body.data;
    const conflict = await root.call('POST', `/payment-submissions/${duplicate.id}/review`, { decision: 'verified' });
    assert.deepEqual([conflict.status, conflict.body.message], [409, 'Rahim already has a verified deposit for this month.']);
    assert.equal((await root.get(`/payment-submissions/${duplicate.id}`)).status, 'pending');
    const two = (await submit({ transactionId: 'TRX-0004', months: ['2026-02', '2026-03'], amount: 900 })).body.data;
    assert.equal((await root.call('POST', `/admin/payments/${two.id}/approve`, {})).body.error.code, 'AMOUNT_MISMATCH');
    const approved = await root.call('POST', `/admin/payments/${two.id}/approve`, { confirmAmountMismatch: true });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual([approved.body.balances.before.savings, approved.body.balances.after.savings], [500, 1400]);
  });

  await t.test('profit submissions count only after verification', async () => {
    const profit = (await submit({ transactionId: 'TRX-0005', category: 'profit', amount: 300 })).body.data;
    assert.equal((await root.get('/dashboard')).profit, 0);
    await root.ok('POST', `/payment-submissions/${profit.id}/review`, { decision: 'verified' }, 200);
    assert.equal((await root.get('/dashboard')).profit, 300);
    assert.equal(await app.models.Payment.countDocuments({ submissionId: profit.id }), 0);
  });

  await t.test('super admin can reopen a review; balances follow', async () => {
    const before = await collection();
    await root.ok('POST', `/payment-submissions/${first.id}/reopen`, { reason: 'Checked again' }, 200);
    assert.equal(await collection(), before - 500);
    await root.ok('POST', `/payment-submissions/${first.id}/review`, { decision: 'verified' }, 200);
    assert.equal(await collection(), before);
  });

  await t.test('only a super admin or admin can delete a submission; balances follow', async () => {
    const accountant = await app.staff('accountant');
    const admin = await app.staff('admin');
    const start = await collection();
    const row = (await submit({ transactionId: 'TRX-0006', months: ['2026-04'] })).body.data;
    await root.ok('POST', `/payment-submissions/${row.id}/review`, { decision: 'verified' }, 200);
    assert.equal(await collection(), start + 500);
    for (const who of [accountant, member]) assert.equal((await who.call('DELETE', `/payment-submissions/${row.id}`)).status, 403);
    assert.equal(await collection(), start + 500);

    await admin.ok('DELETE', `/payment-submissions/${row.id}`);
    assert.equal(await collection(), start);
    assert.equal((await root.call('GET', `/payment-submissions/${row.id}`)).status, 404);
    assert.equal((await root.call('DELETE', `/payment-submissions/${row.id}`)).status, 404);
    assert.equal(await app.models.LedgerEntry.countDocuments({ submissionId: row.id, active: true }), 0);
    assert.deepEqual((await app.models.Payment.find({ submissionId: row.id }).lean()).map(deposit => deposit.status), ['reversed']);
    const kept = await app.models.AuditLog.findOne({ action: 'Deleted payment', entityId: row.id }).lean();
    assert.equal(kept.before.trxId, 'TRX-0006');

    // The month and the transaction ID are free again, and a pending payment can be deleted too.
    const again = await submit({ transactionId: 'TRX-0006', months: ['2026-04'] });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    await root.ok('DELETE', `/admin/payment-submissions/${again.body.data.id}`);
    assert.equal(await collection(), start);
  });

  await t.test('admin panel records: name-based forms, edit and duplicate checks', async () => {
    const body = { member: 'Karim', date: '2026-03-01', amount: 500, month: '2026-01', category: 'savings', type: 'Cash', trxId: '', description: '',
      status: 'pending', source: 'admin', submittedAt: new Date().toISOString() };
    const row = await root.ok('POST', '/payment-submissions', body);
    assert.deepEqual([row.source, row.memberId, row.status], ['admin', karim.id, 'pending']);
    await root.ok('PATCH', `/payment-submissions/${row.id}`, { description: 'Edited' });
    await root.ok('POST', `/payment-submissions/${row.id}/review`, { decision: 'rejected' }, 200);
    assert.equal((await root.call('PATCH', `/payment-submissions/${row.id}`, { description: 'x' })).status, 409);
  });

  await t.test('deposits: one verified per month, reverse instead of delete', async () => {
    const one = await root.ok('POST', '/payments', { member: 'Karim', month: '2026-01', amount: 500, paidDate: '10/25', method: '', trxId: '', status: 'pending' });
    const two = await root.ok('POST', '/payments', { memberId: karim.id, month: '2026-01' });
    await root.ok('PATCH', `/payments/${one.id}/status`, { status: 'verified' });
    assert.equal((await root.call('PATCH', `/payments/${two.id}/status`, { status: 'verified' })).status, 409);
    assert.equal((await root.call('POST', '/payments', { memberId: karim.id, month: '2026-01', status: 'verified' })).status, 409);
    assert.equal((await root.call('PATCH', `/payments/${one.id}`, { amount: 900 })).status, 409);
    await root.ok('PATCH', `/payments/${one.id}`, { paidDate: '2026-01-10', amount: 500 });
    assert.equal((await root.call('DELETE', `/payments/${one.id}`)).status, 404);
    await root.ok('PATCH', `/payments/${one.id}/status`, { status: 'reversed' });
    assert.equal((await root.call('PATCH', `/payments/${one.id}/status`, { status: 'verified' })).status, 409);
    await root.ok('PATCH', `/payments/${two.id}/status`, { status: 'verified' });
    const listed = await root.call('GET', '/payments?search=Karim&status=verified&limit=1');
    assert.deepEqual([listed.body.pagination.total, listed.body.data[0].member], [1, 'Karim']);
    const csv = await root.call('GET', '/payments?format=csv');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.body, /"memberName"/);
    assert.equal((await root.call('DELETE', `/members/${karim.id}`)).status, 409);
  });

  await t.test('renaming a member keeps the history', async () => {
    await root.ok('PATCH', `/members/${karim.id}`, { name: 'Karim Uddin' });
    assert.equal((await root.get('/payments?search=Karim&status=verified'))[0].memberName, 'Karim Uddin');
  });

  await t.test('withdrawals move pending → approved → paid; only paid reduces the total', async () => {
    const request = await root.ok('POST', '/withdrawals', { memberId: rahim.id, amount: 200, reason: 'Need', date: '2026-03-10', status: 'pending' });
    const move = (status, id = request.id) => root.call('PATCH', `/withdrawals/${id}/status`, { status });
    const total = async () => (await root.get('/dashboard')).allTotal;
    const before = await total();
    assert.equal((await move('paid')).status, 409);
    assert.equal((await move('approved')).status, 200);
    assert.equal(await total(), before);
    assert.equal((await move('rejected')).status, 409);
    assert.equal((await root.call('PATCH', `/withdrawals/${request.id}`, { amount: 900 })).status, 409);
    assert.equal((await move('paid')).status, 200);
    assert.equal(await total(), before - 200);
    assert.equal((await move('approved')).status, 409);
    const other = await root.ok('POST', '/withdrawals', { memberId: rahim.id, amount: 1, reason: 'No', date: '2026-03-10' });
    assert.equal((await move('rejected', other.id)).status, 200);
    assert.equal((await root.call('DELETE', `/withdrawals/${other.id}`)).status, 404);
  });

  await t.test('investment accounts, profit uniqueness, rename and guarded delete', async () => {
    const entry = await root.ok('POST', '/investments', { name: 'Ashik', investDate: '2026-01-01', amount: 40000, monthlyProfit: 2000, firstProfitMonth: '2026-01', status: 'running' });
    await root.ok('POST', '/investments', { name: 'ashik', investDate: '2026-02-01', amount: 10000, monthlyProfit: 400, firstProfitMonth: '2026-03' });
    assert.equal(await app.models.InvestmentAccount.countDocuments(), 1);
    const record = await root.ok('POST', '/profits', { account: 'Ashik', month: '2026-01', collected: 1000, cost: 1000, note: 'Cashout' });
    const again = await root.call('POST', '/profits', { account: 'Ashik', month: '2026-01', collected: 1, cost: 0 });
    assert.deepEqual([again.status, again.body.message], [409, 'This account already has a record for this month']);
    const parallel = await Promise.all([1, 2, 3].map(() => root.call('POST', '/profits', { accountId: entry.accountId, month: '2026-02', collected: 2000, cost: 0 })));
    assert.equal(parallel.filter(result => result.status === 201).length, 1);
    assert.equal((await root.call('DELETE', `/profits/${record.id}`)).status, 404);
    const summary = (await root.call('GET', '/profits')).body.summary;
    assert.deepEqual(summary, { earnedBeforeCosts: 4000, costs: 1000, profitCollected: 3000 });
    await root.ok('PATCH', `/investments/${entry.id}`, { name: 'Ashik Traders' });
    assert.equal((await root.get('/profits'))[0].account, 'Ashik Traders');
    const [account] = await root.get('/investment-accounts');
    assert.deepEqual([account.invested, account.monthlyProfit, account.collected, account.pending], [50000, 2400, 3000, 2400]);
    assert.equal((await root.call('DELETE', `/investments/${entry.id}`)).status, 409);
    await root.ok('DELETE', `/investments/${entry.id}?confirm=true`);
    assert.equal(await app.models.Profit.countDocuments(), 2);
  });

  await t.test('dues, reports, profit sheet and overview agree', async () => {
    const dues = (await root.call('GET', '/dues?sort=dueAmount&order=desc')).body;
    assert.deepEqual(dues.data.map(row => [row.name, row.dueAmount]), [['Karim Uddin', 1000], ['Rahim', 0]]);
    assert.deepEqual([dues.totals.due, dues.totals.paid], [1000, await collection()]);
    const report = await root.get('/reports/monthly?year=2026');
    assert.equal(report.rows.reduce((total, row) => total + row.collected, 0), report.summary.collected);
    assert.equal(report.summary.cash, report.summary.collected + report.summary.profit - report.summary.invested - report.summary.paidOut);
    const sheet = await root.get('/profit-sheet');
    assert.equal(sheet.through, '2026-03');
    assert.equal(sheet.totals.pending, sheet.totals.expected - sheet.totals.gross);
    assert.equal(sheet.projects.every(row => Array.isArray(row.tranches)), true);
    const own = sheet.projects.filter(row => !row.personal);
    assert.equal(sheet.totals.net, own.reduce((total, row) => total + row.net, 0));
    const open = (await app.request('/public/settings')).body.data;
    assert.deepEqual([open.lastCollectionMonth, open.profitThroughMonth], ['2026-03', '2026-03']);
    for (const path of ['/reports/monthly.csv', '/profit-sheet.csv', '/dues?format=csv', '/admin/ledger?format=csv']) {
      assert.match((await root.call('GET', path)).headers.get('content-type'), /text\/csv/, path);
    }
    const dashboard = await member.get('/dashboard?month=2026-02');
    assert.equal(dashboard.selectedMonth.month, '2026-02');
    assert.equal(dashboard.pendingSubmissions, undefined);
    assert.equal(dashboard.recentActivity, undefined);
    assert.equal(typeof dashboard.me.profitShare, 'number');
    assert.equal((await root.get('/admin/overview')).pending.count, 2);
  });

  await t.test('dashboard hides areas the staff user cannot view', async () => {
    const narrow = await app.staff('viewer', { pages: ['dashboard', 'faqs'] });
    const data = await narrow.get('/dashboard');
    for (const key of ['totalCollection', 'totalDue', 'invested', 'profit', 'allTotal', 'pendingSubmissions', 'totalMembers']) assert.equal(data[key], undefined, key);
  });

  await t.test('the audit log records who did what and cannot be changed', async () => {
    const log = await root.call('GET', '/audit-logs?action=Verified&limit=5');
    assert.equal(log.body.data[0].user, 'Test super_admin');
    assert.match(log.body.data[0].target, /^payment-submissions\//);
    assert.equal((await root.call('DELETE', `/audit-logs/${log.body.data[0].id}`)).status, 404);
  });
});

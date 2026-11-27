import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSummary, fundTotals, maskPhone, memberDues, memberShare, monthsBetween, profitLedger, today } from '../src/domain/calculations.js';

const settings = { collectionStart: '2025-11', lastCollectionMonth: '2026-02' };
const pay = (month, status = 'verified') => ({ memberId: 'm', month, amount: 500, status });

test('months and Dhaka dates', () => {
  assert.deepEqual(monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(monthsBetween('2026-02', '2025-11'), []);
  assert.equal(today(new Date('2026-10-31T19:00:00Z')), '2026-11-01'); // already November in Dhaka
  assert.equal(maskPhone('01617850226'), '0161•••0226');
});

test('dues count unpaid months since joining; advances are money, not dues', () => {
  const dues = memberDues({ _id: 'm', status: 'active', monthly: 500 }, [pay('2025-11'), pay('2026-01'), pay('2026-03'), pay('2025-12', 'pending'), pay('2026-02', 'reversed')], settings);
  assert.deepEqual(dues.dueMonths, ['2025-12', '2026-02']);
  assert.equal(dues.dueAmount, 1000);
  assert.equal(dues.paidAmount, 1500);
  assert.equal(dues.paidCount, 2);
  assert.deepEqual(dues.advanceMonths, ['2026-03']);
  assert.equal(memberDues({ _id: 'x', status: 'active', monthly: 500, joinDate: '2026-01-15' }, [], settings).dueAmount, 1000);
  assert.equal(memberDues({ _id: 'x', status: 'pending', monthly: 500 }, [], settings).dueAmount, 0);
  assert.equal(memberDues({ _id: 'x', status: 'inactive', inactiveMonth: '2025-12', monthly: 500 }, [], settings).dueAmount, 1000);
});

test('investment account months, statuses, pending and ledger', () => {
  const entries = [
    { accountId: 'a', amount: 40000, monthlyProfit: 2000, firstProfitMonth: '2026-01', status: 'running' },
    { accountId: 'a', amount: 10000, monthlyProfit: 400, firstProfitMonth: '2026-03', status: 'running' },
    { accountId: 'a', amount: 99999, monthlyProfit: 999, firstProfitMonth: '2026-01', status: 'planned' },
  ];
  const profits = [
    { _id: 1, accountId: 'a', month: '2026-01', collected: 1000, cost: 1000 },
    { _id: 2, accountId: 'a', month: '2026-02', collected: 500, cost: 0 },
  ];
  const account = accountSummary({ _id: 'a', name: 'A' }, entries, profits, '2026-03');
  assert.deepEqual(account.months.slice(0, 4).map(row => [row.expected, row.pending, row.status]),
    [[2000, 0, 'collected'], [2000, 1500, 'partial'], [2400, 2400, 'pending'], [2400, 0, 'upcoming']]);
  assert.equal(account.months.at(-1).month, '2026-12');
  assert.deepEqual([account.invested, account.monthlyProfit, account.collected, account.cost, account.pending], [50000, 2400, 1500, 1000, 3900]);
  assert.deepEqual([account.monthsPassed, account.monthsCollected], [3, 1]);
  const ledger = profitLedger(account, '2026-03');
  assert.deepEqual([ledger.monthsRun, ledger.monthsCollected, ledger.expected, ledger.gross, ledger.net, ledger.pending], [3, 2, 6400, 2500, 1500, 3900]);
});

test('fund totals ignore pending and rejected money; shares are proportional', () => {
  const totals = fundTotals({
    payments: [pay('2026-01'), pay('2026-02'), pay('2026-03', 'pending')],
    accounts: [{ invested: 600, collected: 200, cost: 0, pending: 0 }, { invested: 0, collected: 50, cost: 0, pending: 0 }],
    submissions: [{ status: 'verified', category: 'profit', amount: 30 }, { status: 'verified', category: 'profit', amount: 99, appliedAccountId: 'a' },
      { status: 'pending', category: 'profit', amount: 1000 }, { status: 'rejected', category: 'savings', amount: 1000 }],
    withdrawals: [{ status: 'paid', amount: 100 }, { status: 'approved', amount: 700 }],
  });
  assert.deepEqual([totals.collected, totals.invested, totals.profit, totals.personalProfit, totals.projectProfit], [1000, 600, 280, 80, 200]);
  assert.deepEqual([totals.paidOut, totals.allTotal, totals.cash], [100, 1180, 580]);
  assert.deepEqual(totals.pendingSubmissions, { count: 1, amount: 1000 });
  assert.deepEqual(memberShare(500, totals), { ratio: 0.5, profitShare: 140, currentValue: 640 });
});

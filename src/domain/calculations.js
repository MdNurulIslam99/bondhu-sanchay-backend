// Pure calculations shared by the admin panel and the website. No database access here.
export const sum = (rows, pick = row => row) => rows.reduce((total, row) => total + pick(row), 0);
const id = value => String(value);

const dhaka = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });
export function today(now = new Date()) {
  const parts = Object.fromEntries(dhaka.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export const currentMonth = now => today(now).slice(0, 7);

export function monthsBetween(from, to) {
  if (!from || !to || from > to) return [];
  const months = [];
  let [year, month] = from.split('-').map(Number);
  for (let key = from; key <= to; key = `${year}-${String(month).padStart(2, '0')}`) {
    months.push(key);
    if (++month > 12) { year++; month = 1; }
  }
  return months;
}

/**
 * A member owes every collection month since joining that has no verified deposit.
 * Pending applicants owe nothing; inactive members stop at the month they became inactive.
 * Deposits for later months are advances: they count as paid money but never as due.
 */
export function memberDues(member, payments, settings) {
  const joined = member.joinDate?.slice(0, 7);
  const start = joined && joined > settings.collectionStart ? joined : settings.collectionStart;
  let end = settings.lastCollectionMonth;
  if (member.status === 'inactive' && member.inactiveMonth && member.inactiveMonth < end) end = member.inactiveMonth;
  const expected = member.status === 'pending' ? [] : monthsBetween(start, end);
  const verified = payments.filter(row => id(row.memberId) === id(member._id) && row.status === 'verified');
  const paid = new Set(verified.map(row => row.month));
  const dueMonths = expected.filter(month => !paid.has(month));
  const advanceMonths = [...paid].filter(month => month > settings.lastCollectionMonth).sort();
  return {
    expectedMonths: expected,
    expectedCount: expected.length,
    paidMonths: [...paid].sort(),
    paidCount: expected.length - dueMonths.length,
    dueMonths,
    advanceMonths,
    paidAmount: sum(verified, row => row.amount),
    dueAmount: dueMonths.length * member.monthly,
  };
}

/** One investment account: what is expected, received and still pending month by month. */
export function accountSummary(account, entries, records, through) {
  const own = entries.filter(row => id(row.accountId) === id(account._id));
  const profits = records.filter(row => id(row.accountId) === id(account._id));
  const starts = [...own.map(row => row.firstProfitMonth), ...profits.map(row => row.month)].sort();
  const months = starts.length ? monthsBetween(starts[0], `${through.slice(0, 4)}-12`).map(month => {
    const record = profits.find(row => row.month === month);
    const expected = sum(own.filter(row => row.status === 'running' && row.firstProfitMonth <= month), row => row.monthlyProfit);
    const collected = record?.collected ?? 0;
    const cost = record?.cost ?? 0;
    const received = collected + cost;
    const due = month <= through;
    const status = (expected > 0 && received >= expected) || (expected === 0 && received > 0) ? 'collected'
      : received > 0 ? 'partial' : expected > 0 ? (due ? 'pending' : 'upcoming') : 'none';
    return { month, expected, collected, cost, received, due, pending: due ? Math.max(0, expected - received) : 0, status,
      note: record?.note ?? '', recordId: record ? id(record._id) : null };
  }) : [];
  const passed = months.filter(row => row.due && row.expected > 0);
  return {
    id: id(account._id),
    name: account.name,
    entries: own,
    months,
    invested: sum(own.filter(row => row.status !== 'planned'), row => row.amount),
    monthlyProfit: sum(own.filter(row => row.status === 'running'), row => row.monthlyProfit),
    monthsPassed: passed.length,
    monthsCollected: passed.filter(row => row.status === 'collected').length,
    collected: sum(profits, row => row.collected),
    cost: sum(profits, row => row.cost),
    expected: sum(months.filter(row => row.due), row => row.expected),
    pending: sum(months, row => row.pending),
  };
}

/** Website profit sheet: the closed months of one account, from its first profit month. */
export function profitLedger(account, through) {
  const closed = account.months.filter(row => row.month <= through);
  const expected = sum(closed, row => row.expected);
  const gross = sum(closed, row => row.received);
  return {
    months: closed.map(row => ({ month: row.month, expected: row.expected, received: row.collected, cost: row.cost, costNote: row.note,
      status: row.recordId ? 'collected' : 'due' })),
    monthsRun: closed.length,
    monthsCollected: closed.filter(row => row.recordId).length,
    expected,
    gross,
    net: sum(closed, row => row.collected),
    cost: sum(closed, row => row.cost),
    pending: expected - gross,
  };
}

/** Balances of the whole fund. Pending and rejected items are never counted. */
export function fundTotals({ payments, accounts, submissions, withdrawals }) {
  const verified = submissions.filter(row => row.status === 'verified');
  // Profit submissions booked onto an account record are already inside that record.
  const submissionProfit = sum(verified.filter(row => row.category === 'profit' && !row.appliedAccountId), row => row.amount);
  const accountProfit = sum(accounts, row => row.collected);
  const uninvestedProfit = sum(accounts.filter(row => row.invested === 0), row => row.collected);
  const collected = sum(payments.filter(row => row.status === 'verified'), row => row.amount);
  const invested = sum(accounts, row => row.invested);
  const paidOut = sum(withdrawals.filter(row => row.status === 'paid'), row => row.amount);
  const profit = accountProfit + submissionProfit;
  const pendingRows = submissions.filter(row => row.status === 'pending');
  return {
    collected,
    invested,
    profit,
    projectProfit: accountProfit - uninvestedProfit,
    personalProfit: uninvestedProfit + submissionProfit,
    cost: sum(accounts, row => row.cost),
    pendingProfit: sum(accounts, row => row.pending),
    paidOut,
    allTotal: collected + profit - paidOut,
    cash: collected + profit - invested - paidOut,
    pendingSubmissions: { count: pendingRows.length, amount: sum(pendingRows, row => row.amount) },
  };
}

/** A member's share of the profit is proportional to what they contributed. */
export function memberShare(paidAmount, totals, withdrawn = 0) {
  const ratio = totals.collected ? paidAmount / totals.collected : 0;
  const profitShare = Math.round(totals.profit * ratio);
  return { ratio, profitShare, currentValue: paidAmount + profitShare - withdrawn };
}

export const maskPhone = phone => phone ? `${phone.slice(0, 4)}•••${phone.slice(-4)}` : '';
export const initials = name => name.split(/\s+/).filter(word => word && !/^(md|m)$/i.test(word)).slice(0, 2)
  .map(word => word[0]).join('').toUpperCase();

// Dashboard, dues, monthly reports, profit sheet and the audit log. All numbers are calculated here.
import { z } from 'zod';
import { linkedMember } from '../lib/api.js';
import { currentMonth, monthsBetween, profitLedger, sum } from '../domain/calculations.js';
import { forbidden } from '../lib/errors.js';
import { allows } from '../lib/permissions.js';
import { contains, send, sendCsv, sendList, sendRows } from '../lib/respond.js';
import { date, listQuery, month, objectId } from '../lib/schemas.js';
import { view } from '../lib/tx.js';
import { AuditLog } from '../models/index.js';
import { allDues, loadLedger, memberAccount } from './ledger.js';

const id = value => String(value);
const monthTitle = key => new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const point = (key, value) => ({ month: key, label: monthTitle(key), value });
const collectionMonths = ledger => monthsBetween(ledger.settings.collectionStart, ledger.settings.lastCollectionMonth);
const collectedIn = (ledger, key) => sum(ledger.payments.filter(row => row.month === key), row => row.amount);
/** Profit received in a month: account records plus verified profit payments dated in it. */
const profitIn = (ledger, key) => sum(ledger.profits.filter(row => row.month === key), row => row.collected)
  + sum(ledger.submissions.filter(row => row.status === 'verified' && row.category === 'profit' && !row.appliedAccountId && (row.months?.[0] || row.date.slice(0, 7)) === key), row => row.amount);

function monthDetail(ledger, key) {
  const rows = allDues(ledger).filter(({ dues }) => dues.expectedMonths.includes(key)).map(({ member }) => {
    const payment = ledger.payments.find(row => id(row.memberId) === id(member._id) && row.month === key);
    return { memberId: id(member._id), sl: member.sl, name: member.name, status: payment ? 'paid' : 'missed', amount: payment?.amount ?? 0, expected: member.monthly };
  });
  const paid = rows.filter(row => row.status === 'paid').length;
  return { month: key, paid, unpaid: rows.length - paid, collected: collectedIn(ledger, key), expected: sum(rows, row => row.expected), rows };
}

const monthlySeries = ledger => collectionMonths(ledger).map(key => {
  const { rows, ...detail } = monthDetail(ledger, key);
  const profit = profitIn(ledger, key);
  return { ...detail, profit, total: detail.collected + profit };
});

/** Running total of savings and profit. Advances and profit outside these months join the last point. */
function cumulativeFund(ledger, series) {
  let running = 0;
  const points = series.map(row => point(row.month, (running += row.total)));
  if (points.length) points.at(-1).value = ledger.totals.collected + ledger.totals.profit;
  return points;
}

const fundSummary = ledger => {
  const last = ledger.settings.lastCollectionMonth;
  return { collected: ledger.totals.collected, profit: ledger.totals.profit, invested: ledger.totals.invested, cash: ledger.totals.cash,
    advance: sum(ledger.payments.filter(row => row.month > last), row => row.amount), personalProfit: ledger.totals.personalProfit,
    paidOut: ledger.totals.paidOut };
};

function investmentRows(ledger, share) {
  return ledger.projects.map(project => {
    const account = ledger.accounts.find(row => row.id === id(project.accountId));
    // Several projects of one account share its money; it is shown on the first so totals stay right.
    const first = ledger.projects.find(row => id(row.accountId) === id(project.accountId)) === project;
    const invested = first ? account?.invested ?? 0 : 0;
    const profit = first ? account?.collected ?? 0 : 0;
    return { id: id(project._id), slug: project.slug, name: project.name, category: project.businessType, partner: account?.name ?? '', status: project.status,
      invested, monthlyProfit: first ? account?.monthlyProfit ?? 0 : 0, profit, yourShare: share === null ? null : Math.round(profit * share) };
  });
}
function sectorSplit(ledger) {
  const sectors = {};
  for (const account of ledger.accounts.filter(row => row.invested > 0)) {
    const project = ledger.projects.find(row => id(row.accountId) === account.id);
    const key = project?.businessType || 'Other';
    sectors[key] = (sectors[key] || 0) + account.invested;
  }
  return Object.entries(sectors).map(([sector, invested]) => ({ sector, invested }));
}

/** One response for both dashboards; each section appears only if the user may see that area. */
async function dashboard(req, res) {
  const member = await linkedMember(req.user);
  const isStaff = req.user.role !== 'member';
  if (isStaff ? !allows(req.permissions, 'dashboard') : !member) throw forbidden(isStaff ? 'Permission denied' : 'Your account is waiting to be approved as a member', isStaff ? 'FORBIDDEN' : 'MEMBER_REQUIRED');
  const can = module => !isStaff || allows(req.permissions, module);
  const ledger = await loadLedger();
  const { totals, settings } = ledger;
  const series = monthlySeries(ledger);
  const dues = allDues(ledger);
  const owing = dues.filter(row => row.dues.dueAmount > 0);
  const totalDue = sum(owing, row => row.dues.dueAmount);
  const account = member ? memberAccount(ledger, member) : null;
  const data = {
    lastCollectionMonth: settings.lastCollectionMonth, profitThroughMonth: settings.profitThroughMonth,
    me: member ? { memberId: id(member._id), name: member.name, ...account } : null,
  };
  const charts = {};
  if (can('members')) Object.assign(data, { totalMembers: ledger.members.filter(row => row.status !== 'pending').length, activeMembers: ledger.members.filter(row => row.status === 'active').length });
  if (can('payments') || can('dues')) {
    data.totalCollection = totals.collected;
    data.selectedMonth = monthDetail(ledger, req.input.query.month || settings.lastCollectionMonth);
    data.monthlySeries = series;
    charts.monthlyCollection = series.map(row => point(row.month, row.collected));
    let running = 0;
    charts.collectionGrowth = series.map(row => point(row.month, (running += row.collected)));
  }
  if (can('dues')) {
    Object.assign(data, { totalDue, owingMembersCount: owing.length });
    charts.duesByMember = owing.map(row => ({ memberId: id(row.member._id), member: row.member.name, due: row.dues.dueAmount, months: row.dues.dueMonths.length })).sort((a, b) => b.due - a.due);
    charts.collectionStatus = { collected: totals.collected, due: totalDue, membersWithoutDues: dues.length - owing.length, membersWithDues: owing.length };
  }
  if (can('investments')) {
    data.invested = totals.invested;
    data.investments = investmentRows(ledger, account ? account.ratio : null);
    data.sectorSplit = sectorSplit(ledger);
    charts.investedByAccount = ledger.accounts.map(row => ({ account: row.name, invested: row.invested })).sort((a, b) => b.invested - a.invested);
  }
  if (can('profits') || can('investments')) {
    Object.assign(data, { profit: totals.profit, pendingProfit: totals.pendingProfit });
    const months = monthsBetween([...ledger.profits.map(row => row.month), settings.collectionStart].sort()[0], settings.profitThroughMonth);
    charts.monthlyProfit = months.map(key => point(key, profitIn(ledger, key))).filter(row => row.value > 0);
  }
  if (can('withdrawals')) data.paidOut = totals.paidOut;
  // Fund totals combine collection, profit and withdrawals.
  if (['payments', 'profits', 'withdrawals'].every(can)) {
    Object.assign(data, { allTotal: totals.allTotal, cash: totals.cash, fund: fundSummary(ledger) });
    charts.cumulativeFund = cumulativeFund(ledger, series);
  }
  if (isStaff && can('payment-submissions')) data.pendingSubmissions = totals.pendingSubmissions;
  if (isStaff && can('audit')) data.recentActivity = (await AuditLog.find().sort({ at: -1 }).limit(6).lean()).map(auditView);
  send(res, { ...data, charts });
}

function duesRoutes(api) {
  const query = listQuery({ sort: ['sl', 'name', 'dueAmount', 'paidAmount', 'dueCount'], defaultOrder: 'asc',
    filters: { memberId: objectId.optional(), status: z.enum(['active', 'inactive']).optional(), filter: z.enum(['all', 'due', 'clear']).optional() } });
  for (const path of ['/dues', '/admin/dues']) {
    api.get(path, { tag: 'Dues', summary: 'Dues of every member, with totals', access: ['dues', 'view'], query }, async (req, res) => {
      const { memberId, status, filter, search } = req.input.query;
      const ledger = await loadLedger();
      const needle = search?.toLowerCase();
      const rows = allDues(ledger).filter(({ member, dues }) => (!memberId || id(member._id) === memberId) && (!status || member.status === status)
        && (!filter || filter === 'all' || (filter === 'due') === dues.dueMonths.length > 0)
        && (!needle || `${member.name} ${member.phone}`.toLowerCase().includes(needle)))
        .map(({ member, dues }) => ({ id: id(member._id), memberId: id(member._id), sl: member.sl, name: member.name, phone: member.phone, status: member.status, monthly: member.monthly,
          expectedCount: dues.expectedCount, paidCount: dues.paidCount, dueCount: dues.dueMonths.length, dueMonths: dues.dueMonths, paidMonths: dues.paidMonths, dueAmount: dues.dueAmount, paidAmount: dues.paidAmount }));
      const due = sum(rows, row => row.dueAmount);
      const paid = sum(rows, row => row.paidAmount);
      sendRows(res, { rows, query: req.input.query, name: 'dues', columns: ['sl', 'name', 'phone', 'expectedCount', 'paidCount', 'dueCount', 'dueMonths', 'dueAmount', 'paidAmount'],
        extra: { totals: { expected: paid + due, paid, due, membersWithDues: rows.filter(row => row.dueCount).length, members: rows.length },
          collectionMonths: collectionMonths(ledger) } });
    });
  }
}

function reportRoutes(api) {
  const tag = 'Reports';
  const yearQuery = z.strictObject({ year: z.string().regex(/^20\d{2}$/).optional(), format: z.enum(['json', 'csv']).optional() });
  const monthly = format => async (req, res) => {
    const ledger = await loadLedger();
    const rows = monthlySeries(ledger).filter(row => !req.input.query.year || row.month.startsWith(req.input.query.year));
    if (format === 'csv' || req.input.query.format === 'csv') return sendCsv(res, 'monthly-report', ['month', 'paid', 'unpaid', 'expected', 'collected', 'profit', 'total'], rows);
    send(res, { rows, summary: fundSummary(ledger) });
  };
  api.get('/reports/monthly', { tag, summary: 'Collection and profit by month', access: 'member', query: yearQuery }, monthly());
  api.get('/reports/monthly.csv', { tag, summary: 'The monthly report as CSV', access: 'member', query: yearQuery }, monthly('csv'));
  api.get('/reports/fund-summary', { tag, summary: 'Fund totals', access: 'member' }, async (req, res) => send(res, fundSummary(await loadLedger())));
  api.get('/months/:key', { tag, summary: 'Who paid in one month', access: 'member', params: z.strictObject({ key: month }) },
    async (req, res) => send(res, monthDetail(await loadLedger(), req.input.params.key)));

  const profitSheet = format => async (req, res) => {
    const ledger = await loadLedger();
    const through = ledger.settings.profitThroughMonth;
    const projects = ledger.accounts.map(account => {
      const own = ledger.projects.filter(row => id(row.accountId) === account.id);
      return { accountId: account.id, account: account.name, name: own.map(row => row.name).join(', ') || `${account.name} (personal)`,
        projects: own.map(row => ({ id: id(row._id), slug: row.slug, name: row.name })), personal: account.invested === 0,
        invested: account.invested, monthlyProfit: account.monthlyProfit,
        monthlyReturnPercent: account.invested ? Number((account.monthlyProfit / account.invested * 100).toFixed(2)) : 0,
        ...profitLedger(account, through) };
    });
    const months = [...new Set(projects.flatMap(row => row.months.map(item => item.month)))].sort();
    const costs = projects.flatMap(row => row.months.filter(item => item.cost > 0).map(item => ({ project: row.name, month: item.month, amount: item.cost, note: item.costNote })));
    if (format === 'csv' || req.input.query.format === 'csv') {
      const rows = projects.flatMap(row => row.months.map(item => ({ project: row.name, ...item })));
      return sendCsv(res, 'profit-sheet', ['project', 'month', 'expected', 'received', 'cost', 'costNote', 'status'], rows);
    }
    send(res, { through, months, projects, costs,
      grid: months.map(key => ({ month: key, values: Object.fromEntries(projects.map(row => [row.accountId, row.months.find(item => item.month === key)?.received ?? 0])) })),
      totals: Object.fromEntries(['invested', 'monthlyProfit', 'expected', 'gross', 'net', 'cost', 'pending'].map(key => [key, sum(projects, row => row[key])])) });
  };
  const formatQuery = z.strictObject({ format: z.enum(['json', 'csv']).optional() });
  api.get('/profit-sheet', { tag, summary: 'Per-project profit ledger', access: 'member', query: formatQuery }, profitSheet());
  api.get('/profit-sheet.csv', { tag, summary: 'The profit sheet as CSV', access: 'member', query: formatQuery }, profitSheet('csv'));

  api.get('/admin/overview', { tag, summary: 'Pending payments and balances', access: ['dashboard', 'view'] }, async (req, res) => {
    const ledger = await loadLedger();
    const thisMonth = currentMonth();
    const approved = ledger.submissions.filter(row => row.status === 'verified' && row.reviewedAt && currentMonth(row.reviewedAt) === thisMonth);
    send(res, { pending: ledger.totals.pendingSubmissions, approvedThisMonth: { count: approved.length, amount: sum(approved, row => row.amount) },
      balances: { savings: ledger.totals.collected, profit: ledger.totals.profit, invested: ledger.totals.invested, cash: ledger.totals.cash } });
  });
}

const auditView = row => {
  const data = view(row);
  return { id: data.id, user: data.userName, userId: data.userId || null, action: data.action, target: data.entityId ? `${data.entity}/${data.entityId}` : data.entity,
    entity: data.entity, entityId: data.entityId || null, before: data.before, after: data.after, ip: data.ip, at: data.at };
};

function auditRoutes(api) {
  // The audit log is read-only: there is no route that changes or deletes it.
  const query = listQuery({ sort: ['at', 'action', 'entity', 'userName'], filters: {
    user: z.string().max(100).optional(), userId: objectId.optional(), action: z.string().max(100).optional(), entity: z.string().max(100).optional(), from: date.optional(), to: date.optional() } });
  for (const path of ['/audit-logs', '/admin/audit-logs']) {
    api.get(path, { tag: 'Audit log', summary: 'Who changed what', access: ['audit', 'view'], query }, async (req, res) => {
      const { user, userId, action, entity, from, to, search } = req.input.query;
      const filter = { ...(userId ? { userId } : {}), ...(entity ? { entity } : {}), ...(user ? { userName: contains(user) } : {}), ...(action ? { action: contains(action) } : {}) };
      // Days are Bangladesh days (UTC+6).
      if (from || to) filter.at = { ...(from ? { $gte: new Date(`${from}T00:00:00+06:00`) } : {}), ...(to ? { $lte: new Date(`${to}T23:59:59.999+06:00`) } : {}) };
      if (search) filter.$or = ['userName', 'action', 'entity', 'entityId'].map(key => ({ [key]: contains(search) }));
      await sendList(res, { model: AuditLog, filter, query: req.input.query, map: rows => rows.map(auditView), name: 'audit-log', columns: ['at', 'user', 'action', 'target', 'ip'] });
    });
  }
}

export default function reportRoutesAll(api) {
  api.get('/dashboard', { tag: 'Dashboard', summary: 'Dashboard for staff or members', access: 'user', query: z.strictObject({ month: month.optional() }) }, dashboard);
  duesRoutes(api);
  reportRoutes(api);
  auditRoutes(api);
}

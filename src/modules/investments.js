// Investment accounts, the amounts placed in them, and the monthly profit and cost records.
import { z } from 'zod';
import { sum } from '../domain/calculations.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { contains, send, sendList } from '../lib/respond.js';
import { date, listQuery, month, objectId, optionalText, positiveTaka, taka, text } from '../lib/schemas.js';
import { actorOf, audit, lock, transaction, view } from '../lib/tx.js';
import { InvestmentAccount, InvestmentEntry, Profit, Project } from '../models/index.js';
import { loadLedger } from './ledger.js';

const STATUS = z.enum(['running', 'completed', 'planned']);
export const accountRefs = { accountId: objectId.optional(), account: z.string().trim().max(120).optional(), accountName: z.string().trim().max(120).optional() };

export async function resolveAccount({ accountId, account, accountName }, session) {
  const name = account ?? accountName;
  const row = accountId ? await InvestmentAccount.findById(accountId).session(session || null)
    : name ? await InvestmentAccount.findOne({ nameKey: name.toLowerCase() }).session(session || null) : null;
  if (!row) throw invalid(accountId ? { accountId: 'Investment account not found' } : { account: name ? `No investment account is named "${name}".` : 'Choose an account' });
  return row;
}

async function rename(req, account, name, session) {
  if (name === account.name) return;
  const key = name.toLowerCase();
  if (await InvestmentAccount.exists({ _id: { $ne: account._id }, nameKey: key }).session(session)) {
    throw conflict('Another account already has this name.', 'DUPLICATE_RECORD', { name: 'Already in use' });
  }
  const before = view(account);
  account.set({ name, nameKey: key });
  await account.save({ session });
  await audit(actorOf(req), 'Renamed', 'investment-accounts', account._id, { before, after: view(account), session });
}

async function createAccount(req, name, session) {
  const [row] = await InvestmentAccount.create([{ name, nameKey: name.toLowerCase() }], { session });
  await audit(actorOf(req), 'Created', 'investment-accounts', row._id, { after: view(row), session });
  return row;
}

async function withAccounts(rows) {
  const accounts = await InvestmentAccount.find({ _id: { $in: rows.map(row => row.accountId) } }).lean();
  return rows.map(row => {
    const name = accounts.find(account => String(account._id) === String(row.accountId))?.name ?? '';
    return { ...view(row), accountName: name, account: name };
  });
}
const entryRows = async rows => (await withAccounts(rows)).map(row => ({ ...row, name: row.accountName, rate: row.amount > 0 ? Number((row.monthlyProfit / row.amount * 100).toFixed(2)) : 0 }));
const single = async (map, row) => (await map([row.toObject()]))[0];

const accountIds = async search => (await InvestmentAccount.find({ nameKey: contains(search.toLowerCase()) }, '_id').lean()).map(row => row._id);

function accountRoutes(api) {
  const tag = 'Investment accounts';
  const full = (ledger, account) => ({
    ...account,
    entries: account.entries.map(row => ({ ...view(row), name: account.name, rate: row.amount > 0 ? Number((row.monthlyProfit / row.amount * 100).toFixed(2)) : 0 })),
    projects: ledger.projects.filter(row => String(row.accountId) === account.id).map(row => ({ id: String(row._id), name: row.name, slug: row.slug })),
  });
  for (const base of ['/investment-accounts', '/admin/investment-accounts']) {
    api.get(base, { tag, summary: 'Accounts with totals and month-by-month profit', access: ['investments', 'view'], query: z.strictObject({ search: z.string().max(100).optional() }) }, async (req, res) => {
      const ledger = await loadLedger();
      const needle = req.input.query.search?.toLowerCase();
      const accounts = ledger.accounts.filter(row => !needle || row.name.toLowerCase().includes(needle)).map(row => full(ledger, row));
      send(res, accounts, { totals: Object.fromEntries(['invested', 'collected', 'cost', 'pending', 'monthlyProfit'].map(key => [key, sum(accounts, row => row[key])])),
        profitThroughMonth: ledger.settings.profitThroughMonth });
    });
    api.get(`${base}/:id`, { tag, summary: 'One account in detail', access: ['investments', 'view'] }, async (req, res) => {
      const ledger = await loadLedger();
      const account = ledger.accounts.find(row => row.id === req.input.params.id);
      if (!account) throw notFound('Account not found');
      send(res, full(ledger, account));
    });
    api.post(base, { tag, summary: 'Create an account', access: ['investments', 'create'], body: z.strictObject({ name: text(120) }) }, async (req, res) => {
      const row = await transaction(session => createAccount(req, req.input.body.name, session));
      send(res, view(row), { status: 201, message: 'Account created' });
    });
    for (const method of ['put', 'patch']) {
      api[method](`${base}/:id`, { tag, summary: 'Rename an account everywhere', access: ['investments', 'update'], body: z.strictObject({ name: text(120) }) }, async (req, res) => {
        const row = await transaction(async session => {
          const account = await InvestmentAccount.findById(req.input.params.id).session(session);
          if (!account) throw notFound('Account not found');
          await rename(req, account, req.input.body.name, session);
          return account;
        });
        send(res, view(row), { message: 'Account renamed' });
      });
    }
    api.delete(`${base}/:id`, { tag, summary: 'Delete an unused account', access: ['investments', 'delete'] }, async (req, res) => {
      await transaction(async session => {
        await lock('finance', session);
        const account = await InvestmentAccount.findById(req.input.params.id).session(session);
        if (!account) throw notFound('Account not found');
        for (const model of [InvestmentEntry, Profit, Project]) {
          if (await model.exists({ accountId: account._id }).session(session)) throw conflict('This account still has investments, profit records or projects.', 'ACCOUNT_IN_USE');
        }
        await account.deleteOne({ session });
        await audit(actorOf(req), 'Deleted', 'investment-accounts', account._id, { before: view(account), session });
      });
      send(res, null, { message: 'Account deleted' });
    });
  }
}

const entryFields = { ...accountRefs, name: text(120), investDate: date, amount: positiveTaka, monthlyProfit: taka, firstProfitMonth: month, status: STATUS };
const entryCreate = z.strictObject(entryFields).partial().required({ investDate: true, amount: true, monthlyProfit: true, firstProfitMonth: true });
const entryUpdate = z.strictObject(entryFields).partial();
const entryColumns = ['id', 'accountId', 'name', 'investDate', 'amount', 'monthlyProfit', 'rate', 'firstProfitMonth', 'status'];

/** Rows of the admin "Investments" page. Also available as a project's tranches. */
function entryRoutes(api) {
  const tag = 'Investments';
  const query = listQuery({ sort: ['investDate', 'amount', 'monthlyProfit', 'firstProfitMonth', 'status', 'createdAt'], filters: { status: STATUS.optional(), accountId: objectId.optional() } });
  const find = async (id, session) => {
    const row = await InvestmentEntry.findById(id).session(session || null);
    if (!row) throw notFound('Investment not found');
    return row;
  };
  const update = async (req, res) => {
    const { name, accountId, account, accountName, ...patch } = req.input.body;
    const row = await transaction(async session => {
      await lock('finance', session);
      const entry = await find(req.input.params.id, session);
      const before = view(entry);
      if (accountId || account || accountName) entry.accountId = (await resolveAccount({ accountId, account, accountName }, session))._id;
      else if (name) await rename(req, await InvestmentAccount.findById(entry.accountId).session(session), name, session);
      entry.set(patch);
      await entry.save({ session });
      await audit(actorOf(req), 'Updated', 'investments', entry._id, { before, after: view(entry), session });
      return entry;
    });
    send(res, await single(entryRows, row), { message: 'Investment saved' });
  };

  for (const base of ['/investments', '/admin/investments']) {
    api.get(base, { tag, summary: 'List invested amounts', access: ['investments', 'view'], query }, async (req, res) => {
      const { status, accountId, search } = req.input.query;
      const filter = { ...(status ? { status } : {}), ...(accountId ? { accountId } : {}) };
      if (search) filter.$or = [{ accountId: { $in: await accountIds(search) } }, { investDate: contains(search) }, { firstProfitMonth: contains(search) }];
      await sendList(res, { model: InvestmentEntry, filter, query: req.input.query, map: entryRows, name: 'investments', columns: entryColumns });
    });
    api.get(`${base}/:id`, { tag, summary: 'Read an entry', access: ['investments', 'view'] }, async (req, res) => send(res, await single(entryRows, await find(req.input.params.id))));
    api.post(base, { tag, summary: 'Add an investment (a new name creates the account)', access: ['investments', 'create'], body: entryCreate }, async (req, res) => {
      const { name, accountId, account, accountName, ...input } = req.input.body;
      const row = await transaction(async session => {
        await lock('finance', session);
        const title = name || account || accountName;
        const existing = accountId ? await resolveAccount({ accountId }, session)
          : title ? await InvestmentAccount.findOne({ nameKey: title.toLowerCase() }).session(session) : null;
        if (!existing && !title) throw invalid({ name: 'This field is required' });
        const owner = existing || await createAccount(req, title, session);
        const [created] = await InvestmentEntry.create([{ status: 'running', ...input, accountId: owner._id }], { session });
        await audit(actorOf(req), 'Created', 'investments', created._id, { after: view(created), session });
        return created;
      });
      send(res, await single(entryRows, row), { status: 201, message: 'Investment added' });
    });
    api.put(`${base}/:id`, { tag, summary: 'Edit an entry', access: ['investments', 'update'], body: entryUpdate }, update);
    api.patch(`${base}/:id`, { tag, summary: 'Edit an entry', access: ['investments', 'update'], body: entryUpdate }, update);
    api.delete(`${base}/:id`, { tag, summary: 'Delete an entry (needs ?confirm=true when the account has profit records)', access: ['investments', 'delete'],
      query: z.strictObject({ confirm: z.enum(['true', 'false']).optional() }) }, async (req, res) => {
      await transaction(async session => {
        await lock('finance', session);
        const entry = await find(req.input.params.id, session);
        if (req.input.query.confirm !== 'true' && await Profit.exists({ accountId: entry.accountId }).session(session)) {
          throw conflict('This account has profit records, which are kept. Confirm to delete the investment.', 'HAS_PROFIT_RECORDS');
        }
        await entry.deleteOne({ session });
        await audit(actorOf(req), 'Deleted', 'investments', entry._id, { before: view(entry), session });
      });
      send(res, null, { message: 'Investment deleted' });
    });
  }
}

const profitFields = { ...accountRefs, month, collected: taka, cost: taka, note: optionalText(2000) };
const profitCreate = z.strictObject(profitFields).partial().required({ month: true, collected: true });
const profitUpdate = z.strictObject(profitFields).partial();
const duplicate = () => conflict('This account already has a record for this month', 'DUPLICATE_RECORD', { month: 'This account already has a record for this month' });

function profitRoutes(api) {
  const tag = 'Profit and costs';
  const query = listQuery({ sort: ['month', 'collected', 'cost', 'createdAt'], filters: { accountId: objectId.optional(), account: z.string().max(120).optional(), month: month.optional() } });
  const find = async (id, session) => {
    const row = await Profit.findById(id).session(session || null);
    if (!row) throw notFound('Profit record not found');
    return row;
  };
  const update = async (req, res) => {
    const { accountId, account, accountName, ...patch } = req.input.body;
    const row = await transaction(async session => {
      await lock('finance', session);
      const record = await find(req.input.params.id, session);
      const before = view(record);
      if (accountId || account || accountName) record.accountId = (await resolveAccount({ accountId, account, accountName }, session))._id;
      record.set(patch);
      if (await Profit.exists({ _id: { $ne: record._id }, accountId: record.accountId, month: record.month }).session(session)) throw duplicate();
      await record.save({ session });
      await audit(actorOf(req), 'Updated', 'profits', record._id, { before, after: view(record), session });
      return record;
    });
    send(res, await single(withAccounts, row), { message: 'Record saved' });
  };

  for (const base of ['/profits', '/admin/profits']) {
    api.get(base, { tag, summary: 'List profit records with totals', access: ['profits', 'view'], query }, async (req, res) => {
      const { accountId, account, month: key, search } = req.input.query;
      const filter = { ...(key ? { month: key } : {}) };
      if (accountId || account) filter.accountId = (await resolveAccount({ accountId, account }))._id;
      if (search) filter.$or = [{ accountId: { $in: await accountIds(search) } }, { month: contains(search) }, { note: contains(search) }];
      const matching = await Profit.find(filter, 'collected cost').lean();
      const collected = sum(matching, row => row.collected);
      const cost = sum(matching, row => row.cost);
      await sendList(res, { model: Profit, filter, query: req.input.query, map: withAccounts, name: 'profits', columns: ['id', 'accountId', 'accountName', 'month', 'collected', 'cost', 'note'],
        extra: { summary: { earnedBeforeCosts: collected + cost, costs: cost, profitCollected: collected } } });
    });
    api.get(`${base}/:id`, { tag, summary: 'Read a record', access: ['profits', 'view'] }, async (req, res) => send(res, await single(withAccounts, await find(req.input.params.id))));
    api.post(base, { tag, summary: 'Record a month\'s profit (one per account and month)', access: ['profits', 'create'], body: profitCreate }, async (req, res) => {
      const { accountId, account, accountName, ...input } = req.input.body;
      const row = await transaction(async session => {
        await lock('finance', session);
        const owner = await resolveAccount({ accountId, account, accountName }, session);
        if (await Profit.exists({ accountId: owner._id, month: input.month }).session(session)) throw duplicate();
        const [created] = await Profit.create([{ cost: 0, ...input, accountId: owner._id }], { session });
        await audit(actorOf(req), 'Created', 'profits', created._id, { after: view(created), session });
        return created;
      });
      send(res, await single(withAccounts, row), { status: 201, message: 'Profit recorded' });
    });
    api.put(`${base}/:id`, { tag, summary: 'Edit a record', access: ['profits', 'update'], body: profitUpdate }, update);
    api.patch(`${base}/:id`, { tag, summary: 'Edit a record', access: ['profits', 'update'], body: profitUpdate }, update);
  }
}

export default function investmentRoutes(api) {
  accountRoutes(api);
  entryRoutes(api);
  profitRoutes(api);
}

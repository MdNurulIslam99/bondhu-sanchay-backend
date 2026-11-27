// Monthly deposits and withdrawals. Financial records are never deleted, only reversed or rejected.
import { z } from 'zod';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { allows } from '../lib/permissions.js';
import { contains, send, sendList } from '../lib/respond.js';
import { date, listQuery, month, objectId, optionalText, positiveTaka, text } from '../lib/schemas.js';
import { limiter } from '../lib/security.js';
import { actorOf, audit, lock, transaction, view } from '../lib/tx.js';
import { LedgerEntry, Member, PAYMENT_TYPES, Payment, Withdrawal } from '../models/index.js';
import { memberRefs, resolveMember } from './members.js';
import { getSettings } from './settings.js';
import { memberSubmit, parseMemberSubmission, submissionView, trxKeyOf } from './submissions.js';

const method = z.string().trim().transform((value, context) => {
  if (!value) return '';
  const found = PAYMENT_TYPES.find(type => type.toLowerCase() === value.toLowerCase());
  if (!found) { context.addIssue({ code: 'custom', message: 'Choose a valid payment method' }); return z.NEVER; }
  return found;
});
const PAYMENT_STATUS = z.enum(['pending', 'verified', 'reversed']);
const PAYMENT_NEXT = { pending: ['verified'], verified: ['reversed'], reversed: [] };
const WITHDRAWAL_STATUS = z.enum(['pending', 'approved', 'paid', 'rejected']);
const WITHDRAWAL_NEXT = { pending: ['approved', 'rejected'], approved: ['paid'], paid: [], rejected: [] };

const paymentFields = {
  ...memberRefs, month, amount: positiveTaka, paidDate: optionalText(40), method, trxId: optionalText(100), status: PAYMENT_STATUS,
};
const paymentCreate = z.strictObject(paymentFields).partial().required({ month: true });
const paymentUpdate = z.strictObject(paymentFields).partial();
const withdrawalFields = { ...memberRefs, amount: positiveTaka, reason: text(500), date, status: WITHDRAWAL_STATUS };
const withdrawalCreate = z.strictObject(withdrawalFields).partial().required({ amount: true, reason: true, date: true });
const withdrawalUpdate = z.strictObject(withdrawalFields).partial();

/** Add `memberName` (and `member`, which the admin panel reads) to financial rows. */
async function withMembers(rows) {
  const members = await Member.find({ _id: { $in: rows.map(row => row.memberId) } }, 'name').lean();
  return rows.map(row => {
    const name = members.find(member => String(member._id) === String(row.memberId))?.name ?? '';
    return { ...view(row, ['trxKey']), memberName: name, member: name };
  });
}
const one = async row => (await withMembers([row.toObject ? row.toObject() : row]))[0];

async function memberSearch(search, otherKeys) {
  const members = await Member.find({ name: contains(search) }, '_id').lean();
  return [{ memberId: { $in: members.map(member => member._id) } }, ...otherKeys.map(key => ({ [key]: contains(search) })),
    ...(/^\d+$/.test(search) ? [{ amount: Number(search) }] : [])];
}

async function assertMonthFree(row, member, session) {
  if (await Payment.exists({ _id: { $ne: row._id }, memberId: row.memberId, month: row.month, status: 'verified' }).session(session)) {
    throw conflict(`${member.name} already has a verified deposit for this month.`, 'MONTH_ALREADY_PAID', { month: 'Already paid' });
  }
}

async function changePayment(req, row, status, session) {
  if (status === row.status) return;
  if (!PAYMENT_NEXT[row.status].includes(status)) throw conflict(`A ${row.status} deposit cannot become ${status}.`, 'INVALID_TRANSITION');
  if (status === 'verified') {
    const member = await Member.findById(row.memberId).session(session);
    if (!member || member.status === 'pending') throw conflict('Approve the member before verifying deposits.', 'MEMBER_PENDING');
    await assertMonthFree(row, member, session);
  }
  // Keep the ledger in step when a deposit that came from a submission is reversed.
  if (status === 'reversed' && row.submissionId) {
    const entry = await LedgerEntry.findOne({ submissionId: row.submissionId, active: true }).session(session);
    if (entry) {
      if (entry.amount <= row.amount) entry.active = false;
      else entry.amount -= row.amount;
      await entry.save({ session });
    }
  }
  row.status = status;
}

async function createDeposit(req, input) {
  const settings = await getSettings();
  const member = await resolveMember(input);
  const result = await transaction(async session => {
    await lock('finance', session);
    const status = input.status || 'pending';
    if (status === 'reversed') throw invalid({ status: 'A new deposit cannot start as reversed' });
    if (member.status === 'pending') throw conflict('Approve the member before recording deposits.', 'MEMBER_PENDING');
    const [row] = await Payment.create([{
      memberId: member._id, month: input.month, amount: input.amount ?? settings.monthlyAmount, paidDate: input.paidDate || '',
      method: input.method || '', trxId: input.trxId || '', trxKey: trxKeyOf(input.trxId), status, createdBy: req.user._id,
    }], { session });
    if (status === 'verified') await assertMonthFree(row, member, session);
    await audit(actorOf(req), 'Created', 'payments', row._id, { after: view(row), session });
    return row;
  });
  return one(result);
}

function depositRoutes(api) {
  const tag = 'Monthly deposits';
  const query = listQuery({ sort: ['month', 'amount', 'status', 'createdAt', 'paidDate'], filters: { status: PAYMENT_STATUS.optional(), memberId: objectId.optional(), month: month.optional() } });
  const list = async (req, res) => {
    const { status, memberId, month: key, search } = req.input.query;
    const filter = { ...(status ? { status } : {}), ...(memberId ? { memberId } : {}), ...(key ? { month: key } : {}) };
    if (search) filter.$or = await memberSearch(search, ['month', 'trxId', 'method', 'paidDate']);
    await sendList(res, { model: Payment, filter, query: req.input.query, map: withMembers, name: 'deposits', columns: ['id', 'memberId', 'memberName', 'month', 'amount', 'paidDate', 'method', 'trxId', 'status'] });
  };
  const find = async (id, session) => {
    const row = await Payment.findById(id).session(session || null);
    if (!row) throw notFound('Deposit not found');
    return row;
  };
  const update = async (req, res) => {
    const input = req.input.body;
    const member = input.memberId || input.member || input.memberName ? await resolveMember(input) : null;
    const result = await transaction(async session => {
      await lock('finance', session);
      const row = await find(req.input.params.id, session);
      const before = view(row);
      const patch = {};
      for (const key of ['month', 'amount', 'paidDate', 'method', 'trxId']) if (input[key] !== undefined && input[key] !== row[key]) patch[key] = input[key];
      if (member && String(member._id) !== String(row.memberId)) patch.memberId = member._id;
      const changed = Object.keys(patch);
      // Verified money cannot be rewritten: reverse it and record a new deposit.
      if (changed.length && (row.status === 'reversed' || (row.status === 'verified' && changed.some(key => ['memberId', 'month', 'amount'].includes(key))))) {
        throw conflict('Reverse this deposit and record a new one to change it.', 'HISTORY_PROTECTED');
      }
      if (patch.trxId !== undefined) patch.trxKey = trxKeyOf(patch.trxId);
      row.set(patch);
      if (input.status) await changePayment(req, row, input.status, session);
      await row.save({ session });
      await audit(actorOf(req), 'Updated', 'payments', row._id, { before, after: view(row), session });
      return row;
    });
    send(res, await one(result), { message: 'Deposit saved' });
  };

  for (const base of ['/payments', '/admin/deposits']) {
    api.get(base, { tag, summary: 'List deposits', access: ['payments', 'view'], query }, list);
    api.get(`${base}/:id`, { tag, summary: 'Read a deposit', access: ['payments', 'view'] }, async (req, res) => send(res, await one(await find(req.input.params.id))));
    api.put(`${base}/:id`, { tag, summary: 'Edit a deposit', access: ['payments', 'update'], body: paymentUpdate }, update);
    api.patch(`${base}/:id`, { tag, summary: 'Edit a deposit', access: ['payments', 'update'], body: paymentUpdate }, update);
    api.patch(`${base}/:id/status`, { tag, summary: 'Verify or reverse', access: ['payments', 'update'], body: z.strictObject({ status: PAYMENT_STATUS }) }, update);
  }
  api.post('/admin/deposits', { tag, summary: 'Record a deposit', access: ['payments', 'create'], body: paymentCreate },
    async (req, res) => send(res, await createDeposit(req, req.input.body), { status: 201, message: 'Deposit recorded' }));

  // The website and the admin panel both post to /payments: a body with `category` is a member's submission.
  api.post('/payments', { tag, summary: 'Staff record a deposit, or a member submits a payment (body has "category")', access: 'user', limit: limiter(60) }, async (req, res) => {
    if (req.body?.category !== undefined) {
      const row = await memberSubmit(req, parseMemberSubmission(req.body));
      return send(res, submissionView(row, 'website'), { status: 201, message: 'Your payment was submitted and is waiting for verification.' });
    }
    if (!allows(req.permissions, 'payments', 'create')) throw forbidden();
    const parsed = paymentCreate.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid(Object.fromEntries(parsed.error.issues.map(issue => [issue.path.join('.') || 'body', issue.message])));
    send(res, await createDeposit(req, parsed.data), { status: 201, message: 'Deposit recorded' });
  });
}

function withdrawalRoutes(api) {
  const tag = 'Withdrawals';
  const query = listQuery({ sort: ['date', 'amount', 'status', 'createdAt'], filters: { status: WITHDRAWAL_STATUS.optional(), memberId: objectId.optional() } });
  const find = async (id, session) => {
    const row = await Withdrawal.findById(id).session(session || null);
    if (!row) throw notFound('Withdrawal not found');
    return row;
  };
  const update = async (req, res) => {
    const input = req.input.body;
    const member = input.memberId || input.member || input.memberName ? await resolveMember(input) : null;
    const result = await transaction(async session => {
      await lock('finance', session);
      const row = await find(req.input.params.id, session);
      const before = view(row);
      const patch = {};
      for (const key of ['amount', 'reason', 'date']) if (input[key] !== undefined && input[key] !== row[key]) patch[key] = input[key];
      if (member && String(member._id) !== String(row.memberId)) patch.memberId = member._id;
      if (Object.keys(patch).length && row.status !== 'pending') throw conflict('Only pending requests can be edited.', 'HISTORY_PROTECTED');
      row.set(patch);
      if (input.status && input.status !== row.status) {
        if (!WITHDRAWAL_NEXT[row.status].includes(input.status)) throw conflict(`A ${row.status} request cannot become ${input.status}.`, 'INVALID_TRANSITION');
        row.status = input.status;
      }
      await row.save({ session });
      await audit(actorOf(req), 'Updated', 'withdrawals', row._id, { before, after: view(row), session });
      return row;
    });
    send(res, await one(result), { message: 'Withdrawal saved' });
  };

  for (const base of ['/withdrawals', '/admin/withdrawals']) {
    api.get(base, { tag, summary: 'List withdrawal requests', access: ['withdrawals', 'view'], query }, async (req, res) => {
      const { status, memberId, search } = req.input.query;
      const filter = { ...(status ? { status } : {}), ...(memberId ? { memberId } : {}) };
      if (search) filter.$or = await memberSearch(search, ['reason', 'date']);
      await sendList(res, { model: Withdrawal, filter, query: req.input.query, map: withMembers, name: 'withdrawals', columns: ['id', 'memberId', 'memberName', 'amount', 'reason', 'date', 'status'] });
    });
    api.get(`${base}/:id`, { tag, summary: 'Read a request', access: ['withdrawals', 'view'] }, async (req, res) => send(res, await one(await find(req.input.params.id))));
    api.post(base, { tag, summary: 'Create a request (starts pending)', access: ['withdrawals', 'create'], body: withdrawalCreate }, async (req, res) => {
      const input = req.input.body;
      if (input.status && input.status !== 'pending') throw invalid({ status: 'A new request starts as pending' });
      const member = await resolveMember(input);
      const row = await transaction(async session => {
        await lock('finance', session);
        const [created] = await Withdrawal.create([{ memberId: member._id, amount: input.amount, reason: input.reason, date: input.date }], { session });
        await audit(actorOf(req), 'Created', 'withdrawals', created._id, { after: view(created), session });
        return created;
      });
      send(res, await one(row), { status: 201, message: 'Request created' });
    });
    api.put(`${base}/:id`, { tag, summary: 'Edit a request', access: ['withdrawals', 'update'], body: withdrawalUpdate }, update);
    api.patch(`${base}/:id`, { tag, summary: 'Edit a request', access: ['withdrawals', 'update'], body: withdrawalUpdate }, update);
    api.patch(`${base}/:id/status`, { tag, summary: 'pending → approved → paid, or pending → rejected', access: ['withdrawals', 'update'], body: z.strictObject({ status: WITHDRAWAL_STATUS }) }, update);
  }
}

export default function paymentRoutes(api) {
  depositRoutes(api);
  withdrawalRoutes(api);
}

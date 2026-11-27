import { z } from 'zod';
import { linkedMember } from '../lib/api.js';
import { today } from '../domain/calculations.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { allows } from '../lib/permissions.js';
import { contains, send, sendList, sendRows } from '../lib/respond.js';
import { date, listQuery, objectId, optionalPhone, optionalText, positiveTaka, text } from '../lib/schemas.js';
import { actorOf, audit, lock, transaction, view } from '../lib/tx.js';
import { Member, Payment, Submission, User, Withdrawal } from '../models/index.js';
import { loadLedger, memberAccount } from './ledger.js';
import { getSettings } from './settings.js';

const STATUS = z.enum(['pending', 'active', 'inactive']);
const TRANSITIONS = { pending: ['active'], active: ['inactive'], inactive: ['active'] };
const optionalNid = z.union([z.literal(''), z.string().trim().regex(/^\d{10,17}$/, 'NID must be 10–17 digits')]);
const fields = {
  sl: z.number().int().min(1).max(100000),
  name: text(80).min(2),
  phone: optionalPhone,
  nid: optionalNid,
  address: optionalText(1000),
  nominee: optionalText(200),
  joinDate: z.union([z.literal(''), date]),
  monthly: positiveTaka,
  status: STATUS,
};
export const memberFields = fields; // lead members accept the same personal details
const createBody = z.strictObject(fields).partial().required({ name: true });
const updateBody = z.strictObject(fields).partial();

/** Look a member up by id, or by name for forms that only know the name. */
export async function resolveMember({ memberId, member, memberName }, session) {
  if (memberId) {
    const row = await Member.findById(memberId).session(session || null);
    if (!row) throw invalid({ memberId: 'Member not found' });
    return row;
  }
  const name = member ?? memberName;
  if (!name) throw invalid({ memberId: 'Choose a member' });
  const rows = await Member.find({ name }).limit(2).session(session || null);
  if (rows.length === 0) throw invalid({ member: `No member is named "${name}".` });
  if (rows.length > 1) throw invalid({ member: `More than one member is named "${name}". Send memberId instead.` });
  return rows[0];
}
export const memberRefs = { memberId: objectId.optional(), member: z.string().trim().max(80).optional(), memberName: z.string().trim().max(80).optional() };

export async function nextSerial(session) {
  await lock('members', session);
  const last = await Member.findOne().sort({ sl: -1 }).session(session).lean();
  return (last?.sl || 0) + 1;
}

const statusChange = (member, status, settings) => {
  if (!TRANSITIONS[member.status].includes(status)) throw conflict(`A ${member.status} member cannot become ${status}.`, 'INVALID_TRANSITION');
  if (status === 'inactive') member.inactiveMonth = settings.lastCollectionMonth;
  else member.inactiveMonth = undefined;
  // A newly approved applicant owes from the month they joined, not from the first collection month.
  if (member.status === 'pending' && !member.joinDate) member.joinDate = today();
  member.status = status;
};

const dueFields = dues => ({ paidCount: dues.paidCount, expectedCount: dues.expectedCount, paidMonths: dues.paidMonths, dueMonths: dues.dueMonths,
  advanceMonths: dues.advanceMonths, paidAmount: dues.paidAmount, dueAmount: dues.dueAmount, paidTotal: dues.paidAmount, dueTotal: dues.dueAmount });
/** Fields every signed-in member may see. */
const directoryRow = (ledger, member) => ({ id: String(member._id), sl: member.sl, name: member.name, phone: member.phone, status: member.status,
  joinDate: member.joinDate || '', monthly: member.monthly, ...dueFields(memberAccount(ledger, member)) });
const staffRow = (ledger, member) => ({ ...view(member), ...dueFields(memberAccount(ledger, member)) });

/** Staff with the Members page see everything; approved members see the directory. */
async function audience(req) {
  if (allows(req.permissions, 'members', 'view')) return 'staff';
  if (req.user.role === 'member' ? await linkedMember(req.user) : allows(req.permissions, 'dashboard', 'view')) return 'member';
  throw forbidden(req.user.role === 'member' ? 'Your account is waiting to be approved as a member' : 'Permission denied');
}

export default function memberRoutes(api) {
  const tag = 'Members';
  const query = listQuery({ sort: ['sl', 'name', 'status', 'createdAt', 'dueAmount', 'paidAmount'], defaultOrder: 'asc', filters: { status: STATUS.optional() } });

  for (const base of ['/members', '/admin/members']) {
    api.get(base, { tag, summary: 'Members with dues (staff) or the member directory', access: 'user', query }, async (req, res) => {
      const staff = await audience(req) === 'staff';
      const { status, search, sort } = req.input.query;
      const filter = {};
      if (status) filter.status = status;
      if (!staff) filter.status = status === 'pending' || !status ? { $ne: 'pending' } : status;
      if (search) filter.$or = (staff ? ['name', 'phone', 'nid'] : ['name', 'phone']).map(key => ({ [key]: contains(search) }));
      const ledger = await loadLedger();
      const map = rows => rows.map(row => (staff ? staffRow : directoryRow)(ledger, row));
      const columns = ['sl', 'name', 'phone', ...(staff ? ['nid', 'address', 'nominee', 'joinDate', 'monthly'] : []), 'status', 'paidCount', 'expectedCount', 'dueMonths', 'dueAmount', 'paidAmount'];
      // Dues are calculated, so sorting by them happens after loading.
      if (['dueAmount', 'paidAmount'].includes(sort)) return sendRows(res, { rows: map(await Member.find(filter).lean()), query: req.input.query, name: 'members', columns });
      await sendList(res, { model: Member, filter, query: req.input.query, map, name: 'members', columns });
    });

    api.get(`${base}/:id`, { tag, summary: 'Member details, account and monthly history', access: 'user' }, async (req, res) => {
      const staff = await audience(req) === 'staff';
      const member = await Member.findById(req.input.params.id).lean();
      if (!member || (!staff && member.status === 'pending')) throw notFound('Member not found');
      const ledger = await loadLedger();
      const account = memberAccount(ledger, member);
      const paid = ledger.payments.filter(row => String(row.memberId) === String(member._id));
      const history = [...new Set([...account.expectedMonths, ...account.paidMonths])].sort().map(month => {
        const payment = paid.find(row => row.month === month);
        return { month, status: payment ? 'paid' : 'missed', amount: payment?.amount ?? 0, paidDate: payment?.paidDate ?? '', advance: month > ledger.settings.lastCollectionMonth };
      });
      send(res, { ...(staff ? staffRow : directoryRow)(ledger, member), account, history,
        ...(staff && allows(req.permissions, 'payments') ? { payments: (await Payment.find({ memberId: member._id }).sort({ month: -1 }).lean()).map(row => view(row)) } : {}) });
    });

    api.post(base, { tag, summary: 'Add a member', access: ['members', 'create'], body: createBody }, async (req, res) => {
      const settings = await getSettings();
      const result = await transaction(async session => {
        const input = { status: 'pending', monthly: settings.monthlyAmount, ...req.input.body };
        input.sl ??= await nextSerial(session);
        if (input.status !== 'pending' && !input.joinDate) input.joinDate = today();
        if (input.status === 'inactive') input.inactiveMonth = settings.lastCollectionMonth;
        const [row] = await Member.create([input], { session });
        await audit(actorOf(req), 'Created', 'members', row._id, { after: view(row), session });
        return view(row);
      });
      send(res, result, { status: 201, message: 'Member added' });
    });

    const update = async (req, res) => {
      const settings = await getSettings();
      const result = await transaction(async session => {
        const row = await Member.findById(req.input.params.id).session(session);
        if (!row) throw notFound('Member not found');
        const before = view(row);
        const { status, ...input } = req.input.body;
        row.set(input);
        if (status && status !== row.status) statusChange(row, status, settings);
        await row.save({ session });
        await audit(actorOf(req), 'Updated', 'members', row._id, { before, after: view(row), session });
        return view(row);
      });
      send(res, result, { message: 'Member saved' });
    };
    api.put(`${base}/:id`, { tag, summary: 'Update a member', access: ['members', 'update'], body: updateBody }, update);
    api.patch(`${base}/:id`, { tag, summary: 'Update a member', access: ['members', 'update'], body: updateBody }, update);
    api.patch(`${base}/:id/status`, { tag, summary: 'Approve, deactivate or reactivate', access: ['members', 'update'], body: z.strictObject({ status: STATUS }) }, update);

    api.delete(`${base}/:id`, { tag, summary: 'Delete a member without financial history', access: ['members', 'delete'] }, async (req, res) => {
      await transaction(async session => {
        await lock('finance', session);
        const row = await Member.findById(req.input.params.id).session(session);
        if (!row) throw notFound('Member not found');
        for (const model of [Payment, Withdrawal, Submission]) {
          if (await model.exists({ memberId: row._id }).session(session)) throw conflict('This member has payment history. Set the member to inactive instead.', 'HAS_HISTORY');
        }
        await row.deleteOne({ session });
        await User.updateMany({ memberId: row._id }, { $set: { linkStatus: 'unverified' }, $unset: { memberId: 1 } }, { session });
        await audit(actorOf(req), 'Deleted', 'members', row._id, { before: view(row), session });
      });
      send(res, null, { message: 'Member deleted' });
    });
  }
}

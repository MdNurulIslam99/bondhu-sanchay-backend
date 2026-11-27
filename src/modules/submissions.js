// Payments members report after paying by hand. Nothing reaches a balance until staff verify it.
import { z } from 'zod';
import { linkedMember } from '../lib/api.js';
import { today } from '../domain/calculations.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { contains, send, sendList } from '../lib/respond.js';
import { date, listQuery, month, objectId, optionalText, positiveTaka } from '../lib/schemas.js';
import { limiter } from '../lib/security.js';
import { actorOf, audit, lock, transaction, view } from '../lib/tx.js';
import { InvestmentAccount, LedgerEntry, Member, PAYMENT_TYPES, Payment, Profit, Submission } from '../models/index.js';
import { loadLedger } from './ledger.js';
import { memberRefs, resolveMember } from './members.js';

export const trxKeyOf = value => String(value || '').toUpperCase().replace(/\s+/g, '');
const needsTrx = new Set(['bKash', 'Nagad', 'Rocket', 'Bank']);
const MAX_MEMBER_AMOUNT = 10_000_000;

/** Accepts both spellings: "bKash" (admin panel) and "bkash" (website). */
export const paymentType = z.string().trim().transform((value, context) => {
  const found = PAYMENT_TYPES.find(type => type.toLowerCase() === value.toLowerCase());
  if (!found) { context.addIssue({ code: 'custom', message: 'Please choose a payment type.' }); return z.NEVER; }
  return found;
});
const months = z.array(month).max(36).transform(list => [...new Set(list)].sort());
const category = z.enum(['savings', 'profit']);

const details = {
  date: date.optional(), paymentDate: date.optional(),
  amount: positiveTaka,
  month: month.optional(), months: months.optional(),
  category,
  type: paymentType.optional(), method: paymentType.optional(),
  trxId: optionalText(100).optional(), transactionId: optionalText(100).optional(),
  payerAccount: optionalText(40).optional(),
  description: optionalText(500).optional(),
};
// Website members: unknown keys such as status or member_id are silently dropped.
const memberBody = z.object(details);
// Staff: the admin panel also sends its own defaults, which the server decides itself.
const staffBody = z.strictObject({ ...details, ...memberRefs, status: z.any().optional(), source: z.any().optional(), submittedAt: z.any().optional() });
const staffPatch = staffBody.partial();

/** Normalise the two field vocabularies into the stored shape. */
function normalize(input) {
  const result = {};
  const paidOn = input.date ?? input.paymentDate;
  const type = input.type ?? input.method;
  const trxId = input.trxId ?? input.transactionId;
  const list = input.months ?? (input.month ? [input.month] : undefined);
  if (paidOn) result.date = paidOn;
  if (type) result.type = type;
  if (trxId !== undefined) { result.trxId = trxId; result.trxKey = trxKeyOf(trxId); }
  if (list) result.months = list;
  for (const key of ['amount', 'category', 'payerAccount', 'description']) if (input[key] !== undefined) result[key] = input[key];
  return result;
}

function check(row) {
  const fields = {};
  if (!row.date) fields.date = 'Please choose the payment date.';
  else if (row.date > today()) fields.date = 'The payment date cannot be in the future.';
  if (!row.type) fields.type = 'Please choose a payment type.';
  if (row.category === 'savings' && !row.months?.length) fields.months = 'Please select the month(s) this savings payment is for.';
  if (needsTrx.has(row.type) && !row.trxId) fields.trxId = `Please enter the ${row.type} transaction ID.`;
  if (Object.keys(fields).length) throw invalid(fields);
}

async function assertNewTransaction(row, session, ownId) {
  if (!row.trxKey) return;
  const other = ownId ? { _id: { $ne: ownId } } : {};
  const used = await Submission.exists({ ...other, trxKey: row.trxKey, active: true }).session(session)
    || await Payment.exists({ trxKey: row.trxKey, status: { $ne: 'reversed' }, ...(ownId ? { submissionId: { $ne: ownId } } : {}) }).session(session);
  if (used) throw conflict('This transaction ID has already been submitted.', 'DUPLICATE_TRANSACTION', { trxId: 'Already submitted' });
}

/** `website` uses lower-case methods and calls a verified payment "approved". */
export function submissionView(row, style = 'admin') {
  const data = view(row, ['trxKey', 'active']);
  const status = style === 'website' && data.status === 'verified' ? 'approved' : data.status;
  return {
    ...data, status,
    memberId: data.memberId || null, member: data.memberName, month: data.months?.[0] || data.date.slice(0, 7),
    type: style === 'website' ? data.type.toLowerCase() : data.type, method: data.type.toLowerCase(),
    paymentDate: data.date, transactionId: data.trxId,
    reviewedBy: data.reviewedByName || null, reviewedById: data.reviewedBy || null, reviewedByName: undefined,
  };
}

async function createSubmission(req, base) {
  check(base);
  return transaction(async session => {
    await lock('finance', session);
    await assertNewTransaction(base, session);
    const [row] = await Submission.create([{ ...base, status: 'pending', submittedAt: new Date() }], { session });
    await audit(actorOf(req), 'Submitted payment', 'payment-submissions', row._id, { after: view(row), session });
    return row;
  });
}

/** A signed-in website user reports a payment. The member always comes from the account, never the body. */
export async function memberSubmit(req, input) {
  if (input.amount > MAX_MEMBER_AMOUNT) throw invalid({ amount: 'That amount is too large. Please check it.' });
  const row = normalize(input);
  if (row.trxId && !/^[A-Za-z0-9\-_/ ]{4,40}$/.test(row.trxId)) throw invalid({ trxId: 'The transaction ID should be 4–40 letters, numbers, - or _.' });
  const member = await linkedMember(req.user);
  return createSubmission(req, { ...row, userId: req.user._id, memberId: member?._id, memberName: member?.name ?? req.user.name, source: 'website' });
}

export const parseMemberSubmission = body => {
  const result = memberBody.safeParse(body ?? {});
  if (result.success) return result.data;
  throw invalid(Object.fromEntries(result.error.issues.map(issue => [issue.path.join('.') || 'body', issue.message])));
};

const approvedSavings = async (submission, options, actor, session) => {
  const member = submission.memberId ? await Member.findById(submission.memberId).session(session) : null;
  if (!member || member.status === 'pending') throw invalid({ member: `No approved member is linked to "${submission.memberName}". Edit the payment and choose a member first.` });
  const list = options.months ?? submission.months;
  if (!list.length) throw invalid({ months: 'Choose at least one month' });
  const taken = await Payment.find({ memberId: member._id, month: { $in: list }, status: 'verified' }).session(session).lean();
  if (taken.length) {
    throw conflict(`${member.name} already has a verified deposit for this month.`, 'MONTH_ALREADY_PAID', { months: taken.map(row => row.month).sort().join(', ') });
  }
  const expected = list.length * member.monthly;
  const matches = submission.amount === expected;
  if (!matches && !options.confirmAmountMismatch) {
    throw conflict(`The amount ৳${submission.amount} does not match ${list.length} month(s) × ৳${member.monthly} = ৳${expected}. Confirm to approve it anyway.`,
      'AMOUNT_MISMATCH', { amount: `Expected ৳${expected}` });
  }
  if (submission.amount < list.length) throw invalid({ amount: 'The amount is too small to split across these months' });
  // A mismatching amount is split evenly; the first months take the remainder.
  const share = Math.floor(submission.amount / list.length);
  const remainder = submission.amount - share * list.length;
  return Payment.create(list.map((key, index) => ({
    memberId: member._id, month: key, amount: share + (index < remainder ? 1 : 0), paidDate: submission.date, method: submission.type,
    trxId: submission.trxId, trxKey: submission.trxKey, status: 'verified', submissionId: submission._id, createdBy: actor,
  })), { session, ordered: true });
};

async function applyProfit(submission, { accountId, month: key }, session) {
  if (!accountId) return;
  if (!await InvestmentAccount.exists({ _id: accountId }).session(session)) throw invalid({ accountId: 'Investment account not found' });
  const period = key || submission.months[0] || submission.date.slice(0, 7);
  await Profit.updateOne({ accountId, month: period }, { $inc: { collected: submission.amount }, $setOnInsert: { cost: 0, note: 'From a verified payment' } }, { upsert: true, session });
  submission.set({ appliedAccountId: accountId, appliedMonth: period });
}

const balances = async () => {
  const { totals } = await loadLedger();
  return { savings: totals.collected, profit: totals.profit, cash: totals.cash, allTotal: totals.allTotal };
};

/**
 * Verify or reject in one transaction. The status changes only if it is still pending, so two
 * simultaneous clicks produce exactly one ledger entry.
 */
export async function reviewSubmission(req, id, decision, options = {}, { repeatable = false } = {}) {
  const before = await balances();
  const outcome = await transaction(async session => {
    await lock('finance', session);
    const row = await Submission.findOneAndUpdate({ _id: id, status: 'pending' }, {
      $set: { status: decision, active: decision !== 'rejected', reviewedBy: req.user._id, reviewedByName: req.user.name, reviewedAt: new Date(), reviewNote: options.note || '' },
    }, { session, returnDocument: 'after' });
    if (!row) {
      const current = await Submission.findById(id).session(session);
      if (!current) throw notFound('Payment not found');
      if (repeatable && current.status === decision) return { row: current, changed: false };
      throw conflict('Only pending payments can be reviewed.', 'NOT_PENDING');
    }
    if (decision === 'verified') {
      if (row.category === 'savings') await approvedSavings(row, options, req.user._id, session);
      else await applyProfit(row, options, session);
      await row.save({ session });
      await LedgerEntry.create([{ submissionId: row._id, type: row.category, amount: row.amount, memberId: row.memberId, createdBy: req.user._id }], { session });
    }
    await audit(actorOf(req), decision === 'verified' ? 'Verified payment' : 'Rejected payment', 'payment-submissions', row._id,
      { before: { status: 'pending' }, after: view(row), session });
    return { row, changed: true };
  });
  return { ...outcome, balances: { before, after: await balances() } };
}

/** Take whatever a verified payment added back out of every balance. Does nothing for other statuses. */
async function removeFromBalance(row, session) {
  await Payment.updateMany({ submissionId: row._id, status: 'verified' }, { status: 'reversed' }, { session });
  await LedgerEntry.updateMany({ submissionId: row._id, active: true }, { active: false }, { session });
  if (row.appliedAccountId) {
    const profit = await Profit.findOne({ accountId: row.appliedAccountId, month: row.appliedMonth }).session(session);
    if (!profit || profit.collected < row.amount) throw conflict('The profit record was edited. Correct it first, then try again.', 'PROFIT_CHANGED');
    profit.collected -= row.amount;
    await profit.save({ session });
  }
}

/** Super admin correction: undo a review so that the payment is pending again. */
async function reopen(req, id, reason) {
  return transaction(async session => {
    await lock('finance', session);
    const row = await Submission.findById(id).session(session);
    if (!row) throw notFound('Payment not found');
    if (row.status === 'pending') throw conflict('This payment is already pending.', 'NOT_REVIEWED');
    const before = view(row);
    if (row.status === 'rejected') await assertNewTransaction(row, session, row._id);
    await removeFromBalance(row, session);
    row.set({ status: 'pending', active: true, reviewedBy: undefined, reviewedByName: undefined, reviewedAt: undefined, reviewNote: '', appliedAccountId: undefined, appliedMonth: undefined });
    await row.save({ session });
    await audit(actorOf(req), 'Reopened payment', 'payment-submissions', row._id, { before, after: { ...view(row), reason }, session });
    return row;
  });
}

/**
 * Delete a payment of any status. Its money leaves the balance in the same transaction. Deposits it
 * created stay as reversed history, and the audit log keeps a copy of the deleted record.
 */
async function remove(req, id) {
  return transaction(async session => {
    await lock('finance', session);
    const row = await Submission.findById(id).session(session);
    if (!row) throw notFound('Payment not found');
    const before = view(row);
    await removeFromBalance(row, session);
    await row.deleteOne({ session });
    await audit(actorOf(req), 'Deleted payment', 'payment-submissions', row._id, { before, session });
  });
}

// Deleting is fixed to these roles; Role Actions cannot give it to anyone else.
const DELETE_ROLES = new Set(['super_admin', 'admin']);

const reviewOptions = {
  note: optionalText(500).optional(), months: months.optional(), confirmAmountMismatch: z.boolean().optional(),
  accountId: objectId.optional(), month: month.optional(),
};

function filterOf(query, style) {
  const { status, category: kind, type, method, from, to, memberId, search, q } = query;
  const filter = {};
  if (status) filter.status = status === 'approved' ? 'verified' : status;
  if (kind) filter.category = kind;
  if (type || method) filter.type = type || method;
  if (memberId) filter.memberId = memberId;
  if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const needle = search || q;
  if (needle) filter.$or = [...['memberName', 'trxId', 'description', 'months', 'date'].map(key => ({ [key]: contains(needle) })),
    ...(/^\d+$/.test(needle) ? [{ amount: Number(needle) }] : [])];
  return filter;
}

const filters = {
  status: z.enum(['pending', 'verified', 'approved', 'rejected']).optional(), category: category.optional(), type: paymentType.optional(), method: paymentType.optional(),
  from: date.optional(), to: date.optional(), memberId: objectId.optional(), q: z.string().max(100).optional(),
};
const query = listQuery({ sort: ['submittedAt', 'date', 'amount', 'status', 'memberName'], filters });
const columns = ['id', 'member', 'date', 'amount', 'months', 'category', 'type', 'trxId', 'payerAccount', 'description', 'status', 'source', 'submittedAt', 'reviewedBy', 'reviewedAt', 'reviewNote'];

const listAs = (style, extraFilter = () => ({})) => async (req, res) => sendList(res, {
  model: Submission, filter: { ...filterOf(req.input.query, style), ...extraFilter(req) }, query: req.input.query,
  map: rows => rows.map(row => submissionView(row, style)), name: 'payment-submissions', columns,
});

async function find(id) {
  const row = await Submission.findById(id).lean();
  if (!row) throw notFound('Payment not found');
  return row;
}

export default function submissionRoutes(api) {
  const tag = 'Payment submissions';

  // Website: members
  api.get('/payments/mine', { tag, summary: 'Own submitted payments', access: 'user', query }, listAs('website', req => ({ userId: req.user._id })));
  api.post('/public/payment-submissions', { tag, summary: 'Submit a payment (login required)', access: 'user', limit: limiter(20) }, async (req, res) => {
    const row = await memberSubmit(req, parseMemberSubmission(req.body));
    send(res, { status: row.status, submittedAt: row.submittedAt }, { status: 201, message: 'Your payment was submitted and is waiting for verification.' });
  });

  // Admin panel and website admin paths
  for (const [base, style] of [['/payment-submissions', 'admin'], ['/admin/payment-submissions', 'admin'], ['/admin/payments', 'website']]) {
    api.get(base, { tag, summary: 'List submitted payments', access: ['payment-submissions', 'view'], query }, listAs(style));
    api.get(`${base}/:id`, { tag, summary: 'Read a submitted payment', access: ['payment-submissions', 'view'] },
      async (req, res) => send(res, submissionView(await find(req.input.params.id), style)));
  }
  for (const base of ['/payment-submissions', '/admin/payment-submissions']) {
    api.post(base, { tag, summary: 'Record a payment on behalf of a member', access: ['payment-submissions', 'create'], body: staffBody }, async (req, res) => {
      const input = req.input.body;
      const member = await resolveMember(input);
      const row = await createSubmission(req, { description: '', ...normalize(input), memberId: member._id, memberName: member.name, source: 'admin' });
      send(res, submissionView(row), { status: 201, message: 'Payment recorded' });
    });
    const update = async (req, res) => {
      const input = req.input.body;
      const member = input.memberId || input.member || input.memberName ? await resolveMember(input) : null;
      const row = await transaction(async session => {
        await lock('finance', session);
        const current = await Submission.findById(req.input.params.id).session(session);
        if (!current) throw notFound('Payment not found');
        if (current.status !== 'pending') throw conflict('Only pending payments can be edited.', 'NOT_PENDING');
        const before = view(current);
        current.set({ ...normalize(input), ...(member ? { memberId: member._id, memberName: member.name } : {}) });
        check(current);
        await assertNewTransaction(current, session, current._id);
        await current.save({ session });
        await audit(actorOf(req), 'Updated', 'payment-submissions', current._id, { before, after: view(current), session });
        return current;
      });
      send(res, submissionView(row), { message: 'Payment saved' });
    };
    api.put(`${base}/:id`, { tag, summary: 'Edit a pending payment', access: ['payment-submissions', 'update'], body: staffPatch }, update);
    api.patch(`${base}/:id`, { tag, summary: 'Edit a pending payment', access: ['payment-submissions', 'update'], body: staffPatch }, update);
    api.post(`${base}/:id/review`, { tag, summary: 'Verify or reject a pending payment', access: ['payment-submissions', 'update'],
      body: z.strictObject({ decision: z.enum(['verified', 'rejected']), ...reviewOptions }) }, async (req, res) => {
      const { decision, ...options } = req.input.body;
      const result = await reviewSubmission(req, req.input.params.id, decision, options);
      send(res, { ...submissionView(result.row), balances: result.balances }, { message: decision === 'verified' ? 'Payment verified' : 'Payment rejected' });
    });
    api.post(`${base}/:id/reopen`, { tag, summary: 'Undo a review (super admin)', access: 'superadmin', body: z.strictObject({ reason: z.string().trim().min(3).max(500) }) },
      async (req, res) => send(res, submissionView(await reopen(req, req.input.params.id, req.input.body.reason)), { message: 'Payment is pending again' }));
    api.delete(`${base}/:id`, { tag, summary: 'Delete a payment (super admin or admin)', access: ['payment-submissions', 'view'] }, async (req, res) => {
      if (!DELETE_ROLES.has(req.user.role)) throw forbidden('Only a Super Admin or Admin can delete a payment.');
      await remove(req, req.input.params.id);
      send(res, null, { message: 'Payment deleted' });
    });
  }

  api.post('/admin/payments/:id/approve', { tag, summary: 'Approve a payment (safe to repeat)', access: ['payment-submissions', 'update'], body: z.strictObject(reviewOptions) }, async (req, res) => {
    const result = await reviewSubmission(req, req.input.params.id, 'verified', req.input.body, { repeatable: true });
    send(res, submissionView(result.row, 'website'), { balances: result.balances, changed: result.changed, message: result.changed ? 'Payment approved' : 'Payment was already approved' });
  });
  api.post('/admin/payments/:id/reject', { tag, summary: 'Reject a payment with a reason', access: ['payment-submissions', 'update'],
    body: z.strictObject({ note: z.string().trim().min(1, 'A reason is required').max(500) }) }, async (req, res) => {
    const result = await reviewSubmission(req, req.input.params.id, 'rejected', req.input.body, { repeatable: true });
    send(res, submissionView(result.row, 'website'), { balances: result.balances, changed: result.changed, message: result.changed ? 'Payment rejected' : 'Payment was already rejected' });
  });

  api.get('/admin/ledger', { tag, summary: 'Ledger entries created by verified submissions (CSV with ?format=csv)', access: ['payment-submissions', 'view'],
    query: listQuery({ sort: ['createdAt', 'amount'], filters: { type: category.optional(), memberId: objectId.optional() } }) }, async (req, res) => {
    const { type, memberId } = req.input.query;
    await sendList(res, { model: LedgerEntry, filter: { ...(type ? { type } : {}), ...(memberId ? { memberId } : {}) }, query: req.input.query,
      map: rows => rows.map(row => view(row)), name: 'ledger', columns: ['id', 'submissionId', 'type', 'amount', 'memberId', 'createdBy', 'active', 'createdAt'] });
  });
}

// Lead members: applications from the website. They become members only when staff accept them.
import { z } from 'zod';
import { today } from '../domain/calculations.js';
import { conflict, notFound } from '../lib/errors.js';
import { contains, send, sendList } from '../lib/respond.js';
import { date, listQuery, optionalText, phone, positiveTaka } from '../lib/schemas.js';
import { actorOf, audit, lock, transaction, view } from '../lib/tx.js';
import { Member, MemberLead } from '../models/index.js';
import { memberFields, nextSerial } from './members.js';
import { getSettings } from './settings.js';

const { name, nid, address, nominee } = memberFields;
const updateBody = z.strictObject({ name, phone, nid, address, nominee, note: optionalText(1000) }).partial();
const acceptBody = z.strictObject({ joinDate: date.optional(), monthly: positiveTaka.optional() });

const find = async (id, session) => {
  const row = await MemberLead.findById(id).session(session || null);
  if (!row) throw notFound('Lead not found');
  return row;
};

export default function leadRoutes(api) {
  const tag = 'Lead members';
  const query = listQuery({ sort: ['createdAt', 'name'] });
  const update = async (req, res) => {
    const row = await transaction(async session => {
      await lock('members', session);
      const lead = await find(req.input.params.id, session);
      const before = view(lead);
      lead.set(req.input.body);
      if (await MemberLead.exists({ _id: { $ne: lead._id }, phone: lead.phone }).session(session)) {
        throw conflict('Another lead already has this number.', 'DUPLICATE_RECORD', { phone: 'Already in the lead list' });
      }
      await lead.save({ session });
      await audit(actorOf(req), 'Updated', 'member-leads', lead._id, { before, after: view(lead), session });
      return lead;
    });
    send(res, view(row), { message: 'Lead saved' });
  };

  // Whoever may see, edit, delete or add members may do the same with leads.
  for (const base of ['/member-leads', '/admin/member-leads']) {
    api.get(base, { tag, summary: 'List applications waiting to be accepted', access: ['members', 'view'], query }, async (req, res) => {
      const { search } = req.input.query;
      const filter = search ? { $or: ['name', 'phone', 'nid', 'address'].map(key => ({ [key]: contains(search) })) } : {};
      await sendList(res, { model: MemberLead, filter, query: req.input.query, map: rows => rows.map(row => view(row)), name: 'member-leads',
        columns: ['id', 'name', 'phone', 'nid', 'address', 'nominee', 'note', 'createdAt'] });
    });
    api.get(`${base}/:id`, { tag, summary: 'View a lead', access: ['members', 'view'] }, async (req, res) => send(res, view(await find(req.input.params.id))));
    api.put(`${base}/:id`, { tag, summary: 'Update a lead', access: ['members', 'update'], body: updateBody }, update);
    api.patch(`${base}/:id`, { tag, summary: 'Update a lead', access: ['members', 'update'], body: updateBody }, update);
    api.delete(`${base}/:id`, { tag, summary: 'Delete a lead', access: ['members', 'delete'] }, async (req, res) => {
      await transaction(async session => {
        await lock('members', session);
        const lead = await find(req.input.params.id, session);
        await lead.deleteOne({ session });
        await audit(actorOf(req), 'Deleted', 'member-leads', lead._id, { before: view(lead), session });
      });
      send(res, null, { message: 'Lead deleted' });
    });
    api.post(`${base}/:id/accept`, { tag, summary: 'Accept a lead: it becomes an active member', access: ['members', 'create'], body: acceptBody }, async (req, res) => {
      const settings = await getSettings();
      const member = await transaction(async session => {
        const sl = await nextSerial(session); // also makes two clicks on "Accept" run one after the other
        const lead = await find(req.input.params.id, session);
        if (await Member.exists({ phone: lead.phone }).session(session)) {
          throw conflict('A member already has this mobile number. Correct the number or delete the lead.', 'DUPLICATE_RECORD', { phone: 'Already a member' });
        }
        const [row] = await Member.create([{
          sl, name: lead.name, phone: lead.phone, nid: lead.nid, address: lead.address, nominee: lead.nominee, status: 'active',
          joinDate: req.input.body.joinDate || today(), monthly: req.input.body.monthly || settings.monthlyAmount,
        }], { session });
        await lead.deleteOne({ session });
        await audit(actorOf(req), 'Created', 'members', row._id, { after: view(row), session });
        await audit(actorOf(req), 'Accepted', 'member-leads', lead._id, { before: view(lead), after: { memberId: String(row._id) }, session });
        return view(row);
      });
      send(res, member, { status: 201, message: `${member.name} is now a member` });
    });
  }
}

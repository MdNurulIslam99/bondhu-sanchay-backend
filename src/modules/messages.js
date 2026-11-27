// MESSAGE INBOX: SWITCHED OFF. Nothing imports this file, so no messages route or collection exists.
// To switch it on:
//   1. src/routes/index.js: uncomment the `messageRoutes` import and call.
//   2. src/lib/permissions.js: uncomment the two `messages` lines (and remove it from IGNORED in src/modules/users.js).
//   3. Admin panel: uncomment the "messages" lines.
//   4. Run `npm run db:migrate`.
import mongoose from 'mongoose';
import { z } from 'zod';
import { conflict, notFound } from '../lib/errors.js';
import { contains, send, sendList } from '../lib/respond.js';
import { listQuery, optionalText, phone, text } from '../lib/schemas.js';
import { limiter } from '../lib/security.js';
import { actorOf, audit, transaction, view } from '../lib/tx.js';

const schema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: String,
  subject: String,
  message: { type: String, required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['new', 'read'], default: 'new' },
}, { timestamps: true, autoIndex: false, autoCreate: false, bufferCommands: false });
schema.index({ status: 1, createdAt: -1 });
export const Message = mongoose.models.Message || mongoose.model('Message', schema, 'messages');

const STATUS = z.enum(['new', 'read']);

export default function messageRoutes(api) {
  const tag = 'Messages';
  api.post('/public/messages', {
    tag, summary: 'Contact form', limit: limiter(5),
    // `website` is a honeypot: real visitors never see or fill it.
    body: z.strictObject({ name: text(80).min(2), phone, email: z.union([z.literal(''), z.email()]).optional(), subject: optionalText(120).optional(),
      message: text(5000).min(5), website: z.string().max(200).optional(), captchaToken: z.string().max(4000).optional() }),
  }, async (req, res) => {
    const { website, captchaToken, ...input } = req.input.body;
    if (!website) await Message.create({ ...input, date: new Date().toISOString().slice(0, 10) });
    send(res, null, { status: 202, message: 'Your message has been received.' });
  });

  const query = listQuery({ sort: ['createdAt', 'date', 'name', 'status'], filters: { status: STATUS.optional() } });
  api.get('/messages', { tag, summary: 'Inbox', access: ['messages', 'view'], query }, async (req, res) => {
    const { status, search } = req.input.query;
    const filter = { ...(status ? { status } : {}), ...(search ? { $or: ['name', 'phone', 'message'].map(key => ({ [key]: contains(search) })) } : {}) };
    await sendList(res, { model: Message, filter, query: req.input.query, map: rows => rows.map(row => view(row)), name: 'messages', columns: ['id', 'name', 'phone', 'message', 'date', 'status'] });
  });
  const change = remove => async (req, res) => {
    const data = await transaction(async session => {
      const row = await Message.findById(req.input.params.id).session(session);
      if (!row) throw notFound();
      const before = { status: row.status };
      if (remove) await row.deleteOne({ session });
      else {
        const next = req.input.body.status;
        if (row.status === next) throw conflict('Message is already marked this way', 'INVALID_TRANSITION');
        row.status = next;
        await row.save({ session });
      }
      // The audit log keeps no message text or phone number.
      await audit(actorOf(req), remove ? 'Deleted' : 'Updated', 'messages', row._id, { before, session });
      return remove ? null : view(row);
    });
    send(res, data);
  };
  api.patch('/messages/:id', { tag, summary: 'Mark read or unread', access: ['messages', 'update'], body: z.strictObject({ status: STATUS }) }, change(false));
  api.delete('/messages/:id', { tag, summary: 'Delete a message', access: ['messages', 'delete'] }, change(true));
}

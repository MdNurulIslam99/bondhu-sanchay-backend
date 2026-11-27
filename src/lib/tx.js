import mongoose from 'mongoose';
import { AuditLog, Lock } from '../models/index.js';

/** Run a change and its audit entry atomically. Mongo retries the callback on write conflicts. */
export async function transaction(work) {
  return mongoose.connection.transaction(work);
}

/** Take a named lock for the current transaction, so concurrent changes run one after another. */
export async function lock(key, session) {
  await Lock.updateOne({ key }, { $inc: { revision: 1 } }, { upsert: true, session });
}

/** `actor` is `{ user, ip }`, taken from the request. */
export async function audit(actor, action, entity, entityId, { before = null, after = null, session } = {}) {
  await AuditLog.create([{
    userId: actor.user?._id,
    userName: actor.user?.name || actor.name || 'system',
    action, entity, entityId: entityId ? String(entityId) : undefined, before, after, ip: actor.ip,
  }], { session });
}

export const actorOf = req => ({ user: req.user, ip: req.ip });

/** Plain API representation of a stored document. */
export function view(doc, omit = []) {
  const { _id, __v, nameKey, passwordHash, ...rest } = doc.toObject ? doc.toObject() : doc;
  const result = { id: String(_id) };
  for (const [key, value] of Object.entries(rest)) {
    if (!omit.includes(key)) result[key] = value?.constructor?.name === 'ObjectId' ? String(value) : value;
  }
  return result;
}

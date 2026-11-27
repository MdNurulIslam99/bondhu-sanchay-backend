import { z } from 'zod';
import { env } from '../config/env.js';
import { currentMonth } from '../domain/calculations.js';
import { invalid } from '../lib/errors.js';
import { send } from '../lib/respond.js';
import { month, optionalPhone, optionalText, positiveTaka, taka, text } from '../lib/schemas.js';
import { actorOf, audit, transaction, view } from '../lib/tx.js';
import { Setting } from '../models/index.js';

const defaults = {
  orgName: 'Bondhu Sanchay Parishad',
  tagline: 'Save together, grow together',
  about: 'A community-based savings and joint investment platform.',
  phone: '',
  monthlyAmount: 500,
  dueDay: 10,
  fine: 20,
  collectionStart: '2025-06',
  lastCollectionMonth: null, // null means "the current month in Dhaka"
  profitThroughMonth: null,
  publicShowMoney: true,
};

/** Stored settings over the defaults, with the effective collection and profit months filled in. */
export async function getSettings(session) {
  const row = await Setting.findOne({ key: 'organization' }).session(session || null).lean();
  const stored = Object.fromEntries(Object.entries(row || {}).filter(([key, value]) => key in defaults && value !== null && value !== undefined));
  const settings = { ...defaults, ...stored, contentUpdatedAt: row?.contentUpdatedAt || null };
  settings.lastCollectionMonth ||= currentMonth();
  settings.profitThroughMonth ||= settings.lastCollectionMonth;
  return settings;
}

export const publicSettings = settings => Object.fromEntries(
  ['orgName', 'tagline', 'about', 'phone', 'monthlyAmount', 'dueDay', 'collectionStart', 'publicShowMoney'].map(key => [key, settings[key]]));

/** Record that website content changed, and ask the website to refresh if a webhook is configured. */
export async function contentChanged() {
  await Setting.updateOne({ key: 'organization' }, { $set: { contentUpdatedAt: new Date() } }, { upsert: true });
  if (!env.revalidateUrl) return;
  fetch(env.revalidateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-revalidate-secret': env.revalidateSecret },
    body: JSON.stringify({ secret: env.revalidateSecret }),
    signal: AbortSignal.timeout(5000),
  }).catch(error => console.error('Website revalidation failed:', error.message));
}

const settingsBody = z.strictObject({
  orgName: text(100),
  tagline: optionalText(150),
  about: optionalText(500),
  phone: z.union([optionalPhone, z.literal('')]),
  monthlyAmount: positiveTaka,
  dueDay: z.number().int().min(1).max(28),
  fine: taka,
  collectionStart: month,
  lastCollectionMonth: z.union([month, z.null()]),
  profitThroughMonth: z.union([month, z.null()]),
  publicShowMoney: z.boolean(),
  contentUpdatedAt: z.any(), // read-only: accepted so the panel can send back what it read
}).partial();

async function save(req, { contentUpdatedAt, ...patch }, action) {
  const before = await getSettings();
  const next = { ...before, ...patch };
  if (next.lastCollectionMonth && next.lastCollectionMonth < next.collectionStart) {
    throw invalid({ lastCollectionMonth: 'Cannot be earlier than the first collection month' });
  }
  await transaction(async session => {
    const row = await Setting.findOneAndUpdate({ key: 'organization' }, { $set: patch }, { upsert: true, returnDocument: 'after', session });
    await audit(actorOf(req), action, 'settings', row._id, { before, after: view(row), session });
  });
  await contentChanged();
  return getSettings();
}

export default function settingsRoutes(api) {
  const tag = 'Settings';
  for (const path of ['/settings', '/admin/settings']) {
    api.get(path, { tag, summary: 'Read settings', access: ['settings', 'view'] }, async (req, res) => send(res, await getSettings()));
    api.put(path, { tag, summary: 'Update settings', access: ['settings', 'update'], body: settingsBody }, async (req, res) =>
      send(res, await save(req, req.input.body, 'Changed settings'), { message: 'Settings saved' }));
  }
  api.put('/admin/settings/profit-sheet-through', { tag, summary: 'Close the profit sheet up to a month', access: ['settings', 'update'], body: z.strictObject({ month }) },
    async (req, res) => send(res, await save(req, { profitThroughMonth: req.input.body.month }, 'Closed profit sheet'), { message: 'Profit sheet closed' }));
}

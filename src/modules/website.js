// Website content managed in the admin panel: projects, pages, sections, FAQs, notices and images.
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { cleanHtml } from '../lib/html.js';
import { allows } from '../lib/permissions.js';
import { contains, send, sendList, sendRows } from '../lib/respond.js';
import { activeStatus, date, listQuery, objectId, optionalPhone, optionalText, text, yesNo } from '../lib/schemas.js';
import { actorOf, audit, lock, transaction, view } from '../lib/tx.js';
import { BUSINESS_TYPES, Faq, Notice, PageName, PageSection, Project, Upload } from '../models/index.js';
import { accountRefs, resolveAccount } from './investments.js';
import { loadLedger } from './ledger.js';
import { contentChanged } from './settings.js';

export const slugify = value => value.toLowerCase().normalize('NFKD').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const slug = z.string().trim().toLowerCase().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens');
const filesPrefix = `${env.publicApiUrl}/api/v1/files/`;
const imageUrl = z.string().max(2000).refine(value => value.startsWith(filesPrefix) || (URL.canParse(value) && new URL(value).protocol === 'https:'), 'Upload the image or use an https address');
const images = z.array(imageUrl).max(5, 'Up to 5 images');

/** A readable, unique slug. Names without Latin letters get a random one. */
async function freeSlug(model, name, fallback, session) {
  const base = slugify(name) || `${fallback}-${crypto.randomBytes(3).toString('hex')}`;
  let candidate = base;
  for (let n = 2; await model.exists({ slug: candidate }).session(session); n++) candidate = `${base}-${n}`;
  return candidate;
}
async function assertUnique(model, row, field, message, session) {
  if (await model.exists({ _id: { $ne: row._id }, [field]: row[field] }).session(session)) {
    throw conflict(message, 'DUPLICATE_RECORD', { [field === 'nameKey' ? 'name' : field]: message });
  }
}

/** Create, update and delete with an audit entry in one transaction, then refresh the website. */
async function write(req, { model, module, id, prepare, remove }) {
  const result = await transaction(async session => {
    await lock('content', session);
    const row = id ? await model.findById(id).session(session) : new model();
    if (!row) throw notFound();
    const before = id ? view(row) : null;
    if (remove) {
      await remove(row, session, actorOf(req));
      await row.deleteOne({ session });
    } else {
      await prepare(row, session);
      await row.save({ session });
    }
    await audit(actorOf(req), remove ? 'Deleted' : id ? 'Updated' : 'Created', module, row._id, { before, after: remove ? null : view(row), session });
    return row.toObject();
  });
  await contentChanged();
  return result;
}

/** Standard routes for one content type, under both the panel path and the /admin path. */
function content(api, { module, tag, model, query, list, map = rows => rows.map(row => view(row)), createBody, updateBody, prepare, remove }) {
  for (const base of [`/${module}`, `/admin/${module}`]) {
    api.get(base, { tag, summary: `List ${tag.toLowerCase()}`, access: [module, 'view'], query }, list);
    api.get(`${base}/:id`, { tag, summary: 'Read one', access: [module, 'view'] }, async (req, res) => {
      const row = await model.findById(req.input.params.id).lean();
      if (!row) throw notFound();
      send(res, (await map([row]))[0]);
    });
    api.post(base, { tag, summary: 'Create', access: [module, 'create'], body: createBody }, async (req, res) => {
      const row = await write(req, { model, module, prepare: (doc, session) => prepare(doc, req.input.body, session, true) });
      send(res, (await map([row]))[0], { status: 201, message: 'Created' });
    });
    const update = async (req, res) => {
      const row = await write(req, { model, module, id: req.input.params.id, prepare: (doc, session) => prepare(doc, req.input.body, session, false) });
      send(res, (await map([row]))[0], { message: 'Saved' });
    };
    api.put(`${base}/:id`, { tag, summary: 'Update', access: [module, 'update'], body: updateBody }, update);
    api.patch(`${base}/:id`, { tag, summary: 'Update', access: [module, 'update'], body: updateBody }, update);
    api.delete(`${base}/:id`, { tag, summary: 'Delete', access: [module, 'delete'] }, async (req, res) => {
      await write(req, { model, module, id: req.input.params.id, remove: remove || (async () => {}) });
      send(res, null, { message: 'Deleted' });
    });
  }
}
const bodies = (shape, required) => {
  const all = z.strictObject(shape).partial();
  return { createBody: all.required(Object.fromEntries(required.map(key => [key, true]))), updateBody: all };
};

// ---------- Projects ----------
function projectRoutes(api) {
  const STATUS = z.enum(['running', 'completed', 'planned']);
  const decorate = async rows => {
    const ledger = await loadLedger();
    return rows.map(row => {
      const account = ledger.accounts.find(item => item.id === String(row.accountId));
      return { ...view(row), accountName: account?.name ?? '', account: account?.name ?? '', invested: account?.invested ?? 0,
        monthlyProfit: account?.monthlyProfit ?? 0, profitCollected: account?.collected ?? 0 };
    });
  };
  const query = listQuery({ sort: ['startDate', 'name', 'status', 'sortOrder', 'createdAt'],
    filters: { status: STATUS.optional(), businessType: z.enum(BUSINESS_TYPES).optional(), showOnWebsite: yesNo.optional(), accountId: objectId.optional() } });
  content(api, {
    module: 'projects', tag: 'Projects', model: Project, query, map: decorate,
    list: async (req, res) => {
      const { status, businessType, showOnWebsite, accountId, search } = req.input.query;
      const filter = Object.fromEntries(Object.entries({ status, businessType, showOnWebsite, accountId }).filter(([, value]) => value));
      if (search) filter.$or = ['name', 'location', 'contactPerson', 'summary', 'businessType'].map(key => ({ [key]: contains(search) }));
      await sendList(res, { model: Project, filter, query: req.input.query, map: decorate, name: 'projects',
        columns: ['id', 'name', 'slug', 'account', 'businessType', 'status', 'startDate', 'location', 'contactPerson', 'contactMobile', 'showOnWebsite', 'invested', 'profitCollected'] });
    },
    ...bodies({
      ...accountRefs, name: text(120), slug: z.union([z.literal(''), slug]), businessType: z.enum(BUSINESS_TYPES), status: STATUS, startDate: date,
      location: optionalText(300), contactPerson: optionalText(120), contactMobile: optionalPhone, showOnWebsite: yesNo, summary: optionalText(200),
      description: z.string().max(50000), images, facts: z.array(z.tuple([text(80), text(300)])).max(20), imageAlt: optionalText(300),
      imageIsStock: z.boolean(), placeholder: z.boolean(), sortOrder: z.number().int().min(0).max(100000),
    }, ['name', 'businessType', 'startDate']),
    prepare: async (row, input, session, creating) => {
      const { accountId, account, accountName, slug: wanted, ...patch } = input;
      if (creating || accountId || account || accountName) row.accountId = (await resolveAccount({ accountId, account, accountName }, session))._id;
      if (patch.description !== undefined) patch.description = cleanHtml(patch.description);
      row.set(patch);
      row.nameKey = row.name.toLowerCase();
      await assertUnique(Project, row, 'nameKey', 'A project with this name already exists', session);
      // The address stays stable when a project is renamed, so shared links keep working.
      if (wanted) row.slug = wanted;
      else if (creating) row.slug = await freeSlug(Project, row.name, 'project', session);
      await assertUnique(Project, row, 'slug', 'This slug is already in use', session);
    },
  });
}

// ---------- Pages and sections ----------
function pageRoutes(api) {
  const decorate = async rows => {
    const counts = await PageSection.aggregate([{ $group: { _id: '$pageId', count: { $sum: 1 } } }]);
    return rows.map(row => ({ ...view(row), sectionCount: counts.find(item => String(item._id) === String(row._id))?.count ?? 0 }));
  };
  const query = listQuery({ sort: ['order', 'name', 'status', 'createdAt'], defaultOrder: 'asc', filters: { status: activeStatus.optional() } });
  content(api, {
    module: 'page-names', tag: 'Page names', model: PageName, query, map: decorate,
    list: async (req, res) => {
      const { status, search } = req.input.query;
      const filter = { ...(status ? { status } : {}), ...(search ? { $or: [{ name: contains(search) }, { slug: contains(search) }] } : {}) };
      await sendList(res, { model: PageName, filter, query: req.input.query, map: decorate, name: 'page-names', columns: ['id', 'name', 'slug', 'status', 'sectionCount'] });
    },
    ...bodies({ name: text(120), slug: z.union([z.literal(''), slug]), status: activeStatus, order: z.number().int().min(0).max(100000) }, ['name']),
    prepare: async (row, input, session, creating) => {
      const { slug: wanted, ...patch } = input;
      row.set(patch);
      row.nameKey = row.name.toLowerCase();
      await assertUnique(PageName, row, 'nameKey', 'A page with this name already exists', session);
      if (wanted) row.slug = wanted;
      else if (creating) row.slug = await freeSlug(PageName, row.name, 'page', session);
      await assertUnique(PageName, row, 'slug', 'This slug is already in use', session);
      if (creating && patch.order === undefined) row.order = ((await PageName.findOne().sort({ order: -1 }).session(session).lean())?.order ?? 0) + 1;
    },
    // A page's sections cannot exist without it.
    remove: async (row, session, actor) => {
      const sections = await PageSection.find({ pageId: row._id }).session(session);
      for (const section of sections) await audit(actor, 'Deleted with page', 'page-sections', section._id, { before: view(section), session });
      await PageSection.deleteMany({ pageId: row._id }, { session });
    },
  });
}

const SECTION = /^Section ([1-9]|1\d|20)$/;
export const sectionSort = pages => {
  const rank = Object.fromEntries(pages.map((page, index) => [String(page._id), index]));
  return (a, b) => (rank[String(a.pageId)] ?? 999) - (rank[String(b.pageId)] ?? 999) || a.sectionNumber - b.sectionNumber || a.position - b.position;
};
export const orderedPages = filter => PageName.find(filter).sort({ order: 1, _id: 1 }).lean();

function sectionRoutes(api) {
  const decorate = async rows => {
    const pages = await orderedPages({});
    return rows.map(row => {
      const index = pages.findIndex(page => String(page._id) === String(row.pageId));
      return { ...view(row, ['sectionNumber']), pageName: pages[index]?.name ?? '', displayOrder: (index + 1) * 10_000_000 + row.sectionNumber * 100_000 + row.position };
    });
  };
  for (const base of ['/page-sections', '/admin/page-sections']) {
    // Registered before "/:id" so the word is not read as an id.
    api.get(`${base}/next-position`, { tag: 'Page sections', summary: 'Next free position in a section', access: ['page-sections', 'view'],
      query: z.strictObject({ pageId: objectId, sectionHeader: z.string().regex(SECTION), ignoreId: objectId.optional() }) }, async (req, res) => {
      const { pageId, sectionHeader, ignoreId } = req.input.query;
      const last = await PageSection.findOne({ pageId, sectionHeader, ...(ignoreId ? { _id: { $ne: ignoreId } } : {}) }).sort({ position: -1 }).lean();
      send(res, { position: (last?.position ?? 0) + 1 });
    });
  }
  const query = listQuery({ sort: ['displayOrder', 'title', 'position', 'status', 'createdAt'], defaultOrder: 'asc', filters: { pageId: objectId.optional(), status: activeStatus.optional() } });
  content(api, {
    module: 'page-sections', tag: 'Page sections', model: PageSection, query, map: decorate,
    list: async (req, res) => {
      const { pageId, status, search } = req.input.query;
      const filter = { ...(pageId ? { pageId } : {}), ...(status ? { status } : {}) };
      if (search) filter.$or = ['title', 'subTitle', 'sectionHeader', 'description'].map(key => ({ [key]: contains(search) }));
      sendRows(res, { rows: await decorate(await PageSection.find(filter).lean()), query: req.input.query, name: 'page-sections',
        columns: ['id', 'pageName', 'sectionHeader', 'position', 'title', 'subTitle', 'description', 'images', 'status'] });
    },
    ...bodies({
      pageId: objectId, sectionHeader: z.string().regex(SECTION, 'Choose Section 1 to Section 20'), position: z.number().int().min(1).max(10000),
      title: text(300), subTitle: optionalText(300), description: z.string().max(50000), images, status: activeStatus,
    }, ['pageId', 'sectionHeader', 'title']),
    prepare: async (row, input, session, creating) => {
      const patch = { ...input };
      if (patch.pageId && !await PageName.exists({ _id: patch.pageId }).session(session)) throw invalid({ pageId: 'Page not found' });
      if (patch.description !== undefined) patch.description = cleanHtml(patch.description);
      if (patch.sectionHeader) patch.sectionNumber = Number(patch.sectionHeader.match(SECTION)[1]);
      row.set(patch);
      if (creating && patch.position === undefined) {
        const last = await PageSection.findOne({ pageId: row.pageId, sectionHeader: row.sectionHeader }).sort({ position: -1 }).session(session).lean();
        row.position = (last?.position ?? 0) + 1;
      }
    },
  });
}

// ---------- FAQs and notices ----------
function faqAndNoticeRoutes(api) {
  const faqQuery = listQuery({ sort: ['order', 'question', 'createdAt'], defaultOrder: 'asc', filters: { published: yesNo.optional() } });
  content(api, {
    module: 'faqs', tag: 'FAQs', model: Faq, query: faqQuery,
    list: async (req, res) => {
      const { published, search } = req.input.query;
      const filter = { ...(published ? { published } : {}), ...(search ? { $or: [{ question: contains(search) }, { answer: contains(search) }] } : {}) };
      await sendList(res, { model: Faq, filter, query: req.input.query, map: rows => rows.map(row => view(row)), name: 'faqs', columns: ['id', 'question', 'answer', 'published'] });
    },
    ...bodies({ question: text(500), answer: text(10000), published: yesNo, order: z.number().int().min(0).max(100000) }, ['question', 'answer']),
    prepare: async (row, input, session, creating) => {
      row.set(input);
      if (creating && input.order === undefined) row.order = ((await Faq.findOne().sort({ order: -1 }).session(session).lean())?.order ?? 0) + 1;
    },
  });
  const noticeQuery = listQuery({ sort: ['date', 'title', 'published', 'createdAt'], filters: { published: yesNo.optional() } });
  content(api, {
    module: 'notices', tag: 'Notices', model: Notice, query: noticeQuery,
    list: async (req, res) => {
      const { published, search } = req.input.query;
      const filter = { ...(published ? { published } : {}), ...(search ? { $or: [{ title: contains(search) }, { body: contains(search) }] } : {}) };
      await sendList(res, { model: Notice, filter, query: req.input.query, map: rows => rows.map(row => view(row)), name: 'notices', columns: ['id', 'title', 'body', 'date', 'published'] });
    },
    ...bodies({ title: text(300), body: text(10000), date, published: yesNo }, ['title', 'body', 'date']),
    prepare: async (row, input) => { row.set(input); },
  });
}

// ---------- Images ----------
const MAX_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } }).single('file');

/** The real file type is read from the content; the name and declared type are not trusted. */
export function imageType(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function uploadRoutes(api) {
  const tag = 'Uploads';
  const canUpload = (req, res, next) => {
    if (!['projects', 'page-sections'].some(module => allows(req.permissions, module, 'create') || allows(req.permissions, module, 'update'))) throw forbidden();
    next();
  };
  for (const path of ['/uploads', '/admin/uploads']) {
    api.post(path, { tag, summary: 'Upload one image (multipart field "file", max 5 MB)', access: 'staff', before: [canUpload, upload], upload: true }, async (req, res) => {
      if (!req.file) throw invalid({ file: 'Choose an image' });
      const type = imageType(req.file.buffer);
      if (!type) throw invalid({ file: 'Use a JPG, PNG or WEBP image' });
      const name = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
      const row = await Upload.create({ name, mime: type.mime, size: req.file.size, data: req.file.buffer, uploadedBy: req.user._id });
      await audit(actorOf(req), 'Uploaded', 'uploads', row._id, { after: { name, size: row.size } });
      send(res, { id: String(row._id), url: `${filesPrefix}${name}`, mime: type.mime, size: row.size }, { status: 201, message: 'Image uploaded' });
    });
  }
  api.get('/files/:name', { tag, summary: 'Public image file', params: z.strictObject({ name: z.string().regex(/^[a-f0-9]{32}\.(jpg|png|webp)$/) }) }, async (req, res) => {
    const file = await Upload.findOne({ name: req.input.params.name });
    if (!file) throw notFound('Image not found');
    res.set({ 'Content-Type': file.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.send(file.data);
  });
}

export default function websiteRoutes(api) {
  projectRoutes(api);
  pageRoutes(api);
  sectionRoutes(api);
  faqAndNoticeRoutes(api);
  uploadRoutes(api);
}

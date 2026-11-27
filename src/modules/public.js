// Everything the public website may read without logging in. Only the fields listed here ever leave.
import { z } from 'zod';
import { initials, maskPhone } from '../domain/calculations.js';
import { notFound } from '../lib/errors.js';
import { cleanHtml } from '../lib/html.js';
import { send } from '../lib/respond.js';
import { optionalText, phone, text } from '../lib/schemas.js';
import { limiter } from '../lib/security.js';
import { audit, transaction, view } from '../lib/tx.js';
import { Faq, Member, Notice, PageSection } from '../models/index.js';
import { loadLedger } from './ledger.js';
import { nextSerial } from './members.js';
import { getSettings, publicSettings } from './settings.js';
import { orderedPages, sectionSort } from './website.js';

const section = row => ({ sectionHeader: row.sectionHeader, position: row.position, title: row.title, subTitle: row.subTitle || '',
  description: cleanHtml(row.description), images: row.images || [] });

/** Active pages with their active sections, in page, section and position order. */
async function publicPages(filter = {}) {
  const pages = await orderedPages({ ...filter, status: 'active' });
  const sections = await PageSection.find({ pageId: { $in: pages.map(page => page._id) }, status: 'active' }).lean();
  sections.sort(sectionSort(pages));
  return pages.map(page => ({ name: page.name, slug: page.slug,
    sections: sections.filter(row => String(row.pageId) === String(page._id)).map(section) }));
}
const publicFaqs = async () => (await Faq.find({ published: 'yes' }).sort({ order: 1, _id: 1 }).lean()).map(row => ({ question: row.question, answer: row.answer }));
const publicNotices = async () => (await Notice.find({ published: 'yes' }).sort({ date: -1, _id: -1 }).lean()).map(row => ({ title: row.title, body: row.body, date: row.date }));

/**
 * Published projects. Money figures and the investor's name are included only while the
 * "publicShowMoney" setting is on. Contact details are never public.
 */
function publicProjects(ledger) {
  return ledger.projects.filter(row => row.showOnWebsite === 'yes').map(row => {
    const account = ledger.accounts.find(item => item.id === String(row.accountId));
    const first = account?.entries.filter(entry => entry.status !== 'planned').map(entry => entry.investDate).sort()[0];
    return {
      id: row.slug, slug: row.slug, name: row.name, businessType: row.businessType, category: row.businessType, status: row.status,
      startDate: row.startDate, location: row.location, summary: row.summary, description: cleanHtml(row.description),
      images: row.images, image: row.images[0] || '', imageAlt: row.imageAlt || row.name, imageIsStock: row.imageIsStock,
      placeholder: row.placeholder, facts: row.facts, sortOrder: row.sortOrder,
      ...(ledger.settings.publicShowMoney ? {
        partner: account?.name ?? '', amount: account?.invested ?? 0, monthlyProfit: account?.monthlyProfit ?? 0,
        profit: account?.collected ?? 0, investedSince: first || row.startDate,
      } : {}),
    };
  });
}

function summary(ledger) {
  const active = ledger.members.filter(member => member.status === 'active');
  return {
    members: active.length,
    initials: active.slice(0, 4).map(member => initials(member.name)),
    ...(ledger.settings.publicShowMoney
      ? { collected: ledger.totals.collected, invested: ledger.totals.invested, profit: ledger.totals.profit } : {}),
  };
}

export default function publicRoutes(api) {
  const tag = 'Public website';
  // Browsers may keep a copy but must check it is current (Express adds the ETag).
  const publish = (res, data, updatedAt) => {
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    if (updatedAt) res.set('Last-Modified', new Date(updatedAt).toUTCString());
    send(res, data);
  };
  const get = (path, text_, read) => api.get(path, { tag, summary: text_ }, async (req, res) => {
    // Read side by side, so the visitor does not wait for one database round trip after another.
    const [settings, data] = await Promise.all([getSettings(), read(req)]);
    publish(res, data, settings.contentUpdatedAt);
  });

  get('/public/site-content', 'Settings, pages, FAQs, notices and projects in one response', async () => {
    const [pages, faqs, notices, ledger] = await Promise.all([publicPages(), publicFaqs(), publicNotices(), loadLedger()]);
    const { settings } = ledger;
    return { updatedAt: settings.contentUpdatedAt, settings: publicSettings(settings), summary: summary(ledger), pages, faqs, notices, projects: publicProjects(ledger) };
  });
  get('/public/settings', 'Organization details', async () => publicSettings(await getSettings()));
  get('/public/summary', 'Member count and fund totals', async () => summary(await loadLedger()));
  get('/public/faqs', 'Published FAQs', publicFaqs);
  get('/public/notices', 'Published notices, newest first', publicNotices);
  get('/public/members', 'Active members with masked numbers', async () => (await Member.find({ status: 'active' }).sort({ sl: 1 }).lean())
    .map(member => ({ id: String(member._id), sl: member.sl, name: member.name, initials: initials(member.name), phoneMasked: maskPhone(member.phone), phone_masked: maskPhone(member.phone) })));
  api.get('/public/pages', { tag, summary: 'All active pages' }, async (req, res) => publish(res, await publicPages()));
  api.get('/public/pages/:slug', { tag, summary: 'One active page with its sections' }, async (req, res) => {
    const [page] = await publicPages({ slug: String(req.params.slug) });
    if (!page) throw notFound('Page not found');
    publish(res, page);
  });
  for (const base of ['/public/projects', '/public/investments']) {
    get(base, 'Published projects', async () => publicProjects(await loadLedger()));
    api.get(`${base}/:slug`, { tag, summary: 'One published project' }, async (req, res) => {
      const ledger = await loadLedger();
      const wanted = String(req.params.slug);
      const row = ledger.projects.find(item => item.slug === wanted || String(item._id) === wanted);
      const project = row && publicProjects(ledger).find(item => item.slug === row.slug);
      if (!project) throw notFound('Project not found');
      publish(res, { ...project, ...(ledger.settings.publicShowMoney
        ? { tranches: (ledger.accounts.find(item => item.id === String(row.accountId))?.entries || []).filter(entry => entry.status !== 'planned')
          .map(entry => ({ date: entry.investDate, amount: entry.amount, monthlyProfit: entry.monthlyProfit, firstMonth: entry.firstProfitMonth })) } : {}) });
    });
  }

  api.post('/public/member-applications', {
    tag, summary: 'Apply to become a member (creates a pending member)', limit: limiter(5),
    // `website` is a honeypot: real visitors never see or fill it.
    body: z.strictObject({ name: text(80).min(2), phone, nid: z.union([z.literal(''), z.string().regex(/^\d{10,17}$/, 'NID must be 10–17 digits')]).optional(),
      address: optionalText(1000).optional(), nominee: optionalText(200).optional(), website: z.string().max(200).optional(), captchaToken: z.string().max(4000).optional() }),
  }, async (req, res) => {
    const { website, captchaToken, ...input } = req.input.body;
    if (!website) {
      const settings = await getSettings();
      await transaction(async session => {
        const sl = await nextSerial(session);
        // An existing number gets the same reply, so this form cannot be used to look members up.
        if (await Member.exists({ phone: input.phone }).session(session)) return;
        const [row] = await Member.create([{ ...input, sl, monthly: settings.monthlyAmount, status: 'pending' }], { session });
        await audit({ name: 'website visitor', ip: req.ip }, 'Applied for membership', 'members', row._id, { after: view(row), session });
      });
    }
    send(res, null, { status: 202, message: 'Your application has been received.' });
  });
}

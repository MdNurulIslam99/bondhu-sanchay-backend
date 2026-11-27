// Imports members, deposits, investments, projects, pages and FAQs from the admin panel's data files.
// Existing records are left as they are, so edits made in the admin panel are never overwritten.
//   npm run db:import -- --dry-run
//   npm run db:import -- ../../bondhu-sanchay-admin-uat/src/data
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { cleanHtml } from '../src/lib/html.js';
import { audit } from '../src/lib/tx.js';
import { Faq, InvestmentAccount, InvestmentEntry, Member, PageName, PageSection, Payment, Profit, Project, Setting } from '../src/models/index.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const folder = path.resolve(args.find(value => !value.startsWith('--')) || '../../bondhu-sanchay-admin-uat/src/data');
const base = `${pathToFileURL(folder).href}/`;

// The frontend files are ES modules without file extensions in their imports.
registerHooks({
  resolve: (specifier, context, next) => context.parentURL?.startsWith(base) && specifier.startsWith('.') && !path.extname(specifier)
    ? next(`${specifier}.js`, context) : next(specifier, context),
  load: (url, context, next) => next(url, url.startsWith(base) ? { ...context, format: 'module' } : context),
});
const load = file => import(new URL(file, base).href);

const added = {};
async function addMissing(label, model, filter, document) {
  const found = await model.findOne(filter);
  if (found) return found;
  added[label] = (added[label] || 0) + 1;
  return model.create(document);
}

try {
  const collection = await load('collection.js');
  const investments = await load('investment-sheet.js');
  const { PROJECTS } = await load('projects.js');
  const website = await load('website/index.js');
  const { MEMBERS, COLLECTION_SHEETS, MONTHLY_AMOUNT } = collection;
  const deposits = MEMBERS.flatMap(member => COLLECTION_SHEETS.flatMap(sheet => sheet.months
    .map((month, index) => ({ sl: member.sl, month, cell: member.collections[sheet.year][index] }))
    .filter(row => row.cell !== null)));
  console.log(`Source: ${folder}`);
  console.log({ members: MEMBERS.length, deposits: deposits.length, investments: investments.INVESTMENTS.length, profitRecords: investments.PROFIT_RECORDS.length,
    projects: PROJECTS.length, pages: website.websitePageNames.length, sections: website.websiteSections.length, faqs: website.websiteFaqs.length });

  if (!dryRun) {
    await connectDB();
    const settings = {
      orgName: 'Bondhu Sanchay Parishad', about: 'A community-based savings and joint investment platform.', monthlyAmount: MONTHLY_AMOUNT, dueDay: 10, fine: 20,
      collectionStart: COLLECTION_SHEETS[0].months[0], lastCollectionMonth: collection.LAST_COLLECTION_MONTH, profitThroughMonth: investments.PROFIT_THROUGH_MONTH, publicShowMoney: true,
    };
    const current = await Setting.findOne({ key: 'organization' }).lean();
    const missing = Object.fromEntries(Object.entries(settings).filter(([key]) => current?.[key] === undefined || current[key] === null));
    await Setting.updateOne({ key: 'organization' }, { $set: { ...missing, contentUpdatedAt: new Date() } }, { upsert: true });

    const members = new Map();
    for (const member of MEMBERS) {
      members.set(member.sl, await addMissing('members', Member, { sl: member.sl },
        { sl: member.sl, name: member.name, phone: member.mobile, monthly: MONTHLY_AMOUNT, status: 'active' }));
    }
    const existing = new Set((await Payment.find({}, 'memberId month').lean()).map(row => `${row.memberId}:${row.month}`));
    const newDeposits = deposits.map(({ sl, month, cell }) => ({
      memberId: members.get(sl)._id, month, amount: MONTHLY_AMOUNT, status: 'verified',
      paidDate: typeof cell === 'number' ? `${month}-${String(cell).padStart(2, '0')}` : cell,
    })).filter(row => !existing.has(`${row.memberId}:${row.month}`));
    if (newDeposits.length) await Payment.insertMany(newDeposits);
    added.deposits = newDeposits.length;

    const accounts = new Map();
    const account = async name => {
      if (!accounts.has(name)) accounts.set(name, await addMissing('accounts', InvestmentAccount, { nameKey: name.toLowerCase() }, { name, nameKey: name.toLowerCase() }));
      return accounts.get(name)._id;
    };
    for (const { id, name, ...entry } of investments.INVESTMENTS) {
      const accountId = await account(name);
      await addMissing('investments', InvestmentEntry, { accountId, investDate: entry.investDate, amount: entry.amount }, { ...entry, accountId });
    }
    for (const { id, account: name, ...record } of investments.PROFIT_RECORDS) {
      const accountId = await account(name);
      await addMissing('profitRecords', Profit, { accountId, month: record.month }, { ...record, accountId });
    }
    for (const [index, { id, account: name, description, ...project }] of PROJECTS.entries()) {
      const nameKey = project.name.toLowerCase();
      await addMissing('projects', Project, { $or: [{ nameKey }, { slug: id }] },
        { ...project, nameKey, slug: id, accountId: await account(name), description: cleanHtml(description), sortOrder: index + 1 });
    }
    const pages = new Map();
    for (const [index, page] of website.websitePageNames.entries()) {
      const nameKey = page.name.toLowerCase();
      pages.set(page.id, await addMissing('pages', PageName, { $or: [{ nameKey }, { slug: page.id }] },
        { name: page.name, nameKey, slug: page.id, status: page.status, order: index + 1 }));
    }
    for (const { id, pageId, description, ...section } of website.websiteSections) {
      const owner = pages.get(pageId)._id;
      await addMissing('sections', PageSection, { pageId: owner, sectionHeader: section.sectionHeader, position: section.position },
        { ...section, pageId: owner, sectionNumber: Number(section.sectionHeader.replace(/\D/g, '')), description: cleanHtml(description) });
    }
    for (const [index, faq] of website.websiteFaqs.entries()) {
      await addMissing('faqs', Faq, { question: faq.question }, { question: faq.question, answer: faq.answer, order: index + 1, published: 'yes' });
    }
    await audit({ name: 'import script' }, 'Imported data', 'import', undefined, { after: added });
    console.log('Added:', added);
  } else console.log('Dry run: nothing was written.');
} catch (error) {
  console.error('Import failed:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

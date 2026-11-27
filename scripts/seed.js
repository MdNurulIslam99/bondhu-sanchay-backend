// Default settings and role actions. `--users` also creates one staff account per role with a
// random password that must be changed at the first login.
//   npm run db:seed
//   npm run db:seed -- --users
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { DEFAULT_PAGES, DEFAULT_ROLE_ACTIONS } from '../src/lib/permissions.js';
import { hashPassword } from '../src/lib/security.js';
import { RoleAction, Setting, User, UserPermission } from '../src/models/index.js';

const USERS = [['Super Admin', 'super', 'super_admin'], ['Director', 'admin', 'admin'], ['Accountant', 'accountant', 'accountant'], ['Viewer', 'viewer', 'viewer']];

try {
  await connectDB();
  await Setting.updateOne({ key: 'organization' }, { $setOnInsert: {
    orgName: 'Bondhu Sanchay Parishad', about: 'A community-based savings and joint investment platform.',
    monthlyAmount: 500, dueDay: 10, fine: 20, collectionStart: '2025-06', publicShowMoney: true,
  } }, { upsert: true });
  for (const [role, modules] of Object.entries(DEFAULT_ROLE_ACTIONS)) {
    await RoleAction.updateOne({ role }, { $setOnInsert: { modules } }, { upsert: true });
  }
  console.log('Default settings and role actions are in place.');
  if (process.argv.includes('--users')) {
    const domain = process.env.SEED_EMAIL_DOMAIN || 'bondhu.test';
    for (const [name, local, role] of USERS) {
      const email = `${local}@${domain}`;
      if (await User.exists({ email })) { console.log(`${email}: already exists, unchanged`); continue; }
      const password = `${crypto.randomBytes(9).toString('base64url')}a1`;
      const user = await User.create({ name, email, role, status: 'active', passwordHash: await hashPassword(password), mustChangePassword: true });
      if (DEFAULT_PAGES[role]) await UserPermission.create({ userId: user._id, status: 'active', pages: DEFAULT_PAGES[role] });
      console.log(`${email}  temporary password: ${password}`);
    }
    console.log('Copy the temporary passwords now; they are not shown again.');
  }
} catch (error) {
  console.error('Seed failed:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

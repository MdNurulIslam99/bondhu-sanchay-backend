import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId, Mixed } = Schema.Types;

// Indexes are created by `npm run db:migrate`, never silently at startup.
function define(name, collection, fields, indexes = [], options = {}) {
  const schema = new Schema(fields, { timestamps: true, autoIndex: false, autoCreate: false, bufferCommands: false, ...options });
  for (const [keys, indexOptions] of indexes) schema.index(keys, indexOptions);
  return mongoose.model(name, schema, collection);
}

const required = type => ({ type, required: true });
const choice = (values, fallback) => ({ type: String, enum: values, ...(fallback === undefined ? { required: true } : { default: fallback }) });
const money = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const unique = { unique: true };
const uniqueText = field => ({ unique: true, partialFilterExpression: { [field]: { $gt: '' } } });
const expiring = { expireAfterSeconds: 0 };

export const STAFF_ROLES = ['super_admin', 'admin', 'accountant', 'viewer'];
export const ROLES = [...STAFF_ROLES, 'member'];

// ---------- Accounts and security ----------
export const User = define('User', 'users', {
  name: required(String),
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: String,
  passwordHash: { type: String, select: false },
  role: choice(ROLES),
  status: choice(['active', 'inactive'], 'inactive'),
  mustChangePassword: { type: Boolean, default: false },
  // Website accounts: an admin confirms that the account really belongs to the member with this phone.
  memberId: ObjectId,
  linkStatus: choice(['unverified', 'approved', 'rejected'], 'unverified'),
  avatar: { type: String, default: '' },
  termsAcceptedAt: Date,
  sessionVersion: { type: Number, default: 0 },
}, [[{ email: 1 }, unique], [{ phone: 1 }, uniqueText('phone')]]);

export const UserPermission = define('UserPermission', 'user_permissions', {
  userId: required(ObjectId),
  status: choice(['active', 'inactive'], 'active'),
  pages: [String],
}, [[{ userId: 1 }, unique]]);

export const RoleAction = define('RoleAction', 'role_actions', {
  role: required(String),
  modules: { type: Mixed, default: {} },
}, [[{ role: 1 }, unique]], { minimize: false });

export const Session = define('Session', 'sessions', {
  tokenHash: required(String),
  userId: required(ObjectId),
  version: required(Number),
  lastSeenAt: required(Date),
  expiresAt: required(Date),
}, [[{ tokenHash: 1 }, unique], [{ userId: 1 }], [{ expiresAt: 1 }, expiring]]);

export const LoginAttempt = define('LoginAttempt', 'login_attempts', {
  key: required(String),
  failures: { type: Number, default: 0 },
  lockedUntil: Date,
  expiresAt: required(Date),
}, [[{ key: 1 }, unique], [{ expiresAt: 1 }, expiring]]);

export const PasswordReset = define('PasswordReset', 'password_resets', {
  tokenHash: required(String),
  identifierHash: required(String),
  userId: ObjectId,
  otpHash: required(String),
  expiresAt: required(Date),
  resendAt: required(Date),
  tries: { type: Number, default: 0 },
  verified: { type: Boolean, default: false },
  deleteAt: required(Date),
}, [[{ tokenHash: 1 }, unique], [{ identifierHash: 1 }], [{ deleteAt: 1 }, expiring]]);

// ---------- Members and money ----------
export const Member = define('Member', 'members', {
  sl: required(Number),
  name: required(String),
  phone: { type: String, default: '' },
  nid: String,
  address: String,
  nominee: String,
  joinDate: String,
  monthly: money,
  status: choice(['pending', 'active', 'inactive'], 'pending'),
  inactiveMonth: String,
}, [[{ sl: 1 }, unique], [{ phone: 1 }, uniqueText('phone')], [{ name: 1 }]]);

export const PAYMENT_TYPES = ['bKash', 'Nagad', 'Rocket', 'Bank', 'Cash', 'Other'];

/** Monthly deposits. Only `verified` rows count. */
export const Payment = define('Payment', 'payments', {
  memberId: required(ObjectId),
  month: required(String),
  amount: money,
  paidDate: { type: String, default: '' }, // free text: imported sheets contain values like "10/25"
  method: { type: String, default: '' },
  trxId: { type: String, default: '' },
  trxKey: { type: String, default: '' },
  status: choice(['pending', 'verified', 'reversed'], 'pending'),
  submissionId: ObjectId,
  createdBy: ObjectId,
}, [
  [{ memberId: 1, month: 1 }, { unique: true, partialFilterExpression: { status: 'verified' } }],
  [{ status: 1, month: -1 }],
  [{ trxKey: 1 }],
  [{ submissionId: 1 }],
]);

export const Submission = define('Submission', 'payment_submissions', {
  userId: ObjectId,
  memberId: ObjectId,
  memberName: required(String),
  date: required(String),
  amount: money,
  months: [String],
  category: choice(['savings', 'profit']),
  type: choice(PAYMENT_TYPES),
  trxId: { type: String, default: '' },
  trxKey: { type: String, default: '' },
  payerAccount: { type: String, default: '' },
  description: { type: String, default: '' },
  status: choice(['pending', 'verified', 'rejected'], 'pending'),
  active: { type: Boolean, default: true }, // false once rejected, which frees the transaction ID
  source: choice(['website', 'admin']),
  submittedAt: required(Date),
  reviewedBy: ObjectId,
  reviewedByName: String,
  reviewedAt: Date,
  reviewNote: { type: String, default: '' },
  appliedAccountId: ObjectId, // verified profit booked on an investment account's monthly record
  appliedMonth: String,
}, [
  [{ trxKey: 1 }, { unique: true, partialFilterExpression: { active: true, trxKey: { $gt: '' } } }],
  [{ status: 1, submittedAt: -1 }],
  [{ userId: 1, submittedAt: -1 }],
]);

/** One row per verified website/admin submission: the audit trail of balance changes. */
export const LedgerEntry = define('LedgerEntry', 'ledger_entries', {
  submissionId: required(ObjectId),
  type: choice(['savings', 'profit']),
  amount: money,
  memberId: ObjectId,
  createdBy: required(ObjectId),
  active: { type: Boolean, default: true },
}, [[{ submissionId: 1 }, { unique: true, partialFilterExpression: { active: true } }]]);

export const InvestmentAccount = define('InvestmentAccount', 'investment_accounts', {
  name: required(String),
  nameKey: required(String),
}, [[{ nameKey: 1 }, unique]]);

export const InvestmentEntry = define('InvestmentEntry', 'investment_entries', {
  accountId: required(ObjectId),
  investDate: required(String),
  amount: money,
  monthlyProfit: money,
  firstProfitMonth: required(String),
  status: choice(['running', 'completed', 'planned'], 'running'),
}, [[{ accountId: 1, investDate: 1 }]]);

export const Profit = define('Profit', 'profits', {
  accountId: required(ObjectId),
  month: required(String),
  collected: money,
  cost: money,
  note: { type: String, default: '' },
}, [[{ accountId: 1, month: 1 }, unique]]);

export const Withdrawal = define('Withdrawal', 'withdrawals', {
  memberId: required(ObjectId),
  amount: money,
  reason: required(String),
  date: required(String),
  status: choice(['pending', 'approved', 'paid', 'rejected'], 'pending'),
}, [[{ memberId: 1 }], [{ status: 1, date: -1 }]]);

// ---------- Website content ----------
export const BUSINESS_TYPES = ['Retail Shop', 'Trading & Distribution', 'Technology', 'Agriculture', 'Manufacturing', 'Service', 'Other'];

export const Project = define('Project', 'projects', {
  name: required(String),
  nameKey: required(String),
  slug: required(String),
  accountId: required(ObjectId),
  businessType: choice(BUSINESS_TYPES),
  status: choice(['running', 'completed', 'planned'], 'running'),
  startDate: required(String),
  location: { type: String, default: '' },
  contactPerson: { type: String, default: '' },
  contactMobile: { type: String, default: '' },
  showOnWebsite: choice(['yes', 'no'], 'no'),
  summary: { type: String, default: '' },
  description: { type: String, default: '' },
  images: [String],
  facts: { type: [[String]], default: [] },
  imageAlt: { type: String, default: '' },
  imageIsStock: { type: Boolean, default: false },
  placeholder: { type: Boolean, default: false },
  sortOrder: { type: Number, default: 0 },
}, [[{ nameKey: 1 }, unique], [{ slug: 1 }, unique], [{ accountId: 1 }]]);

export const PageName = define('PageName', 'page_names', {
  name: required(String),
  nameKey: required(String),
  slug: required(String),
  status: choice(['active', 'inactive'], 'active'),
  order: required(Number),
}, [[{ nameKey: 1 }, unique], [{ slug: 1 }, unique]]);

export const PageSection = define('PageSection', 'page_sections', {
  pageId: required(ObjectId),
  sectionHeader: required(String),
  sectionNumber: required(Number),
  position: required(Number),
  title: required(String),
  subTitle: { type: String, default: '' },
  description: { type: String, default: '' },
  images: [String],
  status: choice(['active', 'inactive'], 'active'),
}, [[{ pageId: 1, sectionNumber: 1, position: 1 }]]);

export const Faq = define('Faq', 'faqs', {
  question: required(String),
  answer: required(String),
  published: choice(['yes', 'no'], 'yes'),
  order: { type: Number, default: 0 },
});

export const Notice = define('Notice', 'notices', {
  title: required(String),
  body: required(String),
  date: required(String),
  published: choice(['yes', 'no'], 'no'),
}, [[{ published: 1, date: -1 }]]);

export const Upload = define('Upload', 'uploads', {
  name: required(String),
  mime: required(String),
  size: required(Number),
  data: required(Buffer),
  uploadedBy: ObjectId,
}, [[{ name: 1 }, unique]]);

// ---------- System ----------
export const Setting = define('Setting', 'settings', {
  key: required(String),
  orgName: String,
  tagline: String,
  about: String,
  phone: String,
  monthlyAmount: Number,
  dueDay: Number,
  fine: Number,
  collectionStart: String,
  lastCollectionMonth: String,
  profitThroughMonth: String,
  publicShowMoney: Boolean,
  contentUpdatedAt: Date,
}, [[{ key: 1 }, unique]]);

export const AuditLog = define('AuditLog', 'audit_logs', {
  userId: ObjectId,
  userName: required(String),
  action: required(String),
  entity: required(String),
  entityId: String,
  before: Mixed,
  after: Mixed,
  ip: String,
  at: { type: Date, default: Date.now },
}, [[{ at: -1 }], [{ entity: 1, entityId: 1, at: -1 }], [{ userId: 1, at: -1 }]], { timestamps: false });

/** Documents that serialize sensitive changes: writing one inside a transaction makes rivals retry. */
export const Lock = define('Lock', 'admin_locks', {
  key: required(String),
  revision: { type: Number, default: 0 },
}, [[{ key: 1 }, unique]]);

/** Create every collection and index. Safe to run repeatedly. */
export async function ensureIndexes() {
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection();
    await model.createIndexes();
  }
  for (const key of ['users', 'members', 'finance', 'content']) {
    await Lock.updateOne({ key }, { $setOnInsert: { revision: 0 } }, { upsert: true });
  }
}

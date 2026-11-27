// Mirrors the admin panel's `src/lib/permissions.js`. The server is what actually enforces it.
import { RoleAction, UserPermission } from '../models/index.js';

const CRUD = ['view', 'create', 'update', 'delete'];
const NO_DELETE = ['view', 'create', 'update']; // financial records are never deletable
const VIEW = ['view'];

export const MODULES = {
  dashboard: { actions: VIEW, group: 'Overview' },
  members: { actions: CRUD, group: 'Finance' },
  payments: { actions: NO_DELETE, group: 'Finance' },
  'payment-submissions': { actions: NO_DELETE, group: 'Finance' },
  dues: { actions: VIEW, group: 'Finance' },
  investments: { actions: CRUD, group: 'Finance' },
  projects: { actions: CRUD, group: 'Finance' },
  profits: { actions: NO_DELETE, group: 'Finance' },
  withdrawals: { actions: NO_DELETE, group: 'Finance' },
  'page-names': { actions: CRUD, group: 'Website' },
  'page-sections': { actions: CRUD, group: 'Website' },
  faqs: { actions: CRUD, group: 'Website' },
  notices: { actions: CRUD, group: 'Website' },
  // Message Inbox is switched off for now. Uncomment together with the route in src/routes/index.js.
  // messages: { actions: CRUD, group: 'Website' },
  users: { actions: CRUD, group: 'Administration', superOnly: true },
  'user-permissions': { actions: CRUD, group: 'Administration', superOnly: true },
  roles: { actions: VIEW, group: 'Administration', superOnly: true },
  audit: { actions: VIEW, group: 'Administration' },
  settings: { actions: ['view', 'update'], group: 'Administration' },
};

export const EDITABLE_ROLES = ['admin', 'accountant', 'viewer'];
export const assignablePages = () => Object.keys(MODULES).filter(key => !MODULES[key].superOnly);

const pagesIn = (...groups) => assignablePages().filter(key => groups.includes(MODULES[key].group));
const operational = [...pagesIn('Overview', 'Finance', 'Website'), 'audit'];
const readOnly = Object.fromEntries(operational.map(key => [key, VIEW]));

export const DEFAULT_ROLE_ACTIONS = {
  admin: {
    ...readOnly,
    members: CRUD, payments: NO_DELETE, 'payment-submissions': NO_DELETE, investments: CRUD, projects: CRUD,
    profits: NO_DELETE, withdrawals: NO_DELETE,
    'page-names': CRUD, 'page-sections': CRUD, faqs: CRUD, notices: CRUD,
    // messages: ['view', 'update', 'delete'],
    settings: ['view', 'update'],
  },
  accountant: {
    ...readOnly,
    members: ['view', 'update'], payments: NO_DELETE, 'payment-submissions': NO_DELETE, profits: NO_DELETE, withdrawals: NO_DELETE,
  },
  viewer: readOnly,
};

export const DEFAULT_PAGES = {
  admin: [...operational, 'settings'],
  accountant: operational,
  viewer: operational,
};

/** The whole role → module → actions map: stored values, otherwise the defaults. */
export async function roleActions(session) {
  const rows = await RoleAction.find().session(session || null).lean();
  return Object.fromEntries(EDITABLE_ROLES.map(role => [role, rows.find(row => row.role === role)?.modules ?? DEFAULT_ROLE_ACTIONS[role]]));
}

/** Allowed pages and actions of a user. Reloaded per request, so changes apply immediately. */
export async function permissionsOf(user) {
  const actions = {};
  if (user.status !== 'active' || user.role === 'member') return { pages: [], actions };
  if (user.role === 'super_admin') {
    for (const [key, module] of Object.entries(MODULES)) actions[key] = module.actions;
    return { pages: Object.keys(MODULES), actions };
  }
  const row = await UserPermission.findOne({ userId: user._id, status: 'active' }).lean();
  const role = (await roleActions())[user.role] || {};
  for (const key of row?.pages || []) {
    const module = MODULES[key];
    if (!module || module.superOnly) continue;
    actions[key] = module.actions.filter(action => action === 'view' || role[key]?.includes(action));
  }
  return { pages: Object.keys(actions), actions };
}

export const allows = (permissions, module, action = 'view') => Boolean(permissions.actions[module]?.includes(action));

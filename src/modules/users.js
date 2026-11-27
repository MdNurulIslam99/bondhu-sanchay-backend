// Staff users, their page permissions, role actions and website member accounts.
import { z } from 'zod';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { DEFAULT_ROLE_ACTIONS, EDITABLE_ROLES, MODULES, assignablePages, roleActions } from '../lib/permissions.js';
import { contains, send, sendList, sendRows } from '../lib/respond.js';
import { activeStatus, email, listQuery, objectId, optionalPhone, password, text } from '../lib/schemas.js';
import { hashPassword } from '../lib/security.js';
import { actorOf, audit, lock, transaction, view } from '../lib/tx.js';
import { Member, ROLES, RoleAction, STAFF_ROLES, Session, Submission, User, UserPermission } from '../models/index.js';

// "messages" is switched off; it is ignored rather than rejected so an older panel can still save.
const IGNORED = new Set(['messages']);

const staffView = user => ({ id: String(user._id), name: user.name, email: user.email, phone: user.phone || '', role: user.role, status: user.status, mustChangePassword: Boolean(user.mustChangePassword), createdAt: user.createdAt });

async function findStaff(id, session) {
  const user = await User.findOne({ _id: id, role: { $in: STAFF_ROLES } }).session(session || null);
  if (!user) throw notFound('User not found');
  return user;
}

async function protectAccess(req, user, { removed, role, status }, session) {
  const losesAccess = removed || status === 'inactive' || (role && role !== user.role);
  if (!losesAccess) return;
  if (String(user._id) === String(req.user._id)) throw conflict('You cannot remove or deactivate your own account.', 'SELF_PROTECTED');
  if (user.role === 'super_admin' && user.status === 'active'
    && await User.countDocuments({ role: 'super_admin', status: 'active' }).session(session) <= 1) {
    throw conflict('The last active super admin cannot be removed.', 'LAST_ADMIN');
  }
}

const userFields = { name: text(80).min(2), email, role: z.enum(STAFF_ROLES), status: activeStatus, phone: optionalPhone };
const createUser = z.strictObject({ ...userFields, status: activeStatus.optional(), phone: optionalPhone.optional(), password: z.union([z.literal(''), password]).optional() });
const updateUser = z.strictObject(userFields).partial();

function userRoutes(api) {
  const tag = 'Users';
  const query = listQuery({ sort: ['createdAt', 'name', 'email', 'role', 'status'], filters: { role: z.enum(ROLES).optional(), status: activeStatus.optional() } });
  api.get('/users', { tag, summary: 'List all users: staff and website accounts', access: ['users', 'view'], query }, async (req, res) => {
    const { role, status, search } = req.input.query;
    const filter = { ...(role ? { role } : {}), ...(status ? { status } : {}), ...(search ? { $or: [{ name: contains(search) }, { email: contains(search) }] } : {}) };
    await sendList(res, { model: User, filter, query: req.input.query, map: rows => rows.map(staffView), name: 'users', columns: ['id', 'name', 'email', 'role', 'status'] });
  });
  api.get('/users/:id', { tag, summary: 'Read a user', access: ['users', 'view'] }, async (req, res) => {
    const user = await User.findById(req.input.params.id);
    if (!user) throw notFound('User not found');
    send(res, staffView(user));
  });
  api.post('/users', { tag, summary: 'Create a staff user', access: ['users', 'create'], body: createUser }, async (req, res) => {
    const { password: secret, phone, status = 'active', ...input } = req.input.body;
    const passwordHash = secret ? await hashPassword(secret) : undefined;
    const user = await transaction(async session => {
      const [row] = await User.create([{ ...input, status, phone: phone || undefined, passwordHash, mustChangePassword: Boolean(secret) }], { session });
      await audit(actorOf(req), 'Created', 'users', row._id, { after: staffView(row), session });
      return row;
    });
    send(res, staffView(user), { status: 201, message: secret ? 'User created' : 'User created. Set a password so they can log in.' });
  });
  const update = async (req, res) => {
    const input = req.input.body;
    const result = await transaction(async session => {
      await lock('users', session);
      const user = await findStaff(req.input.params.id, session);
      await protectAccess(req, user, input, session);
      const before = staffView(user);
      const signOut = (input.role && input.role !== user.role) || (input.status && input.status !== user.status) || (input.email && input.email !== user.email);
      user.set(input);
      if (input.phone === '') user.phone = undefined;
      if (signOut && String(user._id) !== String(req.user._id)) user.sessionVersion += 1;
      await user.save({ session });
      await audit(actorOf(req), 'Updated', 'users', user._id, { before, after: staffView(user), session });
      return staffView(user);
    });
    send(res, result, { message: 'User saved' });
  };
  api.put('/users/:id', { tag, summary: 'Update a user', access: ['users', 'update'], body: updateUser }, update);
  api.patch('/users/:id', { tag, summary: 'Update a user', access: ['users', 'update'], body: updateUser }, update);
  api.put('/users/:id/password', { tag, summary: 'Set or reset a user password', access: ['users', 'update'], body: z.strictObject({ password }) }, async (req, res) => {
    const passwordHash = await hashPassword(req.input.body.password);
    await transaction(async session => {
      const user = await findStaff(req.input.params.id, session);
      if (String(user._id) === String(req.user._id)) throw conflict('Use change password for your own account.', 'SELF_PROTECTED');
      user.set({ passwordHash, mustChangePassword: true, sessionVersion: user.sessionVersion + 1 });
      await user.save({ session });
      await Session.deleteMany({ userId: user._id }, { session });
      await audit(actorOf(req), 'Set password', 'users', user._id, { session });
    });
    send(res, null, { message: 'Password set. The user must change it at the next login.' });
  });
  api.delete('/users/:id', { tag, summary: 'Delete a user and their page permissions', access: ['users', 'delete'] }, async (req, res) => {
    await transaction(async session => {
      await lock('users', session);
      const user = await findStaff(req.input.params.id, session);
      await protectAccess(req, user, { removed: true }, session);
      const before = staffView(user);
      await user.deleteOne({ session });
      await UserPermission.deleteMany({ userId: user._id }, { session });
      await Session.deleteMany({ userId: user._id }, { session });
      await audit(actorOf(req), 'Deleted', 'users', user._id, { before, session });
    });
    send(res, null, { message: 'User deleted' });
  });
}

const pages = z.array(z.enum([...assignablePages(), ...IGNORED]))
  .transform(list => [...new Set(list)].filter(key => !IGNORED.has(key)))
  .refine(list => list.length > 0, 'Select at least one page');

function permissionRoutes(api) {
  const tag = 'User permissions';
  const decorate = async rows => {
    const users = await User.find({ _id: { $in: rows.map(row => row.userId) } }).lean();
    return rows.map(row => {
      const user = users.find(item => String(item._id) === String(row.userId));
      return { ...view(row), userName: user?.name ?? '', email: user?.email ?? '', role: user?.role ?? '' };
    });
  };
  const query = listQuery({ sort: ['createdAt', 'status'], filters: { status: activeStatus.optional(), userId: objectId.optional() } });
  api.get('/user-permissions', { tag, summary: 'List page permissions', access: ['user-permissions', 'view'], query }, async (req, res) => {
    const { status, userId, search } = req.input.query;
    const filter = { ...(status ? { status } : {}), ...(userId ? { userId } : {}) };
    if (search) {
      const users = await User.find({ $or: [{ name: contains(search) }, { email: contains(search) }] }, '_id').lean();
      filter.$and = [{ userId: { $in: users.map(user => user._id) } }];
    }
    await sendList(res, { model: UserPermission, filter, query: req.input.query, map: decorate, name: 'user-permissions', columns: ['id', 'userName', 'email', 'role', 'pages', 'status'] });
  });
  api.get('/user-permissions/:id', { tag, summary: 'Read one permission row', access: ['user-permissions', 'view'] }, async (req, res) => {
    const row = await UserPermission.findById(req.input.params.id).lean();
    if (!row) throw notFound();
    send(res, (await decorate([row]))[0]);
  });
  const write = async (req, id) => transaction(async session => {
    const input = req.input.body;
    const row = id ? await UserPermission.findById(id).session(session) : new UserPermission();
    if (!row) throw notFound();
    const before = id ? view(row) : null;
    if (input.userId) {
      if (id && input.userId !== String(row.userId)) throw invalid({ userId: 'The user of a permission cannot be changed' });
      const user = await User.findById(input.userId).session(session);
      if (!user || !EDITABLE_ROLES.includes(user.role)) throw invalid({ userId: 'Choose a staff user who is not a super admin' });
      if (!id && await UserPermission.exists({ userId: user._id }).session(session)) throw conflict('This user already has permissions.', 'DUPLICATE_RECORD', { userId: 'Already in use' });
    }
    row.set(input);
    await row.save({ session });
    await audit(actorOf(req), id ? 'Updated' : 'Created', 'user-permissions', row._id, { before, after: view(row), session });
    return (await decorate([row.toObject()]))[0];
  });
  api.post('/user-permissions', { tag, summary: 'Give a user pages', access: ['user-permissions', 'create'], body: z.strictObject({ userId: objectId, status: activeStatus.optional(), pages }) },
    async (req, res) => send(res, await write(req), { status: 201, message: 'Permission added' }));
  const body = z.strictObject({ userId: objectId, status: activeStatus, pages }).partial();
  for (const method of ['put', 'patch']) {
    api[method]('/user-permissions/:id', { tag, summary: 'Change a user\'s pages', access: ['user-permissions', 'update'], body },
      async (req, res) => send(res, await write(req, req.input.params.id), { message: 'Permission saved' }));
  }
  api.delete('/user-permissions/:id', { tag, summary: 'Remove a permission row', access: ['user-permissions', 'delete'] }, async (req, res) => {
    await transaction(async session => {
      const row = await UserPermission.findById(req.input.params.id).session(session);
      if (!row) throw notFound();
      await row.deleteOne({ session });
      await audit(actorOf(req), 'Deleted', 'user-permissions', row._id, { before: view(row), session });
    });
    send(res, null, { message: 'Permission removed' });
  });
}

const roleModules = Object.entries(MODULES).filter(([, module]) => !module.superOnly);
const roleShape = z.strictObject(Object.fromEntries([
  ...roleModules.map(([key, module]) => [key, z.array(z.enum(module.actions)).optional()]),
  ...[...IGNORED].map(key => [key, z.array(z.string()).optional()]),
]));
const rolesBody = z.strictObject(Object.fromEntries(EDITABLE_ROLES.map(role => [role, roleShape.optional()])));

function roleRoutes(api) {
  const tag = 'Role actions';
  const saveRoles = async (req, next, action) => {
    await transaction(async session => {
      const before = await roleActions(session);
      for (const [role, modules] of Object.entries(next)) {
        const cleaned = Object.fromEntries(Object.entries(modules).filter(([key]) => !IGNORED.has(key)).map(([key, list]) => [key, [...new Set(list)]]));
        await RoleAction.updateOne({ role }, { $set: { modules: cleaned } }, { upsert: true, session });
      }
      await audit(actorOf(req), action, 'role-actions', undefined, { before, after: await roleActions(session), session });
    });
    return roleActions();
  };
  api.get('/role-actions', { tag, summary: 'Actions allowed per role', access: ['roles', 'view'] }, async (req, res) => send(res, await roleActions()));
  api.put('/role-actions', { tag, summary: 'Replace role actions', access: 'superadmin', body: rolesBody },
    async (req, res) => send(res, await saveRoles(req, req.input.body, 'Changed permissions'), { message: 'Permissions saved' }));
  api.post('/role-actions/reset', { tag, summary: 'Restore the default role actions', access: 'superadmin' },
    async (req, res) => send(res, await saveRoles(req, DEFAULT_ROLE_ACTIONS, 'Reset permissions'), { message: 'Default permissions restored' }));
}

/** Website sign-ups. A staff member confirms that the account really belongs to the member. */
function memberAccountRoutes(api) {
  const tag = 'Member accounts';
  const rows = async () => {
    const [users, members] = await Promise.all([User.find({ role: 'member' }).sort({ createdAt: -1 }).lean(), Member.find({ status: { $ne: 'pending' } }).lean()]);
    return users.map(user => {
      const member = members.find(item => item.phone && item.phone === user.phone);
      const status = user.linkStatus === 'approved' && member && String(member._id) === String(user.memberId) ? 'approved'
        : user.linkStatus === 'rejected' ? 'rejected' : member ? 'pending' : 'none';
      return { id: String(user._id), name: user.name, email: user.email, phone: user.phone, membershipStatus: status,
        memberId: member ? String(member._id) : null, memberName: member?.name ?? '', createdAt: user.createdAt };
    });
  };
  const query = listQuery({ sort: ['createdAt', 'name', 'membershipStatus'], filters: { status: z.enum(['pending', 'approved', 'rejected', 'none']).optional() } });
  api.get('/member-accounts', { tag, summary: 'Website accounts and which member they match', access: ['members', 'view'], query }, async (req, res) => {
    const { status, search } = req.input.query;
    const needle = search?.toLowerCase();
    const list = (await rows()).filter(row => (!status || row.membershipStatus === status)
      && (!needle || [row.name, row.email, row.phone, row.memberName].join(' ').toLowerCase().includes(needle)));
    sendRows(res, { rows: list, query: req.input.query, name: 'member-accounts', columns: ['id', 'name', 'email', 'phone', 'membershipStatus', 'memberName'] });
  });
  const decide = approve => async (req, res) => {
    await transaction(async session => {
      const user = await User.findOne({ _id: req.input.params.id, role: 'member' }).session(session);
      if (!user) throw notFound('Account not found');
      if (approve) {
        const member = await Member.findOne({ phone: user.phone, status: { $ne: 'pending' } }).session(session);
        if (!member) throw conflict('No approved member has this mobile number. Add or approve the member first.', 'NO_MATCHING_MEMBER');
        if (await User.exists({ _id: { $ne: user._id }, memberId: member._id, linkStatus: 'approved' }).session(session)) {
          throw conflict('This member is already linked to another account.', 'ALREADY_LINKED');
        }
        user.set({ linkStatus: 'approved', memberId: member._id });
      } else user.set({ linkStatus: 'rejected', memberId: undefined });
      await user.save({ session });
      await audit(actorOf(req), approve ? 'Approved member account' : 'Rejected member account', 'member-accounts', user._id, { after: { memberId: user.memberId ? String(user.memberId) : null }, session });
    });
    send(res, (await rows()).find(row => row.id === req.input.params.id), { message: approve ? 'Account approved' : 'Account rejected' });
  };
  api.post('/member-accounts/:id/approve', { tag, summary: 'Confirm the account belongs to the member', access: ['members', 'update'] }, decide(true));
  api.post('/member-accounts/:id/reject', { tag, summary: 'Refuse or revoke member access', access: ['members', 'update'] }, decide(false));
  api.delete('/member-accounts/:id', { tag, summary: 'Delete a website account', access: ['members', 'delete'] }, async (req, res) => {
    await transaction(async session => {
      const user = await User.findOne({ _id: req.input.params.id, role: 'member' }).session(session);
      if (!user) throw notFound('Account not found');
      await user.deleteOne({ session });
      await Session.deleteMany({ userId: user._id }, { session });
      // Payment submissions are financial history and stay, no longer tied to a login.
      await Submission.updateMany({ userId: user._id }, { $unset: { userId: 1 } }, { session });
      await audit(actorOf(req), 'Deleted', 'member-accounts', user._id, { before: { name: user.name, email: user.email, phone: user.phone }, session });
    });
    send(res, null, { message: 'Account deleted' });
  });
}

export default function usersRoutes(api) {
  userRoutes(api);
  permissionRoutes(api);
  roleRoutes(api);
  memberAccountRoutes(api);
}

import crypto from 'node:crypto';
import { z } from 'zod';
import { linkedMember } from '../lib/api.js';
import { AppError, conflict, invalid } from '../lib/errors.js';
import { canSendCodes, sendResetCode } from '../lib/notify.js';
import { permissionsOf } from '../lib/permissions.js';
import { send } from '../lib/respond.js';
import { email, normalizePhone, password, phone, text } from '../lib/schemas.js';
import {
  MAX_FAILS, SESSION_COOKIE, TOKEN_PATTERN, cookieOptions, createSession, hashPassword, limiter, loginAttempt,
  randomToken, sha256, verifyPassword,
} from '../lib/security.js';
import { actorOf, audit, transaction } from '../lib/tx.js';
import { LoginAttempt, Member, PasswordReset, Session, User } from '../models/index.js';
import { loadLedger, memberAccount } from './ledger.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const VERIFIED_TTL_MS = 10 * 60 * 1000;
const OTP_TRIES = 5;
const RESET_COOKIE = 'bs_reset';
const IP_FAILS = 20;

const findByIdentifier = identifier => identifier.includes('@')
  ? { email: identifier.trim().toLowerCase() } : { phone: normalizePhone(identifier.trim()) };
const lockKeys = user => [user.email, user.phone].filter(Boolean).map(value => `identifier:${sha256(value)}`);

/** `membershipStatus`: whether a website account has been confirmed as a member. */
export async function userView(user) {
  let membershipStatus = 'none';
  if (user.linkStatus === 'approved' && await linkedMember(user)) membershipStatus = 'approved';
  else if (user.linkStatus === 'rejected') membershipStatus = 'rejected';
  else if (user.phone && await Member.exists({ phone: user.phone, status: { $ne: 'pending' } })) membershipStatus = 'pending';
  return {
    id: String(user._id), name: user.name, email: user.email, phone: user.phone || '', role: user.role, status: user.status,
    avatar: user.avatar || '', mustChangePassword: Boolean(user.mustChangePassword), membershipStatus,
    memberId: membershipStatus === 'approved' ? String(user.memberId) : null, createdAt: user.createdAt,
  };
}

const identity = async user => ({ user: await userView(user), ...await permissionsOf(user) });

async function login(req, res) {
  const { email: address, identifier = address, password: secret } = req.input.body;
  if (!identifier) throw invalid({ email: 'Enter your email or mobile number' });
  const query = findByIdentifier(identifier);
  const value = query.email ?? query.phone;
  const byIdentifier = await loginAttempt(`identifier:${sha256(value)}`, MAX_FAILS);
  const byIp = await loginAttempt(`ip:${sha256(req.ip || '')}`, IP_FAILS);
  const user = value ? await User.findOne(query).select('+passwordHash') : null;
  const valid = await verifyPassword(user?.passwordHash, secret);
  if (!valid || user.status !== 'active') {
    await byIdentifier.failed();
    await byIp.failed();
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
  }
  await byIdentifier.succeeded({ clear: true });
  await byIp.succeeded({ clear: false });
  const session = await createSession(res, user);
  await audit({ user, ip: req.ip }, 'Logged in', 'users', user._id);
  send(res, { ...session, ...await identity(user) }, { message: 'Logged in' });
}

async function signup(req, res) {
  const input = req.input.body;
  if (await User.exists({ $or: [{ email: input.email }, { phone: input.phone }] })) {
    throw conflict('An account with this email or number already exists.', 'ACCOUNT_EXISTS');
  }
  const passwordHash = await hashPassword(input.password);
  const user = await transaction(async session => {
    const [created] = await User.create([{
      name: input.name, email: input.email, phone: input.phone, passwordHash, role: 'member', status: 'active', termsAcceptedAt: new Date(),
    }], { session });
    await audit({ user: created, ip: req.ip }, 'Signed up', 'users', created._id, { session });
    return created;
  });
  const sessionData = await createSession(res, user);
  send(res, { ...sessionData, ...await identity(user) }, { status: 201, message: 'Account created' });
}

async function changePassword(req, res) {
  const body = req.input.body;
  const current = body.currentPassword ?? body.current;
  const next = body.password ?? body.next;
  if (!current) throw invalid({ currentPassword: 'Enter your current password' });
  const checked = password.safeParse(next);
  if (!checked.success) throw invalid({ password: checked.error.issues[0].message });
  const user = await User.findById(req.user._id).select('+passwordHash');
  const attempt = await loginAttempt(`password:${user._id}`, MAX_FAILS);
  if (!await verifyPassword(user.passwordHash, current)) {
    await attempt.failed();
    throw invalid({ currentPassword: 'Current password is incorrect.' });
  }
  if (current === next) throw invalid({ password: 'Choose a password you are not already using' });
  await attempt.succeeded({ clear: true });
  const passwordHash = await hashPassword(next);
  const updated = await transaction(async session => {
    const row = await User.findOneAndUpdate({ _id: user._id, sessionVersion: user.sessionVersion },
      { $set: { passwordHash, mustChangePassword: false }, $inc: { sessionVersion: 1 } }, { session, returnDocument: 'after' });
    if (!row) throw conflict('Your account changed. Please sign in again.');
    await Session.deleteMany({ userId: user._id }, { session });
    await audit(actorOf(req), 'Changed password', 'users', user._id, { session });
    return row;
  });
  // Every other device is signed out; this one receives a fresh session.
  send(res, await createSession(res, updated), { message: 'Password changed' });
}

async function forgotPassword(req, res) {
  if (!canSendCodes()) throw new AppError(503, 'DELIVERY_NOT_CONFIGURED', 'Password reset is not available right now');
  const identifier = req.input.body.identifier ?? req.input.body.email;
  if (!identifier) throw invalid({ identifier: 'Please enter your email or mobile number.' });
  const query = findByIdentifier(identifier);
  const identifierHash = sha256(query.email ?? query.phone);
  const recent = await PasswordReset.findOne({ identifierHash, resendAt: { $gt: new Date() } }).lean();
  if (recent) {
    const seconds = Math.ceil((recent.resendAt - Date.now()) / 1000);
    throw new AppError(429, 'RESEND_TOO_SOON', `Please wait ${seconds} seconds before requesting a new code.`);
  }
  const user = await User.findOne({ ...query, status: 'active' }).lean();
  const resetToken = randomToken();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  await PasswordReset.deleteMany({ identifierHash });
  await PasswordReset.create({
    tokenHash: sha256(resetToken), identifierHash, userId: user?._id, otpHash: sha256(`${code}:${resetToken}`),
    expiresAt: new Date(now + OTP_TTL_MS), resendAt: new Date(now + RESEND_MS), deleteAt: new Date(now + 60 * 60 * 1000),
  });
  // Not awaited: the response must look and take the same whether or not the account exists.
  if (user) Promise.resolve(sendResetCode(user, code)).catch(() => console.error('Password reset email could not be sent'));
  res.cookie(RESET_COOKIE, resetToken, { ...cookieOptions, maxAge: 60 * 60 * 1000 });
  send(res, { resetToken, expiresInSeconds: OTP_TTL_MS / 1000, resendInSeconds: RESEND_MS / 1000 },
    { status: 202, message: 'If the account exists, a code has been sent.' });
}

const resetTokenOf = req => {
  const token = req.input.body.resetToken ?? req.cookies?.[RESET_COOKIE];
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new AppError(400, 'RESET_EXPIRED', 'Session expired. Please request a new code.');
  return token;
};

async function verifyOtp(req, res) {
  const token = resetTokenOf(req);
  // The try is counted atomically before the code is compared.
  const row = await PasswordReset.findOneAndUpdate(
    { tokenHash: sha256(token), verified: false, tries: { $lt: OTP_TRIES }, expiresAt: { $gt: new Date() } },
    { $inc: { tries: 1 } }, { returnDocument: 'after' });
  if (!row) throw new AppError(400, 'RESET_EXPIRED', 'This code has expired. Please request a new one.');
  if (!row.userId || row.otpHash !== sha256(`${req.input.body.code}:${token}`)) {
    const left = OTP_TRIES - row.tries;
    throw new AppError(400, 'INCORRECT_CODE', left ? `Incorrect code. ${left} attempts left.` : 'Too many wrong attempts. Please request a new code.');
  }
  await PasswordReset.updateOne({ _id: row._id }, { verified: true, expiresAt: new Date(Date.now() + VERIFIED_TTL_MS) });
  send(res, { verified: true }, { message: 'Code verified' });
}

async function resetPassword(req, res) {
  const token = resetTokenOf(req);
  const passwordHash = await hashPassword(req.input.body.password);
  await transaction(async session => {
    const row = await PasswordReset.findOneAndDelete({ tokenHash: sha256(token), verified: true, expiresAt: { $gt: new Date() } }, { session });
    const user = row && await User.findOneAndUpdate({ _id: row.userId, status: 'active' },
      { $set: { passwordHash, mustChangePassword: false }, $inc: { sessionVersion: 1 } }, { session, returnDocument: 'after' });
    if (!user) throw new AppError(400, 'RESET_EXPIRED', 'Session expired. Please start again.');
    await Session.deleteMany({ userId: user._id }, { session });
    await LoginAttempt.deleteMany({ key: { $in: lockKeys(user) } }, { session });
    await audit({ user, ip: req.ip }, 'Reset password', 'users', user._id, { session });
  });
  res.clearCookie(RESET_COOKIE, cookieOptions);
  res.clearCookie(SESSION_COOKIE, cookieOptions);
  send(res, null, { message: 'Password updated. Please sign in.' });
}

const avatar = z.union([
  z.literal(''),
  z.string().max(400_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Use a PNG, JPG or WEBP image'),
  z.url({ protocol: /^https$/ }).max(2000),
]);

export default function authRoutes(api) {
  const tag = 'Auth';
  const strict = limiter(30);
  const codes = limiter(15);

  api.post('/auth/signup', {
    tag, summary: 'Create a website account', limit: limiter(10),
    body: z.strictObject({ name: text(80).min(2, 'Please enter your name.'), email, phone, password, agreeToTerms: z.literal(true, 'Please accept the terms') }),
  }, signup);
  api.post('/auth/login', {
    tag, summary: 'Log in with email or mobile number', limit: strict,
    body: z.strictObject({ email: z.string().trim().max(120).optional(), identifier: z.string().trim().max(120).optional(), password: z.string().min(1, 'Enter your password').max(128) }),
  }, login);
  api.get('/auth/me', { tag, summary: 'Signed-in user with pages and actions', access: 'user', allowPasswordChange: true },
    async (req, res) => send(res, await identity(req.user)));
  api.post('/auth/logout', { tag, summary: 'End this session', access: 'user', allowPasswordChange: true }, async (req, res) => {
    await Session.deleteOne({ _id: req.authSession._id });
    await audit(actorOf(req), 'Logged out', 'users', req.user._id);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    send(res, null, { message: 'Logged out' });
  });
  api.post('/auth/refresh', { tag, summary: 'Exchange the current token for a new one', access: 'user', allowPasswordChange: true }, async (req, res) => {
    // The 24-hour limit counts from the original login, so refreshing cannot extend a session forever.
    const old = await Session.findOneAndDelete({ _id: req.authSession._id });
    if (!old) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
    const next = await createSession(res, req.user);
    await Session.updateOne({ tokenHash: sha256(next.accessToken) }, { expiresAt: old.expiresAt });
    send(res, { ...next, expiresAt: old.expiresAt, ...await identity(req.user) });
  });

  const passwordBody = z.strictObject({
    currentPassword: z.string().max(128).optional(), password: z.string().max(128).optional(),
    current: z.string().max(128).optional(), next: z.string().max(128).optional(),
  });
  for (const path of ['/auth/change-password', '/me/password']) {
    api.post(path, { tag, summary: 'Change own password', access: 'user', allowPasswordChange: true, body: passwordBody, limit: strict }, changePassword);
  }

  api.post('/auth/password/forgot', { tag, summary: 'Send a 6-digit reset code', limit: codes,
    body: z.strictObject({ identifier: z.string().trim().min(3).max(120).optional(), email: z.string().trim().min(3).max(120).optional() }) }, forgotPassword);
  api.post('/auth/password/verify-otp', { tag, summary: 'Check the reset code', limit: strict,
    body: z.strictObject({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'), resetToken: z.string().optional() }) }, verifyOtp);
  api.post('/auth/password/reset', { tag, summary: 'Set a new password after verifying the code', limit: strict,
    body: z.strictObject({ password, resetToken: z.string().optional() }) }, resetPassword);

  api.patch('/me', { tag, summary: 'Update own name, email or picture', access: 'user',
    body: z.strictObject({ name: text(80).min(2), email, avatar }).partial() }, async (req, res) => {
    const patch = req.input.body;
    const user = await transaction(async session => {
      const row = await User.findByIdAndUpdate(req.user._id, { $set: patch }, { session, returnDocument: 'after' }).lean();
      await audit(actorOf(req), 'Updated profile', 'users', row._id, {
        before: { name: req.user.name, email: req.user.email }, after: { name: row.name, email: row.email }, session,
      });
      return row;
    });
    send(res, await userView(user), { message: 'Profile saved' });
  });

  api.get('/me/account', { tag, summary: 'Own member account (member is null until approved)', access: 'user' }, async (req, res) => {
    const member = await linkedMember(req.user);
    if (!member) return send(res, { member: null, membershipStatus: (await userView(req.user)).membershipStatus });
    const account = memberAccount(await loadLedger(), member);
    send(res, { member: { id: String(member._id), sl: member.sl, name: member.name, phone: member.phone, joinDate: member.joinDate || '', monthly: member.monthly, status: member.status }, membershipStatus: 'approved', account });
  });
}

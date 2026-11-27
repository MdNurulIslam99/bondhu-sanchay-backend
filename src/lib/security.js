import crypto from 'node:crypto';
import argon2 from 'argon2';
import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { LoginAttempt, Session, User } from '../models/index.js';
import { AppError, errorBody, forbidden, unauthenticated } from './errors.js';

export const SESSION_COOKIE = 'bs_session';
export const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 24 * 60 * 60 * 1000;
export const MAX_FAILS = 5;
export const LOCK_MS = 5 * 60 * 1000;

export const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const cookieOptions = { httpOnly: true, secure: env.secureCookies, sameSite: env.cookieSameSite, path: '/' };

export const hashPassword = value => argon2.hash(value, { type: argon2.argon2id });
// Created on first use. No top-level `await` is allowed here: Vercel loads the app with `require()`,
// which fails with ERR_REQUIRE_ASYNC_MODULE and takes the whole deployment down.
let dummyHash;
/** Always performs a hash check, so timing does not reveal whether an account exists. */
export async function verifyPassword(hash, value) {
  const dummy = await (dummyHash ??= hashPassword(randomToken()));
  const matches = await argon2.verify(hash || dummy, value);
  return Boolean(hash) && matches;
}

export async function createSession(res, user, session) {
  const token = randomToken();
  const now = new Date();
  await Session.create([{ tokenHash: sha256(token), userId: user._id, version: user.sessionVersion, lastSeenAt: now, expiresAt: new Date(now.getTime() + ABSOLUTE_MS) }], { session });
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: IDLE_MS });
  return { accessToken: token, idleTimeoutSeconds: IDLE_MS / 1000, expiresAt: new Date(now.getTime() + ABSOLUTE_MS) };
}

const allowedOrigins = new Set([...env.corsOrigins, new URL(env.publicApiUrl).origin]);
const unsafe = method => !['GET', 'HEAD', 'OPTIONS'].includes(method);

/** Blocks browser requests that come from a website which is not on the allow list. */
export function checkOrigin(req, res, next) {
  const origin = req.get('origin');
  if (unsafe(req.method) && origin && !allowedOrigins.has(origin)) throw forbidden('Request origin is not allowed', 'ORIGIN_NOT_ALLOWED');
  next();
}

/** Accepts `Authorization: Bearer <token>` or the httpOnly session cookie. */
export async function authenticate(req, res, next) {
  const header = req.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw unauthenticated();
  // Cookies are sent automatically by browsers, so cookie writes must prove where they come from (CSRF).
  if (!bearer && unsafe(req.method) && !allowedOrigins.has(req.get('origin'))) {
    throw forbidden('Send the request from an allowed origin or use a Bearer token', 'ORIGIN_NOT_ALLOWED');
  }
  const now = new Date();
  const session = await Session.findOneAndUpdate(
    { tokenHash: sha256(token), expiresAt: { $gt: now }, lastSeenAt: { $gt: new Date(now.getTime() - IDLE_MS) } },
    { $set: { lastSeenAt: now } }, { returnDocument: 'after' }).lean();
  const user = session ? await User.findById(session.userId).lean() : null;
  if (!user || user.status !== 'active' || session.version !== user.sessionVersion) {
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    throw unauthenticated('Your session has ended. Please sign in again.');
  }
  req.user = user;
  req.authSession = session;
  res.set('Cache-Control', 'no-store');
  if (!bearer) res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: IDLE_MS });
  next();
}

const lockedError = until => {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  return new AppError(429, 'LOCKED', `Too many failed attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`);
};

/**
 * Count an attempt before checking the password, so parallel guesses cannot slip past the limit.
 * Call `succeeded()` when the password is right and `failed()` when it is wrong.
 */
export async function loginAttempt(key, limit) {
  const now = new Date();
  await LoginAttempt.deleteMany({ key, expiresAt: { $lte: now } });
  const update = { $inc: { failures: 1 }, $setOnInsert: { expiresAt: new Date(now.getTime() + LOCK_MS) } };
  let row;
  try {
    row = await LoginAttempt.findOneAndUpdate({ key }, update, { upsert: true, returnDocument: 'after' });
  } catch (error) {
    if (error.code !== 11000) throw error;
    row = await LoginAttempt.findOneAndUpdate({ key }, { $inc: { failures: 1 } }, { returnDocument: 'after' });
  }
  const lockNow = async () => {
    const until = new Date(Date.now() + LOCK_MS);
    await LoginAttempt.updateOne({ key, lockedUntil: null }, { $set: { lockedUntil: until, expiresAt: until } });
  };
  if (row.lockedUntil > now) throw lockedError(row.lockedUntil);
  if (row.failures > limit) { await lockNow(); throw lockedError(Date.now() + LOCK_MS); }
  return {
    failed: async () => { if (row.failures >= limit) await lockNow(); },
    succeeded: async ({ clear }) => clear ? LoginAttempt.deleteOne({ key }) : LoginAttempt.updateOne({ key }, { $inc: { failures: -1 } }),
  };
}

export const limiter = (limit, windowMinutes = 15) => rateLimit({
  windowMs: windowMinutes * 60 * 1000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: () => env.nodeEnv === 'test',
  message: errorBody(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'),
});

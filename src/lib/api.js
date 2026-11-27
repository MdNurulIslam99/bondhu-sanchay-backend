import { Router } from 'express';
import { Member } from '../models/index.js';
import { forbidden, invalid, notFound } from './errors.js';
import { allows, permissionsOf } from './permissions.js';
import { idParams } from './schemas.js';
import { authenticate, checkOrigin } from './security.js';

/** The member record behind a website account, once an admin has approved the link. */
export async function linkedMember(user) {
  if (user.linkStatus !== 'approved' || !user.memberId) return null;
  return Member.findOne({ _id: user.memberId, phone: user.phone, status: { $ne: 'pending' } }).lean();
}

/** Member pages are open to approved members and to staff who may see the dashboard. */
async function requireMemberAccess(req) {
  if (req.user.role === 'member') {
    req.member = await linkedMember(req.user);
    if (!req.member) throw forbidden('Your account is waiting to be approved as a member', 'MEMBER_REQUIRED');
  } else if (!allows(req.permissions, 'dashboard', 'view')) throw forbidden();
}

function authorize(access, allowPasswordChange) {
  return async (req, res, next) => {
    if (req.user.mustChangePassword && !allowPasswordChange) throw forbidden('Change your password before continuing', 'PASSWORD_CHANGE_REQUIRED');
    req.permissions = await permissionsOf(req.user);
    if (access === 'staff' && req.user.role === 'member') throw forbidden();
    if (access === 'superadmin' && req.user.role !== 'super_admin') throw forbidden();
    if (access === 'member') await requireMemberAccess(req);
    if (Array.isArray(access) && !allows(req.permissions, ...access)) throw forbidden();
    next();
  };
}

function parse(schema, value, source) {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  if (source === 'params') throw notFound();
  const fields = {};
  for (const issue of result.error.issues) {
    const keys = issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.') || source];
    for (const key of keys) fields[key] ??= issue.code === 'unrecognized_keys' ? 'This field is not allowed' : issue.message;
  }
  throw invalid(fields);
}

/**
 * Route registry. Every route declares who may call it and what it accepts, which also feeds the
 * generated OpenAPI document and Postman collection.
 *
 * access: 'public' | 'user' | 'staff' | 'superadmin' | 'member' | [module, action]
 */
export function createApi() {
  const router = Router();
  const routes = [];
  const add = method => (path, options, handler) => {
    const { access = 'public', body, query, params = path.includes(':id') ? idParams : undefined, limit, before = [], allowPasswordChange } = options;
    const chain = [...(limit ? [limit] : [])];
    if (access === 'public') chain.push(checkOrigin);
    else chain.push(authenticate, authorize(access, allowPasswordChange));
    chain.push(...before, (req, res, next) => {
      req.input = {
        params: params ? parse(params, req.params, 'params') : req.params,
        query: query ? parse(query, req.query, 'query') : {},
        body: body ? parse(body, req.body, 'body') : undefined,
      };
      next();
    });
    router[method](path, ...chain, handler);
    routes.push({ method, path, ...options, params });
  };
  return { router, routes, get: add('get'), post: add('post'), put: add('put'), patch: add('patch'), delete: add('delete') };
}

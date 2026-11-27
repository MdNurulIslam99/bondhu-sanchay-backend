// The API description is generated from the route registry, so it cannot drift from the code.
import { z } from 'zod';
import { env } from '../config/env.js';
import { api } from '../routes/index.js';

export function jsonSchema(schema) {
  const { $schema, ...result } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'openapi-3.0' });
  return result;
}
export const accessLabel = access => !access || access === 'public' ? 'Public'
  : Array.isArray(access) ? `Staff with permission ${access.join('.')}`
    : { user: 'Signed in', staff: 'Staff', superadmin: 'Super admin', member: 'Approved member or staff' }[access];

let cached;
export function openApiDocument() {
  if (cached) return cached;
  const paths = {};
  for (const route of api.routes) {
    const path = route.path.replace(/:(\w+)/g, '{$1}');
    const names = [...route.path.matchAll(/:(\w+)/g)].map(match => match[1]);
    const query = route.query ? jsonSchema(route.query) : null;
    paths[path] ??= {};
    paths[path][route.method] = {
      tags: [route.tag || 'Other'],
      summary: route.summary,
      description: accessLabel(route.access),
      ...(route.access && route.access !== 'public' ? { security: [{ bearer: [] }, { cookie: [] }] } : {}),
      parameters: [
        ...names.map(name => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
        ...Object.entries(query?.properties || {}).map(([name, schema]) => ({ name, in: 'query', required: Boolean(query.required?.includes(name) && schema.default === undefined), schema })),
      ],
      ...(route.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(route.body) } } } } : {}),
      ...(route.upload ? { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } } } : {}),
      responses: {
        '2XX': { description: 'Success: { success: true, data, message, pagination? }' },
        '4XX': { description: 'Error: { success: false, message, errors: { field: message }, error: { code, message } }' },
      },
    };
  }
  cached = {
    openapi: '3.0.3',
    info: { title: 'Bondhu Sanchay API', version: '1.0.0' },
    servers: [{ url: `${env.publicApiUrl}/api/v1` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, cookie: { type: 'apiKey', in: 'cookie', name: 'bs_session' } } },
    paths,
  };
  return cached;
}

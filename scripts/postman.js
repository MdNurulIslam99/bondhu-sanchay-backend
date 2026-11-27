// Builds the Postman collection: every route with ready-made keys and values.
// Records created from Postman are saved in "new...Id" variables, and edit and delete requests use
// only those, so real records are not changed by accident.
import { DEFAULT_ROLE_ACTIONS } from '../src/lib/permissions.js';

const member = { paymentDate: '2026-11-01', amount: 500, months: ['2026-11'], category: 'savings', method: 'bkash', transactionId: 'POSTMAN-001', payerAccount: '01700000000', description: 'Postman test' };

/** Request bodies. Test content is created hidden (draft, inactive, pending or planned). */
const bodies = {
  'POST /auth/signup': { name: 'Postman Member', email: 'postman.member@example.test', phone: '01700000099', password: 'Postman12345', agreeToTerms: true },
  'POST /auth/login': { email: '{{email}}', password: '{{password}}' },
  'POST /auth/change-password': { currentPassword: '{{password}}', password: '{{newPassword}}' },
  'POST /me/password': { currentPassword: '{{password}}', password: '{{newPassword}}' },
  'POST /auth/password/forgot': { identifier: '{{email}}' },
  'POST /auth/password/verify-otp': { code: '123456', resetToken: '{{resetToken}}' },
  'POST /auth/password/reset': { password: '{{newPassword}}', resetToken: '{{resetToken}}' },
  'PATCH /me': { name: '{{myName}}' },
  'POST /public/member-applications': { name: 'Postman Applicant', phone: '01700000098', nid: '', address: 'Dhaka', nominee: '', website: '' },
  'POST /public/payment-submissions': member,
  'POST /payments (member)': { ...member, transactionId: 'POSTMAN-002' },
  'POST /users': { name: 'Postman User', email: 'postman.user@example.test', role: 'viewer', status: 'inactive', password: 'Postman12345' },
  'PATCH /users/:id': { name: 'Postman User Updated' },
  'PUT /users/:id/password': { password: 'Postman67890' },
  'POST /user-permissions': { userId: '{{newUserId}}', status: 'active', pages: ['faqs', 'notices'] },
  'PATCH /user-permissions/:id': { status: 'inactive', pages: ['faqs'] },
  'PUT /role-actions': DEFAULT_ROLE_ACTIONS,
  'POST /members': { name: 'Postman Test Member', phone: '01700000097', nid: '', address: 'Dhaka', nominee: '', joinDate: '2026-11-01', monthly: 500, status: 'pending' },
  'PATCH /members/:id': { address: 'Chattogram' },
  'PATCH /members/:id/status': { status: 'active' },
  'PATCH /member-leads/:id': { note: 'Updated from Postman' },
  'POST /member-leads/:id/accept': { joinDate: '2026-11-01', monthly: 500 },
  'POST /payment-submissions': { memberId: '{{newMemberId}}', date: '2026-11-01', amount: 500, month: '2026-11', category: 'savings', type: 'Cash', trxId: '', description: 'Postman test' },
  'PATCH /payment-submissions/:id': { description: 'Updated from Postman' },
  'POST /payment-submissions/:id/review': { decision: 'rejected', note: 'Postman test' },
  'POST /payment-submissions/:id/reopen': { reason: 'Postman test' },
  'POST /admin/payments/:id/approve': { confirmAmountMismatch: false },
  'POST /admin/payments/:id/reject': { note: 'Postman test' },
  'POST /payments': { memberId: '{{newMemberId}}', month: '2026-10', amount: 500, paidDate: '2026-10-05', method: 'Cash', trxId: '', status: 'pending' },
  'PATCH /payments/:id': { paidDate: '2026-10-06' },
  'PATCH /payments/:id/status': { status: 'verified' },
  'POST /withdrawals': { memberId: '{{newMemberId}}', amount: 1, reason: 'Postman test', date: '2026-11-01', status: 'pending' },
  'PATCH /withdrawals/:id': { reason: 'Updated from Postman' },
  'PATCH /withdrawals/:id/status': { status: 'rejected' },
  'POST /investment-accounts': { name: 'Postman Test Account' },
  'PATCH /investment-accounts/:id': { name: 'Postman Test Account 2' },
  'POST /investments': { accountId: '{{newAccountId}}', investDate: '2026-11-01', amount: 1, monthlyProfit: 0, firstProfitMonth: '2026-12', status: 'planned' },
  'PATCH /investments/:id': { monthlyProfit: 0, status: 'planned' },
  'POST /profits': { accountId: '{{newAccountId}}', month: '2026-11', collected: 0, cost: 0, note: 'Postman test' },
  'PATCH /profits/:id': { note: 'Updated from Postman' },
  'POST /projects': { name: 'Postman Test Project', accountId: '{{newAccountId}}', businessType: 'Other', status: 'planned', startDate: '2026-11-01', location: 'Dhaka', contactPerson: '', contactMobile: '', showOnWebsite: 'no', summary: 'Postman test', description: '<p>Postman test</p>', images: [] },
  'PATCH /projects/:id': { summary: 'Updated from Postman' },
  'POST /page-names': { name: 'Postman Test Page', status: 'inactive' },
  'PATCH /page-names/:id': { name: 'Postman Test Page 2' },
  'POST /page-sections': { pageId: '{{newPageId}}', sectionHeader: 'Section 1', position: 1, title: 'Postman test', subTitle: '', description: '<p>Hello</p>', images: [], status: 'inactive' },
  'PATCH /page-sections/:id': { title: 'Updated from Postman' },
  'POST /faqs': { question: 'Postman test question?', answer: 'Postman test answer.', published: 'no' },
  'PATCH /faqs/:id': { answer: 'Updated from Postman.' },
  'POST /notices': { title: 'Postman test', body: 'Postman test notice', date: '2026-11-27', published: 'no' },
  'PATCH /notices/:id': { title: 'Updated from Postman' },
  'PUT /settings': { dueDay: 10 },
  'PUT /admin/settings/profit-sheet-through': { month: '2026-10' },
};

// Path prefix -> variable name. GET uses "{{name}}Id" (filled by the list), changes use "new{{Name}}Id".
const resources = {
  members: 'member', 'member-leads': 'lead', payments: 'payment', 'payment-submissions': 'submission', 'admin/payments': 'submission', withdrawals: 'withdrawal',
  'investment-accounts': 'account', investments: 'investment', profits: 'profit', projects: 'project', 'page-names': 'page',
  'page-sections': 'section', faqs: 'faq', notices: 'notice', users: 'user', 'user-permissions': 'permission', 'member-accounts': 'websiteAccount',
};
const capital = value => value[0].toUpperCase() + value.slice(1);
const prefixOf = path => path.startsWith('/admin/payments') ? 'admin/payments' : path.split('/')[1];

const querySamples = { page: '1', limit: '10', search: '', format: 'csv', month: '2026-11', year: '2026', from: '2026-01-01', to: '2026-12-31',
  memberId: '{{memberId}}', accountId: '{{accountId}}', userId: '{{userId}}', pageId: '{{pageId}}', ignoreId: '{{sectionId}}',
  sectionHeader: 'Section 1', businessType: 'Other', type: 'bKash', method: 'bkash', account: 'Mukto', user: '', action: '', entity: 'members', q: '', confirm: 'true' };

const script = lines => [{ listen: 'test', script: { type: 'text/javascript', exec: lines } }];
const save = (variable, expression) => [
  'if (pm.response.code < 300) {',
  '  const body = pm.response.json();',
  `  const value = ${expression};`,
  `  if (value) pm.collectionVariables.set('${variable}', value);`,
  '}',
];
function testsFor(route) {
  const { method, path } = route;
  if (['/auth/login', '/auth/refresh'].includes(path)) return save('token', 'body.data.accessToken');
  if (['/auth/change-password', '/me/password'].includes(path)) return [
    'if (pm.response.code < 300) {',
    "  pm.collectionVariables.set('token', pm.response.json().data.accessToken);",
    "  pm.collectionVariables.set('password', pm.collectionVariables.get('newPassword'));",
    '}',
  ];
  if (path === '/auth/logout') return ["if (pm.response.code < 300) pm.collectionVariables.set('token', '');"];
  if (path === '/auth/signup') return save('newWebsiteAccountId', 'body.data.user.id');
  if (path === '/auth/password/forgot') return save('resetToken', 'body.data.resetToken');
  if (path === '/uploads') return save('fileName', "body.data.url.split('/').pop()");
  // Leads come from the website form, so changes are aimed at the one Postman's own application made.
  if (method === 'get' && path === '/member-leads') return [
    ...save('leadId', 'body.data[0] && body.data[0].id'),
    ...save('newLeadId', "(body.data.find(row => row.name === 'Postman Applicant') || {}).id"),
  ];
  const name = resources[prefixOf(path)];
  if (!name || path.includes(':')) return null;
  if (method === 'post' && path === `/${prefixOf(path)}`) return save(`new${capital(name)}Id`, 'body.data.id');
  if (method === 'get' && !path.endsWith('next-position')) return save(`${name}Id`, 'body.data[0] && body.data[0].id');
  return null;
}

function request(route, { name = route.summary, bodyKey } = {}) {
  const { method, path } = route;
  const resource = resources[prefixOf(path)];
  const read = method === 'get';
  // Approving a website account is aimed at one found in the list; everything else changes only Postman's own records.
  const reviewAccount = /^\/member-accounts\/:id\/(approve|reject)$/.test(path);
  const idValue = resource ? `{{${read || reviewAccount ? `${resource}Id` : `new${capital(resource)}Id`}}}` : '';
  const values = { ':id': idValue, ':key': '2026-11', ':slug': path.includes('pages') ? 'home' : 'getech', ':name': '{{fileName}}' };
  const segments = path.split('/').filter(Boolean);
  const variable = segments.filter(part => part.startsWith(':')).map(part => ({ key: part.slice(1), value: values[part] }));
  const schema = route.query?.shape || {};
  const query = Object.keys(schema).map(key => {
    const field = schema[key];
    const options = field.options || field.unwrap?.().options || field.unwrap?.().unwrap?.().options;
    const required = !field.safeParse(undefined).success;
    return { key, value: querySamples[key] ?? options?.[0] ?? '', disabled: !(required || (method === 'delete' && key === 'confirm')),
      ...(options ? { description: options.join(' | ') } : {}) };
  });
  const enabled = query.filter(item => !item.disabled);
  const body = bodies[bodyKey || `${method.toUpperCase()} ${path}`];
  const open = !route.access || route.access === 'public';
  const tests = testsFor(route);
  return {
    name,
    request: {
      method: method.toUpperCase(),
      description: `${route.summary}.`,
      ...(open ? { auth: { type: 'noauth' } } : {}),
      header: body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
      url: {
        raw: `{{baseUrl}}/api/v1${path}${enabled.length ? `?${enabled.map(item => `${item.key}=${item.value}`).join('&')}` : ''}`,
        host: ['{{baseUrl}}'], path: ['api', 'v1', ...segments], ...(query.length ? { query } : {}), ...(variable.length ? { variable } : {}),
      },
      ...(body ? { body: { mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } } } : {}),
      ...(route.upload ? { body: { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: [], description: 'Choose a JPG, PNG or WEBP image (max 5 MB)' }] } } : {}),
    },
    ...(tests ? { event: script(tests) } : {}),
  };
}

/** `routes` are the main addresses only (duplicate "/admin/..." ones already removed). */
export function postmanCollection(routes) {
  const find = (method, path) => routes.find(route => route.method === method && route.path === path);
  // PUT does the same as PATCH wherever both exist.
  const list = routes.filter(route => !(route.method === 'put' && find('patch', route.path)));
  const health = path => ({ name: path === '/health' ? 'Is the server running?' : 'Is the database connected?',
    request: { method: 'GET', auth: { type: 'noauth' }, url: { raw: `{{baseUrl}}/api/v1${path}`, host: ['{{baseUrl}}'], path: ['api', 'v1', path.slice(1)] } } });
  const start = ['POST /auth/login', 'GET /auth/me', 'POST /auth/change-password', 'POST /auth/refresh'];
  const key = route => `${route.method.toUpperCase()} ${route.path}`;
  const isStart = route => start.includes(key(route));
  const isLogout = route => route.path === '/auth/logout';
  const isAccount = route => route.tag === 'Auth' && !isStart(route) && !isLogout(route);
  const isPublic = route => route.tag !== 'Auth' && (!route.access || route.access === 'public');
  const memberOnly = route => route.access === 'member' || ['/payments/mine', '/public/payment-submissions'].includes(route.path);
  const isAdmin = route => Array.isArray(route.access) || ['staff', 'superadmin'].includes(route.access) || ['GET /members', 'GET /members/:id', 'GET /dashboard'].includes(key(route));
  const cleanupOrder = ['projects', 'investments', 'investment-accounts', 'page-sections', 'page-names', 'faqs', 'notices', 'user-permissions', 'users', 'member-accounts', 'member-leads', 'members'];

  const admin = new Map();
  for (const route of list.filter(item => isAdmin(item) && item.method !== 'delete')) {
    if (!admin.has(route.tag)) admin.set(route.tag, []);
    admin.get(route.tag).push(request(route));
    if (key(route) === 'PATCH /payments/:id/status') {
      admin.get(route.tag).splice(-3, 0, request({ ...find('post', '/payments'), access: ['payments', 'create'] }, { name: 'Record a deposit' }));
    }
  }
  const member = list.filter(memberOnly).map(route => request(route));
  member.push(request(find('post', '/payments'), { name: 'Member submits a payment', bodyKey: 'POST /payments (member)' }));
  const cleanup = list.filter(route => route.method === 'delete')
    .sort((a, b) => cleanupOrder.indexOf(prefixOf(a.path)) - cleanupOrder.indexOf(prefixOf(b.path)))
    .map(route => request(route, { name: `${route.tag}: ${route.summary}` }));

  const variables = { baseUrl: 'http://localhost:5001', email: '', password: '', newPassword: '', myName: '', token: '', resetToken: '', fileName: '' };
  for (const name of new Set(Object.values(resources))) { variables[`${name}Id`] = ''; variables[`new${capital(name)}Id`] = ''; }

  return {
    info: {
      name: 'Bondhu Sanchay API',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description: [
        '1. In **Variables**, set `email` and `password`, then Save.',
        '2. Run **1. Start here → Log in**. The token is saved automatically.',
        '3. A temporary password must be changed first: set `newPassword` and run **Change own password**.',
        '',
        '**POST, PATCH and DELETE requests write to the database in your .env file.** Payments, profit records and withdrawals can never be deleted, so try those on the local database.',
        'Edit and delete requests use the `new...Id` variables, filled when you create a record from Postman. List requests fill the `...Id` variables used for reading.',
      ].join('\n'),
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
    variable: Object.entries(variables).map(([name, value]) => ({ key: name, value })),
    item: [
      { name: '1. Start here', item: [health('/health'), health('/ready'), ...start.map(name => request(list.find(route => key(route) === name)))] },
      { name: '2. Public website (no login)', item: list.filter(isPublic).map(route => request(route)) },
      { name: '3. Website account and member', item: [...list.filter(isAccount).map(route => request(route)), ...member] },
      { name: '4. Admin panel', item: [...admin].map(([name, item]) => ({ name, item })) },
      { name: '5. Delete test records', item: cleanup },
      { name: '6. Log out', item: list.filter(isLogout).map(route => request(route)) },
    ],
  };
}

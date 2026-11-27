# Task: connect the Bondhu Sanchay public website to the real API

You are working in the website repository `bondhu-sanchay-uat` (Next.js, static export). All of its
data is hard-coded in `src/data/*` and its login is a browser-only demo. Replace both with the API
described here. **The backend is finished; do not change it.** This file is everything you need.

- Live API: `https://bondhu-sanchay-backend.vercel.app/api/v1`
- Local API: `http://localhost:5001/api/v1`
- All endpoints as JSON schema: `GET /openapi.json`

## 0. Rules

- Keep the design, routes (except section 6) and wording. Change only what the API requires.
- Show money, dues, shares and totals as the API returns them. Do not rebuild the calculations in the browser.
- Every page that loads data needs loading, empty and error states.
- When `settings.publicShowMoney` is false, public responses omit money fields: hide those blocks.
- The contact form's message inbox does not exist. Do not call a `/messages` endpoint.
- Ask before assuming anything unclear. Stop after each step in section 9 and report.

## 1. Setup

1. `.env.local` (and the same variable in the website's hosting settings):
   `NEXT_PUBLIC_API_URL=https://bondhu-sanchay-backend.vercel.app/api/v1`
2. In the CSP in `src/app/layout.js`, add the API origin (taken from that variable) to `connect-src`
   and `img-src`. Keep the existing image hosts.
3. The API accepts browsers only from listed origins. `http://localhost:3000` and `http://localhost:3001`
   are allowed. Tell the owner to add the deployed website address to `CORS_ORIGIN` on the API host.

## 2. API client: create `src/lib/api.js` with exactly this code

It has been run against the backend, including sign-up, approval, payments and password reset.

```js
// src/lib/api.js — every call the website makes to the Bondhu Sanchay API.
const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api/v1';
const TOKEN = 'bs_token', USER = 'bs_user', RESET = 'bs_reset';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || 'Something went wrong. Please try again.');
    this.status = status; // 0 when the server could not be reached
    this.code = body?.error?.code || 'NETWORK';
    this.fields = body?.errors || {}; // { fieldName: message }
  }
}

// ---------- Session (kept for this browser tab only) ----------
const store = {
  get: (key) => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } },
  set: (key, value) => { try { value ? sessionStorage.setItem(key, JSON.stringify(value)) : sessionStorage.removeItem(key); } catch {} },
};
const announce = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('bs-auth')); };
/** The signed-in user as last seen from the server, or null. Safe to call while rendering. */
export const currentUser = () => (store.get(TOKEN) ? store.get(USER) : null);
function saveSession(token, user) { store.set(TOKEN, token); if (user !== undefined) store.set(USER, user); announce(); }
export function clearSession() { store.set(TOKEN, null); store.set(USER, null); announce(); }

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const token = auth ? store.get(TOKEN) : null;
  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { message: 'Cannot reach the server. Check your connection.' });
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && token) clearSession(); // expired after 30 idle minutes
    throw new ApiError(response.status, json);
  }
  return json.data;
}
const get = (path) => request(path);
const mine = (path) => request(path, { auth: true });
const send = (method, path, body, auth = false) => request(path, { method, body, auth });
const query = (values) => {
  const text = new URLSearchParams(Object.entries(values).filter(([, value]) => value)).toString();
  return text ? `?${text}` : '';
};

// ---------- Visitors (no login) ----------
export const getSiteContent = () => get('/public/site-content');
export const getSettings = () => get('/public/settings');
export const getSummary = () => get('/public/summary');
export const getPublicMembers = () => get('/public/members');
export const getProjects = () => get('/public/projects');
export const getProject = (slug) => get(`/public/projects/${encodeURIComponent(slug)}`);
export const getFaqs = () => get('/public/faqs');
export const getNotices = () => get('/public/notices');
export const getPage = (slug) => get(`/public/pages/${encodeURIComponent(slug)}`);
export const applyForMembership = ({ name, phone }) => send('POST', '/public/member-applications', { name, phone });

// ---------- Account ----------
async function startSession(path, body) {
  const data = await send('POST', path, body);
  saveSession(data.accessToken, data.user);
  return data.user;
}
export const signup = ({ name, email, phone, password, agreeToTerms }) =>
  startSession('/auth/signup', { name, email, phone, password, agreeToTerms });
export const login = (identifier, password) => startSession('/auth/login', { identifier, password });
export async function refreshUser() {
  const { user } = await mine('/auth/me');
  store.set(USER, user); announce();
  return user;
}
export async function logout() {
  try { await send('POST', '/auth/logout', undefined, true); } catch {}
  clearSession();
}
export async function updateProfile(changes) { // { name?, email?, avatar? }
  const user = await send('PATCH', '/me', changes, true);
  store.set(USER, user); announce();
  return user;
}
export async function changePassword(current, next) {
  const data = await send('POST', '/me/password', { current, next }, true);
  saveSession(data.accessToken); // the old token stops working
}

// ---------- Forgot password ----------
export async function requestCode(identifier) {
  const data = await send('POST', '/auth/password/forgot', { identifier });
  const state = { ident: identifier.trim(), token: data.resetToken, verified: false,
    expiresAt: Date.now() + data.expiresInSeconds * 1000, resendAt: Date.now() + data.resendInSeconds * 1000 };
  store.set(RESET, state);
  return state;
}
export const getResetState = () => store.get(RESET);
export const clearReset = () => store.set(RESET, null);
export async function verifyCode(code) {
  const state = getResetState();
  await send('POST', '/auth/password/verify-otp', { code: code.trim(), resetToken: state?.token });
  store.set(RESET, { ...state, verified: true, expiresAt: Date.now() + 10 * 60 * 1000 });
}
export async function resetPassword(password) {
  await send('POST', '/auth/password/reset', { password, resetToken: getResetState()?.token });
  clearReset();
}

// ---------- Signed-in members ----------
export const getMyAccount = () => mine('/me/account');
export const getDashboard = (month) => mine(`/dashboard${query({ month })}`);
export const getMembers = () => mine('/members?limit=500&sort=sl&order=asc');
export const getMember = (id) => mine(`/members/${encodeURIComponent(id)}`);
export const getMonthlyReport = (year) => mine(`/reports/monthly${query({ year })}`);
export const getFundSummary = () => mine('/reports/fund-summary');
export const getMonth = (key) => mine(`/months/${key}`);
export const getProfitSheet = () => mine('/profit-sheet');
export const submitPayment = ({ paymentDate, amount, months, category, method, transactionId, payerAccount, description }) =>
  send('POST', '/payments', { paymentDate, amount, months, category, method, transactionId, payerAccount, description }, true);
export const getMyPayments = () => mine('/payments/mine?limit=500&sort=submittedAt&order=desc');
```

## 3. Conventions

- The client returns `data`. A failure throws `ApiError { status, code, message, fields }`:
  show `message`, and put `fields.<name>` under the matching input (`trxId` means the transaction ID).
- Money is whole taka (integers). Months are `YYYY-MM`, dates `YYYY-MM-DD`.
- Login uses a token kept in `sessionStorage`; it ends after 30 idle minutes or 24 hours. A 401 clears
  it and fires the `bs-auth` event the site already listens to.

| status | code | Meaning |
| --- | --- | --- |
| 0 | `NETWORK` | Server unreachable |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS` | Sign in again, or wrong login |
| 403 | `MEMBER_REQUIRED` | Account not yet approved as a member |
| 403 | `PASSWORD_CHANGE_REQUIRED` | Staff account with a temporary password: ask to change it |
| 403 | `ORIGIN_NOT_ALLOWED` | Website address missing from `CORS_ORIGIN` |
| 409 | `ACCOUNT_EXISTS`, `DUPLICATE_TRANSACTION` | Already used |
| 422 | `VALIDATION_ERROR` | See `fields` |
| 429 | `LOCKED`, `RATE_LIMITED`, `RESEND_TOO_SOON` | Wait; show `message` |

## 4. All website endpoints

| Function | Method and path | Who | Used by |
| --- | --- | --- | --- |
| `getSiteContent` | GET `/public/site-content` | Visitor | settings, pages, FAQs, notices, projects in one call |
| `getSettings` | GET `/public/settings` | Visitor | Hero, payment form, month limits |
| `getSummary` | GET `/public/summary` | Visitor | Hero, StatsStrip |
| `getPublicMembers` | GET `/public/members` | Visitor | MemberGrid |
| `getProjects` | GET `/public/projects` | Visitor | home grid, InvestmentExplorer |
| `getProject` | GET `/public/projects/:slug` | Visitor | project page |
| `getFaqs` | GET `/public/faqs` | Visitor | FaqList |
| `getNotices` | GET `/public/notices` | Visitor | not shown yet: ask before adding UI |
| `getPage` | GET `/public/pages/:slug` | Visitor | legal pages, page text |
| `applyForMembership` | POST `/public/member-applications` | Visitor | ContactForm |
| `signup` | POST `/auth/signup` | Visitor | AuthForm |
| `login` | POST `/auth/login` | Visitor | AuthForm |
| `refreshUser` | GET `/auth/me` | Signed in | useRequireUser, header |
| `logout` | POST `/auth/logout` | Signed in | UserMenu, Dashboard, ProfileView |
| `updateProfile` | PATCH `/me` | Signed in | ProfileView |
| `changePassword` | POST `/me/password` | Signed in | ProfileView |
| `requestCode` | POST `/auth/password/forgot` | Visitor | ForgotPasswordForm |
| `verifyCode` | POST `/auth/password/verify-otp` | Visitor | ForgotPasswordForm |
| `resetPassword` | POST `/auth/password/reset` | Visitor | ForgotPasswordForm |
| `getMyAccount` | GET `/me/account` | Signed in | PaymentForm, ProfileView |
| `submitPayment` | POST `/payments` | Signed in | PaymentForm |
| `getMyPayments` | GET `/payments/mine` | Signed in | PaymentHistory |
| `getDashboard` | GET `/dashboard?month=` | Member | Dashboard, MonthDetail |
| `getMembers` | GET `/members` | Member | MemberDirectory, MemberGrid |
| `getMember` | GET `/members/:id` | Member | MemberDetail, DepositHistory, MyAccount |
| `getMonthlyReport` | GET `/reports/monthly?year=` | Member | Reports |
| `getFundSummary` | GET `/reports/fund-summary` | Member | total profit, total deposited |
| `getMonth` | GET `/months/:key` | Member | one month (also inside the dashboard) |
| `getProfitSheet` | GET `/profit-sheet` | Member | ProfitSheet |

"Member" means an approved member, or staff who may see the dashboard.
CSV downloads can stay as they are (built in the browser from the loaded data).

## 5. Page by page

### Accounts (replaces `src/lib/auth.js`)

Keep the pure helpers (`normPhone`, `localPhone`, `validPhone`, `validEmail`, `strongPass`, `safeNext`,
`nextFromUrl`, `withNext`). Delete the hashing and local storage code.

- `AuthForm`: `api.signup({ name, email, phone, password, agreeToTerms: true })` and
  `api.login(identifier, password)` in `try/catch`. `api.currentUser()` replaces `currentUser()`.
  The client fires `bs-auth` itself.
- `user`: `{ id, name, email, phone, avatar, role, membershipStatus, memberId, createdAt }`.
  `createdAt` replaces `joined`.
- `membershipStatus` is `approved`, `pending`, `rejected` or `none`. A new account must be approved by
  the admin. For `role === 'member'` and not approved, do not call member endpoints: show
  "Your account is waiting for approval" (`pending`) or "Your mobile number isn't in the member list"
  (`none`, `rejected`). Call `refreshUser()` when a protected page opens, so approval shows up.
- `ForgotPasswordForm`: `requestCode`, `verifyCode`, `resetPassword`, `getResetState`, `clearReset`.
  Remove the demo code box and demo notes. On `RESET_EXPIRED` go back to the first step.
- `ProfileView`: `updateProfile` is now async and throws. `avatar` accepts the resized data URL or `''`.

### Public pages

**Projects** (`InvestmentCard`, `InvestmentExplorer`, home grid, project page). Map each API project:

| Website field | API field |
| --- | --- |
| `id`, `name`, `category`, `partner`, `facts`, `placeholder`, `image`, `imageAlt`, `imageIsStock` | same name |
| `description` (short) | `summary` |
| `about` | `description` — sanitized HTML, render with `dangerouslySetInnerHTML` |
| `status` | `running` → `Ongoing`, `completed` → `Completed`, `planned` → `Planned` |
| `amount`, `profit` | same name (absent when money is hidden) |
| "invested since" | `monthLabel(investedSince.slice(0, 7))` |
| `imageClass` | not in the API: keep a small local map by slug if needed |

Categories are the distinct `category` values. `tranches` come only from `getProject`.

**Home.** `getSummary`: `members`, `collected`, `invested`, `profit`, `initials` (avatars).
"Profit figures through" is `settings.profitThroughMonth`.

**Members.** Visitors: `getPublicMembers` (`phoneMasked`, `initials`). Approved members: `getMembers` (`phone`).

**FAQ.** `getFaqs()` returns `[{ question, answer }]`.

**Legal pages.** `getPage('privacy-policy' | 'terms-and-conditions')`. Sections are already ordered. The
`Section 1` row is the page header (`title`, `subTitle` = eyebrow, `description` = intro); each other row
is a heading (`title`) with HTML `description`. `refund-policy` is not in the database yet: if the call
returns 404, keep the current static text. The API has no "last updated" date for these pages: ask the owner.

**Other page text** (optional, last step). Slugs and sections: `home` (1 hero, 2 stat labels, 3 steps
heading, 4 steps, 5 investments heading, 6 promise, 7 promises, 8 FAQ intro), `about` (1 hero, 2 why,
3 values heading, 4 values), `members` (1 hero, 2 perks heading, 3 perks), `contact` (1 hero, 2 aside,
3 steps), `investments`, `reports`, `faq` (1 hero), `footer` (1 brand text, 2 join, 3 banner).
Rows sharing a `sectionHeader` repeat in `position` order. Icons stay in code. Fall back to the
current text when a section is missing.

**ContactForm.** Only for "Becoming a member", call `applyForMembership({ name, phone })` and show its
success. For other subjects keep the demo notice. Update the "nothing is sent" wording accordingly.

### Payment form

- Fee: `settings.monthlyAmount` (or the member's `monthly`). First month: `settings.collectionStart`.
  Latest month: `settings.lastCollectionMonth`.
- `getMyAccount()` gives `member` (null until approved) and `account.dueMonths`.
- `submitPayment({ paymentDate, amount, months, category, method, transactionId, payerAccount, description })`
  with `amount` as a number. `method`: `bkash | nagad | bank | cash | other`. Keep the form validation and
  the login draft; remove the local duplicate check. The result is always `pending`.
- `getMyPayments()` rows have `paymentDate, category, months, amount, method, transactionId, status
  (pending | approved | rejected), reviewNote`: the shape `PaymentHistory` already uses.

### Member pages

**Dashboard** (`getDashboard(month)`, call again when the month changes; first month is `lastCollectionMonth`):

| UI | Data |
| --- | --- |
| my account | `me` (null for staff): `paidTotal, paidMonths[], dueMonths[], advanceMonths[], dueTotal, ratio, profitShare, currentValue` |
| group stats | `totalCollection`, `profit`, `totalMembers`, `selectedMonth.paid` |
| calendar dot | `monthlySeries` entry: `unpaid === 0` is complete |
| MonthDetail | `selectedMonth { month, paid, unpaid, collected, expected, rows[{ memberId, sl, name, status, amount }] }` |
| bar charts | `monthlySeries[].collected`, `monthlySeries[].profit` |
| fund growth | `charts.cumulativeFund[{ month, value }]` |
| donut | `sectorSplit[{ sector, invested }]` + `fund.cash` (this also covers money without a project page); centre `fund.collected + fund.profit` |
| investment table | `investments[{ name, category, invested, profit, yourShare, status }]`; `yourShare` null → "—" |
| project profit subtitle | `fund.profit - fund.personalProfit` |

`paidMonths`, `dueMonths` and `advanceMonths` are **arrays**: the old counts are their `length`
(`paidMonths` includes advances).

**MemberDirectory.** `getMembers()` rows: `sl, name, phone, paidTotal, paidMonths[], dueMonths[], dueTotal`.
"Total deposited": `getFundSummary().collected`.

**MemberDetail.** `getMember(id)`: the row plus `account` (as `me` above) and
`history[{ month, status, amount, paidDate, advance }]`. Deposit history is `history` without
`advance`, newest first. "Joined": `joinDate`, else `settings.collectionStart`. Total profit for
MyAccount: `getFundSummary().profit`.

**Reports.** `getMonthlyReport()`: `rows[{ month, collected, profit, total }]` and
`summary { collected, profit, invested, cash, advance, personalProfit }`. Dated personal profit is
already inside its month, so the footnote should mention only `advance`.

**ProfitSheet.** `getProfitSheet()`:
- table and cards: `projects.filter(p => !p.personal)`. `partner` = `account`, `amount` = `invested`,
  `profit` = `net`, `months[].key` = `month`, "collected" = `status === 'collected'`;
  `monthsRun, monthsCollected, monthlyProfit, gross, cost, pending, tranches` have the same meaning.
- `id`, `category`, `image`, `imageAlt`, `status`: from `getProjects()` matched on `projects[0].slug`.
  A row with no linked project has none: show it without image or link.
- footer and totals: `totals`; "through": `through`; columns: `months`; costs: `costs[{ project, month, amount, note }]`.

## 6. New projects and members without rebuilding

A static export cannot create pages for records added later. Replace
`app/investments/[id]` with `app/investments/view` (`?id=slug`) and `app/dashboard/members/[id]` with
`app/dashboard/members/view` (`?id=`). Read the id with `useSearchParams` in a client component wrapped in
`<Suspense>`. Update every link. Member ids are now database ids, not `m01`.

## 7. Real response examples

Recorded from the backend with made-up data. Long lists are cut to the first item.

### getSettings

```json
{
 "orgName": "Bondhu Sanchay Parishad",
 "tagline": "Save together, grow together",
 "about": "A community-based savings and joint investment platform.",
 "phone": "01700000000",
 "monthlyAmount": 500,
 "dueDay": 10,
 "collectionStart": "2026-01",
 "lastCollectionMonth": "2026-03",
 "profitThroughMonth": "2026-03",
 "publicShowMoney": true
}
```

### getSummary

```json
{
 "members": 2,
 "initials": [
  "RU",
  "KM"
 ],
 "collected": 1500,
 "invested": 1000,
 "profit": 80
}
```

### getProjects

```json
[
 {
  "id": "sample-shop",
  "slug": "sample-shop",
  "name": "Sample Shop",
  "businessType": "Retail Shop",
  "category": "Retail Shop",
  "status": "running",
  "startDate": "2026-01-01",
  "location": "Dhaka",
  "summary": "A short summary shown on the card.",
  "description": "<p>Longer text about the business.</p>",
  "images": [
   "https://images.unsplash.com/photo-sample"
  ],
  "image": "https://images.unsplash.com/photo-sample",
  "imageAlt": "Shop front",
  "imageIsStock": false,
  "placeholder": false,
  "facts": [
   [
    "Business type",
    "Shop"
   ]
  ],
  "sortOrder": 0,
  "partner": "Partner A",
  "amount": 1000,
  "monthlyProfit": 100,
  "profit": 80,
  "investedSince": "2026-01-01"
 }
]
```

### getProject

```json
{
 "id": "sample-shop",
 "slug": "sample-shop",
 "name": "Sample Shop",
 "businessType": "Retail Shop",
 "category": "Retail Shop",
 "status": "running",
 "startDate": "2026-01-01",
 "location": "Dhaka",
 "summary": "A short summary shown on the card.",
 "description": "<p>Longer text about the business.</p>",
 "images": [
  "https://images.unsplash.com/photo-sample"
 ],
 "image": "https://images.unsplash.com/photo-sample",
 "imageAlt": "Shop front",
 "imageIsStock": false,
 "placeholder": false,
 "facts": [
  [
   "Business type",
   "Shop"
  ]
 ],
 "sortOrder": 0,
 "partner": "Partner A",
 "amount": 1000,
 "monthlyProfit": 100,
 "profit": 80,
 "investedSince": "2026-01-01",
 "tranches": [
  {
   "date": "2026-01-01",
   "amount": 1000,
   "monthlyProfit": 100,
   "firstMonth": "2026-02"
  }
 ]
}
```

### getPublicMembers

```json
[
 {
  "id": "6b09c1748bf50c555e191c55",
  "sl": 1,
  "name": "Rahim Uddin",
  "initials": "RU",
  "phoneMasked": "0170•••0001",
  "phone_masked": "0170•••0001"
 }
]
```

### getFaqs

```json
[
 {
  "question": "How much do I save each month?",
  "answer": "Every member contributes 500 taka a month."
 }
]
```

### getNotices

```json
[
 {
  "title": "Meeting",
  "body": "Friday evening.",
  "date": "2026-03-01"
 }
]
```

### getPage

```json
{
 "name": "Privacy Policy",
 "slug": "privacy-policy",
 "sections": [
  {
   "sectionHeader": "Section 1",
   "position": 1,
   "title": "Privacy Policy",
   "subTitle": "Your data, your control",
   "description": "<p>Intro text.</p>",
   "images": []
  }
 ]
}
```

### getSiteContent

```json
{
 "updatedAt": "2026-11-27T17:44:21.063Z",
 "settings": "…same as getSettings",
 "summary": "…same as getSummary",
 "pages": [
  {
   "name": "Privacy Policy",
   "slug": "privacy-policy",
   "sections": [
    {
     "sectionHeader": "Section 1",
     "position": 1,
     "title": "Privacy Policy",
     "subTitle": "Your data, your control",
     "description": "<p>Intro text.</p>",
     "images": []
    }
   ]
  }
 ],
 "faqs": "…",
 "notices": "…",
 "projects": "…same as getProjects"
}
```

### signup (returns the user; `login` and `refreshUser` return the same shape)

```json
{
 "id": "6b09c1758bf50c555e191c73",
 "name": "Rahim Uddin",
 "email": "rahim@example.test",
 "phone": "01700000001",
 "role": "member",
 "status": "active",
 "avatar": "",
 "mustChangePassword": false,
 "membershipStatus": "pending",
 "memberId": null,
 "createdAt": "2026-11-27T17:44:21.113Z"
}
```

### getMyAccount before approval

```json
{
 "member": null,
 "membershipStatus": "pending"
}
```

### getMyAccount

```json
{
 "member": {
  "id": "6b09c1748bf50c555e191c55",
  "sl": 1,
  "name": "Rahim Uddin",
  "phone": "01700000001",
  "joinDate": "2026-01-01",
  "monthly": 500,
  "status": "active"
 },
 "membershipStatus": "approved",
 "account": {
  "expectedMonths": [
   "2026-01",
   "2026-02",
   "2026-03"
  ],
  "expectedCount": 3,
  "paidMonths": [
   "2026-01",
   "2026-02"
  ],
  "paidCount": 2,
  "dueMonths": [
   "2026-03"
  ],
  "advanceMonths": [],
  "paidAmount": 1000,
  "dueAmount": 500,
  "dueTotal": 500,
  "paidTotal": 1000,
  "withdrawn": 0,
  "ratio": 0.6666666666666666,
  "profitShare": 53,
  "currentValue": 1053
 }
}
```

### submitPayment

```json
{
 "id": "6b09c1758bf50c555e191c77",
 "userId": "6b09c1758bf50c555e191c73",
 "memberId": "6b09c1748bf50c555e191c55",
 "memberName": "Rahim Uddin",
 "date": "2026-03-05",
 "amount": 500,
 "months": [
  "2026-03"
 ],
 "category": "savings",
 "type": "bkash",
 "trxId": "ABC12345",
 "payerAccount": "01700000001",
 "description": "",
 "status": "pending",
 "source": "website",
 "submittedAt": "2026-11-27T17:44:21.219Z",
 "reviewNote": "",
 "createdAt": "2026-11-27T17:44:21.219Z",
 "updatedAt": "2026-11-27T17:44:21.219Z",
 "member": "Rahim Uddin",
 "month": "2026-03",
 "method": "bkash",
 "paymentDate": "2026-03-05",
 "transactionId": "ABC12345",
 "reviewedBy": null,
 "reviewedById": null
}
```

### getMyPayments

```json
[
 {
  "id": "6b09c1758bf50c555e191c77",
  "userId": "6b09c1758bf50c555e191c73",
  "memberId": "6b09c1748bf50c555e191c55",
  "memberName": "Rahim Uddin",
  "date": "2026-03-05",
  "amount": 500,
  "months": [
   "2026-03"
  ],
  "category": "savings",
  "type": "bkash",
  "trxId": "ABC12345",
  "payerAccount": "01700000001",
  "description": "",
  "status": "pending",
  "source": "website",
  "submittedAt": "2026-11-27T17:44:21.219Z",
  "reviewNote": "",
  "createdAt": "2026-11-27T17:44:21.219Z",
  "updatedAt": "2026-11-27T17:44:21.219Z",
  "member": "Rahim Uddin",
  "month": "2026-03",
  "method": "bkash",
  "paymentDate": "2026-03-05",
  "transactionId": "ABC12345",
  "reviewedBy": null,
  "reviewedById": null
 }
]
```

### getDashboard

```json
{
 "lastCollectionMonth": "2026-03",
 "profitThroughMonth": "2026-03",
 "me": {
  "memberId": "6b09c1748bf50c555e191c55",
  "name": "Rahim Uddin",
  "expectedMonths": [
   "2026-01",
   "2026-02",
   "2026-03"
  ],
  "expectedCount": 3,
  "paidMonths": [
   "2026-01",
   "2026-02"
  ],
  "paidCount": 2,
  "dueMonths": [
   "2026-03"
  ],
  "advanceMonths": [],
  "paidAmount": 1000,
  "dueAmount": 500,
  "dueTotal": 500,
  "paidTotal": 1000,
  "withdrawn": 0,
  "ratio": 0.6666666666666666,
  "profitShare": 53,
  "currentValue": 1053
 },
 "totalMembers": 2,
 "activeMembers": 2,
 "totalCollection": 1500,
 "selectedMonth": {
  "month": "2026-02",
  "paid": 1,
  "unpaid": 1,
  "collected": 500,
  "expected": 1000,
  "rows": [
   {
    "memberId": "6b09c1748bf50c555e191c55",
    "sl": 1,
    "name": "Rahim Uddin",
    "status": "paid",
    "amount": 500,
    "expected": 500
   }
  ]
 },
 "monthlySeries": [
  {
   "month": "2026-01",
   "paid": 2,
   "unpaid": 0,
   "collected": 1000,
   "expected": 1000,
   "profit": 0,
   "total": 1000
  }
 ],
 "totalDue": 1500,
 "owingMembersCount": 2,
 "invested": 1000,
 "investments": [
  {
   "id": "6b09c1748bf50c555e191c65",
   "slug": "sample-shop",
   "name": "Sample Shop",
   "category": "Retail Shop",
   "partner": "Partner A",
   "status": "running",
   "invested": 1000,
   "monthlyProfit": 100,
   "profit": 80,
   "yourShare": 720
  }
 ],
 "sectorSplit": [
  {
   "sector": "Retail Shop",
   "invested": 1000
  }
 ],
 "profit": 80,
 "pendingProfit": 100,
 "paidOut": 0,
 "allTotal": 1580,
 "cash": 580,
 "fund": {
  "collected": 1500,
  "profit": 80,
  "invested": 1000,
  "cash": 580,
  "advance": 0,
  "personalProfit": 0,
  "paidOut": 0
 },
 "charts": {
  "monthlyCollection": [
   {
    "month": "2026-01",
    "label": "Jan 2026",
    "value": 1000
   }
  ],
  "collectionGrowth": [
   {
    "month": "2026-01",
    "label": "Jan 2026",
    "value": 1000
   }
  ],
  "duesByMember": [
   {
    "memberId": "6b09c1748bf50c555e191c57",
    "member": "Karim Mia",
    "due": 1000,
    "months": 2
   }
  ],
  "collectionStatus": {
   "collected": 1500,
   "due": 1500,
   "membersWithoutDues": 0,
   "membersWithDues": 2
  },
  "investedByAccount": [
   {
    "account": "Partner A",
    "invested": 1000
   }
  ],
  "monthlyProfit": [
   {
    "month": "2026-02",
    "label": "Feb 2026",
    "value": 80
   }
  ],
  "cumulativeFund": [
   {
    "month": "2026-01",
    "label": "Jan 2026",
    "value": 1000
   }
  ]
 }
}
```

### getMembers

```json
[
 {
  "id": "6b09c1748bf50c555e191c55",
  "sl": 1,
  "name": "Rahim Uddin",
  "phone": "01700000001",
  "status": "active",
  "joinDate": "2026-01-01",
  "monthly": 500,
  "paidCount": 2,
  "expectedCount": 3,
  "paidMonths": [
   "2026-01",
   "2026-02"
  ],
  "dueMonths": [
   "2026-03"
  ],
  "advanceMonths": [],
  "paidAmount": 1000,
  "dueAmount": 500,
  "paidTotal": 1000,
  "dueTotal": 500
 }
]
```

### getMember

```json
{
 "id": "6b09c1748bf50c555e191c55",
 "sl": 1,
 "name": "Rahim Uddin",
 "phone": "01700000001",
 "status": "active",
 "joinDate": "2026-01-01",
 "monthly": 500,
 "paidCount": 2,
 "expectedCount": 3,
 "paidMonths": [
  "2026-01",
  "2026-02"
 ],
 "dueMonths": [
  "2026-03"
 ],
 "advanceMonths": [],
 "paidAmount": 1000,
 "dueAmount": 500,
 "paidTotal": 1000,
 "dueTotal": 500,
 "account": {
  "expectedMonths": [
   "2026-01",
   "2026-02",
   "2026-03"
  ],
  "expectedCount": 3,
  "paidMonths": [
   "2026-01",
   "2026-02"
  ],
  "paidCount": 2,
  "dueMonths": [
   "2026-03"
  ],
  "advanceMonths": [],
  "paidAmount": 1000,
  "dueAmount": 500,
  "dueTotal": 500,
  "paidTotal": 1000,
  "withdrawn": 0,
  "ratio": 0.6666666666666666,
  "profitShare": 53,
  "currentValue": 1053
 },
 "history": [
  {
   "month": "2026-01",
   "status": "paid",
   "amount": 500,
   "paidDate": "2026-01-05",
   "advance": false
  }
 ]
}
```

### getMonthlyReport

```json
{
 "rows": [
  {
   "month": "2026-01",
   "paid": 2,
   "unpaid": 0,
   "collected": 1000,
   "expected": 1000,
   "profit": 0,
   "total": 1000
  }
 ],
 "summary": {
  "collected": 1500,
  "profit": 80,
  "invested": 1000,
  "cash": 580,
  "advance": 0,
  "personalProfit": 0,
  "paidOut": 0
 }
}
```

### getFundSummary

```json
{
 "collected": 1500,
 "profit": 80,
 "invested": 1000,
 "cash": 580,
 "advance": 0,
 "personalProfit": 0,
 "paidOut": 0
}
```

### getMonth

```json
{
 "month": "2026-02",
 "paid": 1,
 "unpaid": 1,
 "collected": 500,
 "expected": 1000,
 "rows": [
  {
   "memberId": "6b09c1748bf50c555e191c55",
   "sl": 1,
   "name": "Rahim Uddin",
   "status": "paid",
   "amount": 500,
   "expected": 500
  }
 ]
}
```

### getProfitSheet

```json
{
 "through": "2026-03",
 "months": [
  "2026-02",
  "2026-03"
 ],
 "projects": [
  {
   "accountId": "6b09c1748bf50c555e191c5f",
   "account": "Partner A",
   "name": "Sample Shop",
   "projects": [
    {
     "id": "6b09c1748bf50c555e191c65",
     "slug": "sample-shop",
     "name": "Sample Shop"
    }
   ],
   "personal": false,
   "invested": 1000,
   "monthlyProfit": 100,
   "tranches": [
    {
     "date": "2026-01-01",
     "amount": 1000,
     "monthlyProfit": 100,
     "firstMonth": "2026-02"
    }
   ],
   "monthlyReturnPercent": 10,
   "months": [
    {
     "month": "2026-02",
     "expected": 100,
     "received": 80,
     "cost": 20,
     "costNote": "Transfer fee",
     "status": "collected"
    }
   ],
   "monthsRun": 2,
   "monthsCollected": 1,
   "expected": 200,
   "gross": 100,
   "net": 80,
   "cost": 20,
   "pending": 100
  }
 ],
 "costs": [
  {
   "project": "Sample Shop",
   "month": "2026-02",
   "amount": 20,
   "note": "Transfer fee"
  }
 ],
 "grid": [
  {
   "month": "2026-02",
   "values": {
    "6b09c1748bf50c555e191c5f": 80
   }
  }
 ],
 "totals": {
  "invested": 1000,
  "monthlyProfit": 100,
  "expected": 200,
  "gross": 100,
  "net": 80,
  "cost": 20,
  "pending": 100,
  "personalProfit": 0
 }
}
```

### requestCode (state kept for the form)

```json
{
 "ident": "rahim@example.test",
 "token": "…",
 "verified": false,
 "expiresAt": 1795801761428,
 "resendAt": 1795801521428
}
```

### A thrown ApiError

```json
{
 "status": 409,
 "code": "DUPLICATE_TRANSACTION",
 "message": "This transaction ID has already been submitted.",
 "fields": {
  "trxId": "Already submitted"
 }
}
```

## 8. Remove when nothing imports them

`src/data/members.js`, `payments.js`, `investments.js`, `faqs.js`, the calculations in
`src/lib/payments.js` and `src/lib/investments.js` (keep date and month label helpers), and
`src/lib/paymentSubmissions.js` (keep validation, `todayIso`, draft helpers). Keep `legal.js` until the
refund page exists. Ask before deleting.

## 9. Order of work

1. Setup, API client, public projects, summary, members, FAQ.
2. Login, sign-up, logout, forgot password, profile, approval states.
3. Payment form and history.
4. Dashboard, members, member detail, reports, profit sheet, the new `view` routes.
5. Legal pages, other page text, contact form, clean-up.

## 10. Done when

- `npm run build` succeeds and no page imports business data from `src/data`.
- A project, FAQ or member changed in the admin API appears on the site without a rebuild.
- A visitor sees masked numbers and no member data; an unapproved account sees the approval message;
  an approved member sees dashboard, members, reports and profit sheet.
- A submitted payment shows as Pending and changes no total until approved.
- Report what changed, what could not be done, and your assumptions.

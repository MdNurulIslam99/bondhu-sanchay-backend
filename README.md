# Bondhu Sanchay API

One REST API for the admin panel and the public website. Node.js 22+, Express 5, MongoDB (Mongoose).

## Setup

```sh
npm ci
cp .env.example .env       # set MONGODB_URI
npm run db:migrate         # collections and indexes (replica set or Atlas required)
npm run db:import          # members, deposits, investments, pages, FAQs from the admin panel's data files
npm run db:seed            # default settings and role actions
npm run admin:create       # your super admin; the password is typed in the terminal
npm run dev                # http://localhost:5001
```

| Command | Purpose |
| --- | --- |
| `npm run dev` / `npm start` | Run the API (with / without file watching) |
| `npm test` | All tests, on a disposable database |
| `npm run db:atlas` | Put the Atlas password into `.env` without showing it |
| `npm run db:local` | Local MongoDB without installing anything (development only) |
| `npm run db:migrate -- --reset-empty` | Also drop empty collections of an older version |
| `npm run db:import -- --dry-run [folder]` | Show what would be imported |
| `npm run db:seed -- --users` | One account per staff role with a temporary password |
| `npm run docs` | Rebuild the API list, `docs/openapi.json` and the Postman collection |

`npm run db:import` only adds missing records. It never overwrites edits, but it adds back
records that were deleted, so use it for the first load.

## API basics

- Base path `/api/v1`. Readable list split into website and admin: [docs/API-LIST.md](docs/API-LIST.md).
  Machine-readable: `GET /api/v1/openapi.json`, `docs/openapi.json`, `docs/postman.collection.json`.
- Success: `{ success: true, data, message, pagination? }`.
- Error: `{ success: false, message, errors: { field: message }, error: { code, message } }`.
  Statuses: 400, 401, 403, 404, 409, 422, 429.
- Tables accept `page`, `limit` (default 10, max 500), `search`, `sort`, `order`, filters and `format=csv`.
- Money is whole taka. Months are `YYYY-MM`, dates `YYYY-MM-DD`, "today" is Asia/Dhaka.

### Signing in

`POST /auth/login { email or identifier, password }` returns `accessToken`, `user`, `pages`, `actions`
and sets an httpOnly cookie. Use either:

- `Authorization: Bearer <accessToken>`, or
- the cookie (`credentials: 'include'`). Writes made with the cookie must come from an origin in `CORS_ORIGIN`.

Sessions end after 30 idle minutes or 24 hours. `POST /auth/refresh` issues a new token.
Five wrong passwords lock the account for 5 minutes.

### Who can do what

| Caller | Access |
| --- | --- |
| Visitor | `/public/*` |
| Website member (approved) | member list and details, `/dashboard`, `/reports/*`, `/profit-sheet`, `/me/*`, `POST /payments` |
| Staff | pages from **User Permissions**, actions from **Role Actions** |
| Super admin | everything, plus users, permissions, reopening reviewed payments |

A website sign-up with a member's phone number sees member data only after staff approve it:
`GET /member-accounts?status=pending`, then `POST /member-accounts/:id/approve`.

## Connecting the admin panel (`src/lib/store.jsx`)

| Panel function / data | Endpoint |
| --- | --- |
| `login`, `logout` | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| `create / update / remove(collection)` | `POST`, `PATCH`, `DELETE` on the paths below |
| `members` | `/members`, `PATCH /members/:id/status` |
| `payments` | `/payments`, `PATCH /payments/:id/status` |
| `paymentSubmissions`, `reviewSubmission` | `/payment-submissions`, `POST /payment-submissions/:id/review { decision, note }` |
| `investments`, account pages | `/investments`, `GET /investment-accounts` |
| `projects`, `profits`, `withdrawals` | `/projects`, `/profits`, `/withdrawals` |
| `pageNames`, `pageSections` | `/page-names`, `/page-sections`, `/page-sections/next-position` |
| `faqs`, `notices` | `/faqs`, `/notices` |
| `users`, `userPermissions` | `/users`, `PUT /users/:id/password`, `/user-permissions` |
| `savePermissions` | `PUT /role-actions`, `POST /role-actions/reset` |
| `saveSettings` | `GET/PUT /settings` |
| `audit`, dashboard, dues | `/audit-logs`, `/dashboard`, `/dues` |
| images (now data URLs) | `POST /uploads` (multipart `file`), then save the returned `url` |

Rows carry both ids and names (`memberId` + `member`, `accountId` + `account`). Forms may send either.
Remove "Reset Demo Data".

## Connecting the website

| Website file | Endpoint |
| --- | --- |
| `lib/auth.js` | `/auth/signup`, `/auth/login`, `/auth/password/forgot`, `/verify-otp`, `/reset`, `PATCH /me`, `/me/password` |
| `lib/paymentSubmissions.js` | `POST /payments`, `GET /payments/mine` |
| `data/*.js` (public) | `/public/site-content`, or `/public/summary`, `/investments`, `/members`, `/faqs`, `/pages/:slug`, `/notices`, `/settings` |
| member pages, calculations | `/members`, `/me/account`, `/dashboard?month=`, `/reports/monthly`, `/profit-sheet` |

The static export cannot show new projects or members. Fetch in the browser (for example
`/investments/view?id=`) or run Next.js as a server. Add the API address to the CSP
`connect-src` and `img-src` in both frontends.

## Decisions and assumptions

- MongoDB and JavaScript were kept instead of PostgreSQL/TypeScript.
- **Public money:** the `publicShowMoney` setting (on by default) controls whether public responses
  include totals, project amounts and the investor's name. Contact details and unmasked phones are never public.
- **Payment submissions need a login.** There is no guest submission.
- A verified savings payment creates one deposit per selected month. If a month is already paid,
  or the amount differs from months × monthly fee, staff must decide (`months`, `confirmAmountMismatch`).
- A verified profit payment counts as profit by itself, or is booked on an account when `accountId` is sent.
- Tranches are `/investments`; collections are `/profits`. Personal profit is an account with nothing invested.
  Pages of text (privacy, terms, refund) are page names and sections.
- Expected profit counts entries with status `running` (the admin panel's rule), so completing an
  entry also removes it from past expected amounts.
- Pending applicants owe nothing. Inactive members stop owing after the month they were deactivated.
- Financial records are reversed or rejected, never deleted. The one exception: a super admin or admin
  can delete a payment submission. Its money leaves the balance and the audit log keeps a copy.
- Images are stored in MongoDB (max 5 MB each).
- Message Inbox is switched off; see `src/modules/messages.js`.

## Not included yet

- SMS delivery of reset codes (email only) and captcha verification (honeypot and rate limits only).
- The frontends still use their own demo data.

## Deploying to Vercel

Vercel runs `src/app.js` as a function; `server.js` is not used there.

1. **Settings → Environment Variables** (Production): `MONGODB_URI`, `NODE_ENV=production`,
   `CORS_ORIGIN` (the deployed website and admin addresses) and, when those are on another domain
   (including another `*.vercel.app` name), `COOKIE_SAMESITE=none`. `PORT` is not needed.
2. Atlas **Network Access** must allow `0.0.0.0/0`, because Vercel has no fixed address. Use a strong
   database password.
3. Redeploy after every change to the variables.
4. Run `db:migrate`, `db:import` and `admin:create` from your computer against the same database.

Vercel cannot `require()` ES-module-only packages. `overrides` in `package.json` keeps `htmlparser2`
(used by `sanitize-html`) on a version that still supports it; `tests/deploy.test.js` checks this.

Vercel limits request bodies to 4.5 MB, so larger images are refused, and rate limits count per
function instance.

## Production notes

Set `NODE_ENV=production`, HTTPS, an exact `CORS_ORIGIN`, `PUBLIC_API_URL`, SMTP and `TRUST_PROXY`.
Restrict Atlas **Network Access** to the server's address and enable Atlas backups (or schedule `mongodump`).
Rate limits are kept in memory, so run one API instance or add a shared store.

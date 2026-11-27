# Task: connect the Bondhu Sanchay admin panel to the real API

You are working in the admin panel repository `bondhu-sanchay-admin-uat` (Next.js 16, React 19).
It currently keeps all data in `localStorage` with sample data. Replace that with the existing REST API.

**The backend is finished. Do not change it.** Its repository is at `../backendPart/backend`.
Read these before writing code:

- `../backendPart/backend/docs/API-LIST.md` (section "Admin panel")
- `../backendPart/backend/docs/openapi.json` (exact request fields and query values)
- `src/lib/store.jsx`, `src/components/Resource.jsx`, `src/lib/permissions.js` and the pages under
  `src/app/admin/(panel)/`

If the code and this prompt disagree, trust the backend code and tell me. Ask before assuming anything unclear.

## Rules

- Keep the current design, routes and wording. Change only what the API requires.
- The Message Inbox is switched off. Leave every commented-out `messages` line as it is.
- Permissions are enforced by the server. The UI only hides what the user may not do.
- Show money, dues, profit and totals exactly as the API returns them. Do not recalculate them.
- Every screen needs loading, empty and error states. Disable a button while its request runs.
- No new heavy dependencies without asking. Plain `fetch` is enough.
- Never put passwords or tokens in `localStorage`, code or logs.

## 1. Setup

- `.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:5001/api/v1`
- Run the panel on port 3000 or 3001 (the API allows those origins).
- In `next.config.mjs`, add the API origin (from the variable) to the CSP `connect-src` and `img-src`.
- Run the API with `npm run dev`. Create a login with `npm run admin:create` (in the backend folder).

## 2. API client (`src/lib/api.js`)

- Use the session cookie: `credentials: "include"` on every request. The browser sends the `Origin`
  header the API requires for writes.
- Success: `{ success: true, data, message, pagination? , ...extra }`.
- Error: `{ success: false, message, errors: { field: message }, error: { code, message } }`.
  Throw an error object that keeps `status`, `code`, `message` and `errors`.
- 401: clear the session and go to `/admin/login`. Sessions end after 30 idle minutes or 24 hours.
- 403 `PASSWORD_CHANGE_REQUIRED`: go to the change-password screen.
- 429 and other errors: show `message`. Put `errors.<field>` under the matching form field.
- Request bodies are strict: an unknown field returns 422. Send only the fields in `openapi.json`,
  never `id`, `createdAt`, `updatedAt` or calculated values.
- Query strings are strict too. Lists accept `page`, `limit` (default 10, max 500), `search`, `sort`,
  `order`, `format=csv` and the filters below. `pagination` is `{ page, limit, total, pages, hasMore }`.

## 3. Login, session and permissions

- `POST /auth/login { email, password }` returns `data.user`, `data.pages`, `data.actions`
  (`{ module: ["view", "create", ...] }`).
- On load: `GET /auth/me` returns the same `user`, `pages`, `actions`. Refresh it on navigation.
- `can(module, action)` becomes `actions[module]?.includes(action)`.
- Reject `user.role === "member"` (website accounts): log out and show "This account cannot use the admin panel".
- `POST /auth/logout` on log out.
- New screen: change password, `POST /auth/change-password { currentPassword, password }`.
  It is forced when `user.mustChangePassword` is true, and also reachable from the user menu.
- Sidebar organization name: `GET /public/settings` (every user may read it).
- Sidebar pending badge: `GET /payment-submissions?status=pending&limit=1`, then `pagination.total`,
  only when the user can view payment submissions.

## 4. Tables (`Resource.jsx`)

Move search, filters, sorting and pagination to the server. Reset to page 1 when they change, delay
search typing about 300 ms, and reload the table after every write. Make a column sortable only if
its key is listed. CSV: download `?format=csv` with the same filters (fetch as a blob with credentials).

| Page | Path | Sort keys | Filters |
| --- | --- | --- | --- |
| Members | `/members` | sl, name, status, createdAt, dueAmount, paidAmount | status |
| Monthly Deposits | `/payments` | month, amount, status, createdAt, paidDate | status, memberId, month |
| Payment Submissions | `/payment-submissions` | submittedAt, date, amount, status, memberName | status, category, type, from, to, memberId |
| Withdrawals | `/withdrawals` | date, amount, status, createdAt | status, memberId |
| Investment entries | `/investments` | investDate, amount, monthlyProfit, firstProfitMonth, status, createdAt | status, accountId |
| Profit & Costs | `/profits` | month, collected, cost, createdAt | accountId, month |
| Projects | `/projects` | startDate, name, status, sortOrder, createdAt | status, businessType, showOnWebsite, accountId |
| Page Names | `/page-names` | order, name, status, createdAt | status |
| Page Sections | `/page-sections` | displayOrder, title, position, status, createdAt | pageId, status |
| FAQ | `/faqs` | order, question, createdAt | published |
| Notices | `/notices` | date, title, published, createdAt | published |
| Users | `/users` | createdAt, name, email, role, status | role, status |
| User Permissions | `/user-permissions` | createdAt, status | status, userId |
| Audit Log | `/audit-logs` | at, action, entity, userName | user, userId, action, entity, from, to |

Edit with `PATCH /<path>/:id`, create with `POST`, delete with `DELETE`. There is **no delete** for
deposits, submissions, profits or withdrawals.

Rows already contain the names the UI shows: `memberName` and `member`, `accountName` and `account`.
Links now use ids: send `memberId` and `accountId` from dropdowns, with the id as the option value.
Load member options from `/members?limit=500&sort=name` and accounts from `/investment-accounts`.
If a user lacks the permission for those lists (403), say so on the form. Fetch all pages if
`hasMore` is true.

## 5. Page by page

**Members.** Dues columns come from the row: `paidCount`, `expectedCount`, `dueMonths`, `dueAmount`,
`paidAmount`. Approve and Deactivate use `PATCH /members/:id/status { status }`. Deleting a member
with history returns 409: show the message.

**Website accounts (new tab on Members).** `GET /member-accounts?status=pending` returns
`name, email, phone, membershipStatus, memberName`. Buttons: `POST /member-accounts/:id/approve`,
`/reject`, and `DELETE /member-accounts/:id`. Needs `members.update` / `members.delete`.

**Deposits.** Verify and Reverse use `PATCH /payments/:id/status`. On a verified row only
`paidDate`, `method` and `trxId` are editable. `paidDate` is free text ("10/25" exists).

**Payment submissions.**
- Verify and Reject: `POST /payment-submissions/:id/review { decision: "verified" | "rejected", note }`.
- 409 `AMOUNT_MISMATCH`: show the message, ask to confirm, repeat with `confirmAmountMismatch: true`.
- 409 `MONTH_ALREADY_PAID`: `errors.months` lists the paid months. Let the admin choose the remaining
  months and send `months`.
- Website payments can cover several months (`months[]`). Show all of them. When editing, send
  `months`; sending the single `month` replaces the whole list.
- `memberId` can be null (account not linked). A savings payment needs a member chosen (edit) before verifying.
- For a profit payment, optionally let the admin pick an account (`accountId`, `month`) in the review dialog.
- Super admin only: "Reopen", `POST /payment-submissions/:id/reopen { reason }`.
- The summary cards: pending count and amount from `GET /dashboard` (`pendingSubmissions`). Remove
  any total you cannot get from the API, and tell me. Duplicate transaction IDs are now refused by the server.

**Dues.** `GET /dues?filter=all|due|clear` returns rows plus `totals { expected, paid, due,
membersWithDues, members }` and `collectionMonths`. For the Monthly Record grid use `collectionMonths`
and each row's `paidMonths` / `dueMonths`; paid dates come from `/payments?status=verified&limit=500`
(read every page). Advance payments can fall after the last collection month.

**Investments.** `GET /investment-accounts` returns accounts with `entries`, `months`, `projects`,
`invested`, `monthlyProfit`, `monthsPassed`, `monthsCollected`, `collected`, `cost`, `pending`, and
`totals`. The detail route should use the account id: `GET /investment-accounts/:id`. Each month has
`expected, collected, cost, pending, status, note, recordId`. With a `recordId` edit
`PATCH /profits/:id`; otherwise `POST /profits { accountId, month, collected, cost, note }`.
Creating an investment may send a new `name`, which creates the account. Deleting an entry can return
409 `HAS_PROFIT_RECORDS`: confirm, then repeat with `?confirm=true`.

On the Investments page, "Cash Balance" is `cash` and the monthly profit chart is
`charts.monthlyProfit`, both from `GET /dashboard` (hide them if absent).

**Profit & Costs.** Cards use `summary { earnedBeforeCosts, costs, profitCollected }` from the list response.

**Withdrawals.** New requests are always pending: remove the status field from the create form.
Approve, Reject and Mark paid use `PATCH /withdrawals/:id/status`. Only pending requests are editable.

**Projects and Page Sections.** Replace the base64 images: resize as today, then send each file as
`multipart/form-data` field `file` to `POST /uploads` (JPG, PNG or WEBP, 5 MB, 5 images) and save the
returned `url`. Do not set the `Content-Type` header yourself. Next position:
`GET /page-sections/next-position?pageId=&sectionHeader=&ignoreId=`.

**Rich text editor.** The server keeps only `p, br, h2, h3, ul, ol, li, strong, em, a`. Remove the
underline, text color, alignment, quote and Heading 4 controls.

**Users.** Add an optional password field on create (without one the user cannot log in) and a
"Set password" action, `PUT /users/:id/password { password }`. The user must change it at next login.

**Roles.** `GET /role-actions`, `PUT /role-actions` with the whole map, and "Reset to Default" calls
`POST /role-actions/reset`.

**Settings.** `GET` and `PUT /settings`. Add fields `collectionStart`, `lastCollectionMonth`,
`profitThroughMonth` (months) and `publicShowMoney` (checkbox: show money figures on the public website).
Remove "Reset Data".

**Dashboard.** `GET /dashboard` returns only the sections the user may see, so hide missing ones.
Figures: `totalMembers, activeMembers, totalCollection, totalDue, owingMembersCount, invested, profit,
pendingProfit, paidOut, allTotal, pendingSubmissions, recentActivity` and `charts { monthlyCollection,
collectionGrowth, duesByMember, collectionStatus, investedByAccount, monthlyProfit }`. Chart points
are `{ month, label, value }`.

**FAQ.** Add the optional `published` (yes/no) field. **Notices** keep their fields.

## 6. Clean up

First move constants that are still needed into `src/lib` (`BUSINESS_TYPES` from `src/data/projects.js`;
the dues page also imports from `src/data/collection.js`).
When nothing imports them any more, delete the demo data and calculations: `src/lib/seed.js`,
`dues.js`, `investments.js`, `webContent.js` (keep the section constants the forms use), `src/data/*`,
`DEMO_PASSWORD`, the demo accounts box on the login page, the "Export for Website" button and the
storage-full warning. Keep `lib/permissions.js` for labels and menu order.
**Do not delete `src/data` until the backend has imported it** (`npm run db:import` reads those files).
Ask me before deleting.

## 7. Order of work

1. API client, login, session, permissions, change password.
2. `Resource.jsx` with server lists; FAQ and Notices as the first test.
3. Members, website accounts, deposits, submissions, dues, withdrawals.
4. Investments, profits, projects, pages, sections, uploads.
5. Users, permissions, roles, settings, audit, dashboard.
6. Clean up.

Stop after each step and tell me what works.

## 8. Done when

- `npm run build` succeeds.
- No page reads or writes business data in `localStorage` (the theme setting may stay).
- A super admin can do every action above, and a viewer sees no create, edit or delete buttons.
- A reload keeps the session; log out and expiry return to the login page.
- A notice, project with an uploaded image and page section created in the panel appear in
  `GET /public/site-content`.
- Verifying a payment updates the member's dues and the dashboard totals.
- Finally list what you changed, what you could not do, and your assumptions.

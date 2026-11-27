import { createApi } from '../lib/api.js';
import authRoutes from '../modules/auth.js';
import investmentRoutes from '../modules/investments.js';
import leadRoutes from '../modules/leads.js';
import memberRoutes from '../modules/members.js';
import paymentRoutes from '../modules/payments.js';
import publicRoutes from '../modules/public.js';
import reportRoutes from '../modules/reports.js';
import settingsRoutes from '../modules/settings.js';
import submissionRoutes from '../modules/submissions.js';
import usersRoutes from '../modules/users.js';
import websiteRoutes from '../modules/website.js';
// Message Inbox is switched off for now. See src/modules/messages.js.
// import messageRoutes from '../modules/messages.js';

export const api = createApi();

authRoutes(api);
publicRoutes(api);
usersRoutes(api);
memberRoutes(api);
leadRoutes(api);
submissionRoutes(api); // before paymentRoutes: "/payments/mine" must win over "/payments/:id"
paymentRoutes(api);
investmentRoutes(api);
websiteRoutes(api);
reportRoutes(api);
settingsRoutes(api);
// messageRoutes(api);

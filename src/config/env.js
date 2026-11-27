import 'dotenv/config';

const port = Number(process.env.PORT || 5001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI is required. Configure your .env file.');
}

const nodeEnv = process.env.NODE_ENV || 'development';
const list = value => value.split(',').map(item => item.trim().replace(/\/$/, '')).filter(Boolean);

// Express treats strings as IP lists, so booleans and hop counts must be converted.
function parseTrustProxy(value) {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

const sameSite = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(sameSite)) throw new Error('COOKIE_SAMESITE must be lax, strict or none');

// Vercel provides these automatically.
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';

export const env = {
  nodeEnv,
  port,
  mongodbUri: process.env.MONGODB_URI,
  corsOrigins: list(process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3001'),
  publicApiUrl: (process.env.PUBLIC_API_URL || vercelUrl || `http://localhost:${port}`).replace(/\/$/, ''),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  cookieSameSite: sameSite,
  secureCookies: nodeEnv === 'production' || sameSite === 'none',
  // Vercel is one proxy in front of the app; without this every visitor looks like the same address.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY || (process.env.VERCEL ? '1' : '')),
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || '',
  revalidateUrl: process.env.WEBSITE_REVALIDATE_URL || '',
  revalidateSecret: process.env.REVALIDATE_SECRET || '',
};

if (env.corsOrigins.includes('*')) throw new Error('CORS_ORIGIN must be an explicit origin allowlist');

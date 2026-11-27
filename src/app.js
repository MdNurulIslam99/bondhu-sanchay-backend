import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { openApiDocument } from './lib/openapi.js';
import { AppError, errorHandler, routeNotFound } from './lib/errors.js';
import { limiter } from './lib/security.js';
import { api } from './routes/index.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.trustProxy);
app.use(helmet());
app.use(cors({ origin: env.corsOrigins, credentials: true, exposedHeaders: ['Content-Disposition'] }));
if (env.nodeEnv !== 'test') app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(cookieParser());
app.use('/api', limiter(1000));
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => res.json({ message: 'Bondhu Sanchay API is running' }));
// Serverless hosts (Vercel) load this file without server.js, so the database is connected here.
const database = () => connectDB().catch(error => {
  console.error('Database connection failed:', error.message);
  throw new AppError(503, 'DATABASE_UNAVAILABLE', 'Database is unavailable');
});
app.get(['/api/health', '/api/v1/ready'], async (req, res) => {
  await database().catch(() => {});
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ success: connected, status: connected ? 'ok' : 'unavailable', database: connected ? 'connected' : 'disconnected' });
});
app.get('/api/v1/health', (req, res) => res.json({ success: true, status: 'ok' }));
app.get('/api/v1/openapi.json', (req, res) => res.json(openApiDocument()));
app.use('/api/v1', async (req, res, next) => {
  await database();
  next();
}, api.router);
app.use(routeNotFound);
app.use(errorHandler);

export default app;

import mongoose from 'mongoose';
import { env } from './env.js';

let pending;

/** Connect once and reuse it. Serverless hosts call this on the first request of each instance. */
export async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  // A failed attempt is forgotten, so the next request tries again.
  pending ??= mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10000 })
    .then(() => console.log('MongoDB connected'))
    .finally(() => { pending = undefined; });
  await pending;
}

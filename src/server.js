import mongoose from 'mongoose';
import app from './app.js';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';

let server;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down`);
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  try {
    if (server?.listening) await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await mongoose.disconnect();
    clearTimeout(timeout);
  } catch (error) {
    console.error('Shutdown failed:', error.message);
    process.exit(1);
  }
}

try {
  await connectDB();
  // Express 5 reports listen failures (such as a busy port) through this callback.
  server = app.listen(env.port, async (error) => {
    if (error) {
      console.error(error.code === 'EADDRINUSE'
        ? `Port ${env.port} is already in use. Set a different PORT in .env.`
        : `HTTP server failed: ${error.message}`);
      process.exitCode = 1;
      await shutdown('server error');
      return;
    }
    console.log(`Server running at http://localhost:${env.port}`);
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} catch (error) {
  console.error('Startup failed:', error.message);
  if (error.name === 'MongooseServerSelectionError') {
    console.error(env.mongodbUri.startsWith('mongodb+srv:')
      ? 'MongoDB Atlas refused the connection. Check Network Access (IP allow list) and that the cluster is running.'
      : 'Check that MongoDB is running (local development: npm run db:local) and MONGODB_URI is correct.');
  }
  await mongoose.disconnect();
  process.exitCode = 1;
}

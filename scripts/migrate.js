// Creates collections and indexes. Safe to run repeatedly; it never deletes documents.
//   npm run db:migrate
//   npm run db:migrate -- --reset-empty   also drops EMPTY collections left by an older version
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { ensureIndexes } from '../src/models/index.js';

const OLD = ['messages', 'capital_returns', 'expenses', 'fee_history', 'finance_policies', 'idempotency_keys', 'losses', 'reversals', 'role_permissions'];

try {
  await connectDB();
  const db = mongoose.connection.db;
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('A MongoDB replica set (or Atlas) is required.');
  if (process.argv.includes('--reset-empty')) {
    const known = new Set([...OLD, ...Object.values(mongoose.models).map(model => model.collection.collectionName)]);
    for (const { name } of await db.listCollections().toArray()) {
      if (known.has(name) && await db.collection(name).countDocuments({}, { limit: 1 }) === 0) {
        await db.collection(name).drop();
        console.log(`Dropped empty collection: ${name}`);
      }
    }
  }
  await ensureIndexes();
  console.log(`Migration complete: ${Object.keys(mongoose.models).length} collections ready.`);
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

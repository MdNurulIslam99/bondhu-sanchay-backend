// Development-only MongoDB replica set (required for audited writes); data persists in .data/.
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const port = 27017;
const dbPath = fileURLToPath(new URL('../.data/mongodb', import.meta.url));

// Check first: the library would otherwise fail obscurely or pick another port.
const free = await new Promise(resolve => {
  const probe = net.createServer()
    .once('error', () => resolve(false))
    .listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});
if (!free) {
  console.error(`Port ${port} is already in use. Is MongoDB already running?`);
  process.exit(1);
}

await mkdir(dbPath, { recursive: true });
const replica = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ port, dbPath }],
});
const stop = async () => {
  await replica.stop({ doCleanup: false });
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
console.log(`Local MongoDB running on 127.0.0.1:${port} (data: ${dbPath}). Press Ctrl+C to stop.`);

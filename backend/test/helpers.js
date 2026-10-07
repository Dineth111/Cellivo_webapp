import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { resetPlanCache } from '../src/modules/plans/plans.service.js';

// Test data lives in the project (backend/.test-tmp), not the OS temp dir on C:.
const TMP_ROOT = fileURLToPath(new URL('../.test-tmp/', import.meta.url));

let repl;
let dbPath;

// Replica set mode so multi-document transactions work.
// The mongod binary is downloaded to MONGOMS_DOWNLOAD_DIR (vitest.config.js); set
// MONGOMS_SYSTEM_BINARY to use an installed mongod instead.
export async function startDb() {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  dbPath = fs.mkdtempSync(`${TMP_ROOT}db-`);
  const binary = process.env.MONGOMS_SYSTEM_BINARY ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } : {};
  repl = await MongoMemoryReplSet.create({
    binary,
    replSet: { count: 1 },
    instanceOpts: [{ dbPath }],
  });
  await mongoose.connect(repl.getUri('cellivo_test'));
}

export async function stopDb() {
  await mongoose.disconnect();
  await repl?.stop();
  if (dbPath) fs.rmSync(dbPath, { recursive: true, force: true });
}

// dropDatabase bypasses model hooks, so it also clears append-only collections.
export async function resetDb() {
  await mongoose.connection.dropDatabase();
  resetPlanCache(); // plans are seeded lazily and cached
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

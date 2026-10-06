import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { resetPlanCache } from '../src/modules/plans/plans.service.js';

let repl;

// Replica set mode so multi-document transactions work.
export async function startDb() {
  const binary = process.env.MONGOMS_SYSTEM_BINARY
    ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY }
    : { systemBinary: 'C:\\Program Files\\MongoDB\\Server\\8.3\\bin\\mongod.exe' };
  repl = await MongoMemoryReplSet.create({
    binary,
    replSet: { count: 1 },
  });
  await mongoose.connect(repl.getUri('cellivo_test'));
}

export async function stopDb() {
  await mongoose.disconnect();
  await repl?.stop();
}

// dropDatabase bypasses model hooks, so it also clears append-only collections.
export async function resetDb() {
  await mongoose.connection.dropDatabase();
  resetPlanCache(); // plans are seeded lazily and cached
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

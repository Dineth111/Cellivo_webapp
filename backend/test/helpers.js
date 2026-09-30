import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let repl;

// Replica set mode so multi-document transactions work.
export async function startDb() {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri('cellivo_test'));
}

export async function stopDb() {
  await mongoose.disconnect();
  await repl?.stop();
}

// dropDatabase bypasses model hooks, so it also clears append-only collections.
export async function resetDb() {
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

import mongoose from 'mongoose';
import { config } from './config.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let memoryReplSet = null;

export const connectDB = async () => {
  let uri = config.mongoUri;

  // In development, if local standalone MongoDB without replication is detected,
  // spin up a lightweight single-node replica set with wiredTiger so ACID transactions work.
  if (config.env === 'development' && (!uri || uri.includes('localhost') || uri.includes('127.0.0.1'))) {
    try {
      const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
      // Probe if server has replicaSet enabled
      let hasReplSet = false;
      try {
        const helloRes = await conn.connection.db.admin().command({ hello: 1 });
        hasReplSet = !!helloRes.setName;
      } catch {
        hasReplSet = false;
      }

      if (!hasReplSet) {
        console.log('⚡ Local MongoDB is standalone (no replica set). Initializing single-node Replica Set for ACID transactions...');
        await mongoose.disconnect();
        const { MongoMemoryReplSet } = await import('mongodb-memory-server');
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const dbPath = path.resolve(__dirname, '../../.mongodb_data');
        if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });

        memoryReplSet = await MongoMemoryReplSet.create({
          // MONGOMS_SYSTEM_BINARY points at a local mongod; otherwise mongodb-memory-server uses its cached download
          binary: process.env.MONGOMS_SYSTEM_BINARY ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } : {},
          replSet: { count: 1, storageEngine: 'wiredTiger' },
          instanceOpts: [{ port: 27018, dbPath }],
        });
        uri = memoryReplSet.getUri('cellivo');
        config.mongoUri = uri;
        return await mongoose.connect(uri);
      }
      console.log(`[MongoDB Connected]: Host -> ${conn.connection.host}, Database -> ${conn.connection.name}`);
      return conn;
    } catch (err) {
      if (err.name === 'MongoServerSelectionError' || err.message?.includes('ECONNREFUSED')) {
        console.log('⚡ Standalone MongoDB not reachable. Initializing single-node Replica Set...');
        const { MongoMemoryReplSet } = await import('mongodb-memory-server');
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const dbPath = path.resolve(__dirname, '../../.mongodb_data');
        if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });

        memoryReplSet = await MongoMemoryReplSet.create({
          // MONGOMS_SYSTEM_BINARY points at a local mongod; otherwise mongodb-memory-server uses its cached download
          binary: process.env.MONGOMS_SYSTEM_BINARY ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } : {},
          replSet: { count: 1, storageEngine: 'wiredTiger' },
          instanceOpts: [{ port: 27018, dbPath }],
        });
        uri = memoryReplSet.getUri('cellivo');
        config.mongoUri = uri;
        return await mongoose.connect(uri);
      }
      throw err;
    }
  }

  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`[MongoDB Connected]: Host -> ${conn.connection.host}, Database -> ${conn.connection.name}`);
  return conn;
};

mongoose.connection.on('disconnected', () => console.warn('[MongoDB Warning]: Disconnected from database.'));
mongoose.connection.on('reconnected', () => console.log('[MongoDB Info]: Reconnected to database.'));

export default connectDB;

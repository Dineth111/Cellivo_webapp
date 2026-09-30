import mongoose from 'mongoose';
import { config } from './config.js';

export const connectDB = async () => {
  const conn = await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  console.log(`[MongoDB Connected]: Host -> ${conn.connection.host}, Database -> ${conn.connection.name}`);
  return conn;
};

mongoose.connection.on('disconnected', () => console.warn('[MongoDB Warning]: Disconnected from database.'));
mongoose.connection.on('reconnected', () => console.log('[MongoDB Info]: Reconnected to database.'));

export default connectDB;

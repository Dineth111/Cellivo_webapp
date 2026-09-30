// Creates one demo user per shop role. Safe to re-run: existing emails are skipped.
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import User from './models/User.js';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo users when NODE_ENV=production.');
  process.exit(1);
}

const PASSWORD = 'Cellivo@123';
const users = [
  { name: 'Nimal Perera', role: 'owner' },
  { name: 'Kasun Silva', role: 'branch_manager' },
  { name: 'Dilini Fernando', role: 'cashier' },
  { name: 'Ruwan Jayasinghe', role: 'technician' },
  { name: 'Saman Kumara', role: 'accountant' },
];

await mongoose.connect(process.env.MONGO_URI);

for (const { name, role } of users) {
  const email = `${role.replace('_', '')}@cellivo.lk`;
  if (await User.exists({ email })) {
    console.log(`skip    ${email}`);
    continue;
  }
  await User.create({ name, email, password: PASSWORD, role, shopName: 'Demo Mobile' });
  console.log(`created ${email}`);
}

console.log(`\nPassword for all: ${PASSWORD}`);
await mongoose.disconnect();

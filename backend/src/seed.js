// Creates one demo shop (tenant) with one user per default role. Safe to re-run: skipped if it exists.
import mongoose from 'mongoose';
import { config, assertConfig } from './core/config.js';
import { provisionTenant } from './modules/tenants/provisioning.service.js';
import User from './modules/users/User.model.js';
import Role from './modules/roles/Role.model.js';
import { runAsPlatform, runWithContext } from './core/tenantContext.js';
import { hashPassword } from './core/password.js';

if (config.env === 'production') {
  console.error('Refusing to seed demo users when NODE_ENV=production.');
  process.exit(1);
}
assertConfig();

const PASSWORD = 'Cellivo@123';
const staff = [
  { name: 'Kasun Silva', role: 'branch_manager' },
  { name: 'Dilini Fernando', role: 'cashier' },
  { name: 'Ruwan Jayasinghe', role: 'technician' },
  { name: 'Saman Kumara', role: 'accountant' },
];
const emailOf = (role) => `${role.replace('_', '')}@cellivo.lk`;

import connectDB from './core/db.js';

await connectDB();

// Demo users from before multi-tenancy have no tenantId/passwordHash and can never log in: remove them.
const legacy = await User.collection.deleteMany({ email: /@cellivo.lk$/, tenantId: { $exists: false } });
if (legacy.deletedCount) console.log(`removed ${legacy.deletedCount} legacy demo user(s)`);

if (await runAsPlatform(async () => await User.exists({ email: emailOf('owner') }))) {
  console.log('skip    demo shop already exists');
} else {
  const { tenant, branch, user } = await provisionTenant({
    ownerName: 'Nimal Perera', shopName: 'Demo Mobile', email: emailOf('owner'), password: PASSWORD, phone: '0771234567',
  });
  console.log(`created ${user.email}`);
  await runWithContext({ tenantId: tenant._id }, async () => {
    const roles = await Role.find();
    const passwordHash = await hashPassword(PASSWORD);
    for (const { name, role } of staff) {
      const u = await User.create({ name, email: emailOf(role), passwordHash, roleId: roles.find((r) => r.key === role)._id, branchIds: [branch._id] });
      console.log(`created ${u.email}`);
    }
  });
}

console.log(`\nPassword for all: ${PASSWORD}`);
await mongoose.disconnect();
process.exit(0);

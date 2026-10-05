// Creates a platform admin: node src/createAdmin.js "Name" email@x.com super_admin 'Password1'
// 2FA is set up on the first login (the dashboard shows the secret for the authenticator app).
import mongoose from 'mongoose';
import { config, assertConfig } from './core/config.js';
import { AdminUser, ADMIN_ROLES } from './modules/admin/admin.models.js';
import { hashPassword, passwordError } from './core/password.js';

const [name, email, role = 'super_admin', password] = process.argv.slice(2);
if (!name || !email || !password || !ADMIN_ROLES.includes(role)) {
  console.error(`Usage: node src/createAdmin.js "Name" email role password   (roles: ${ADMIN_ROLES.join(', ')})`);
  process.exit(1);
}
const weak = passwordError(password);
if (weak) { console.error(weak); process.exit(1); }

assertConfig();
await mongoose.connect(config.mongoUri);
await AdminUser.create({ name, email, role, passwordHash: await hashPassword(password) });
console.log(`Admin ${email} (${role}) created.`);
await mongoose.disconnect();

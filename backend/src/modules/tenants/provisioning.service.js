import mongoose from 'mongoose';
import Tenant from './Tenant.model.js';
import Branch from '../branches/Branch.model.js';
import Role from '../roles/Role.model.js';
import User from '../users/User.model.js';
import { DEFAULT_ROLES } from '../roles/defaultRoles.js';
import { runWithContext, runAsPlatform } from '../../core/tenantContext.js';
import { hashPassword, passwordError } from '../../core/password.js';
import { badRequest, conflict } from '../../core/errors.js';
import { config } from '../../core/config.js';

/**
 * FRS F-01 step 6. Creates, in ONE transaction: Tenant (trial), "Main Branch" (INV-),
 * the 5 default roles and the owner user. Throws (and creates nothing) on any failure.
 * Sign-up flow around it (email verification, plan choice) belongs to Dev 2.
 */
export async function provisionTenant({ ownerName, shopName, email, phone = '', password, country = 'LK' }) {
  const pwError = passwordError(password);
  if (pwError) throw badRequest(pwError);

  email = String(email).toLowerCase().trim();
  const exists = await runAsPlatform(async () => await User.exists({ email }));
  if (exists) throw conflict('An account with this email already exists. Log in or reset your password.');

  const passwordHash = await hashPassword(password);
  const trialEndsAt = new Date(Date.now() + config.trialDays * 864e5);

  const dbSession = await mongoose.startSession();
  try {
    let result;
    await dbSession.withTransaction(async () => {
      const [tenant] = await Tenant.create([{ name: shopName, country, trialEndsAt }], { session: dbSession });
      result = await runWithContext({ tenantId: tenant._id }, async () => {
        const [branch] = await Branch.create([{ name: 'Main Branch', invoicePrefix: 'INV-' }], { session: dbSession });
        // clone: insertMany fills tenantId into the objects it is given
        const roles = await Role.insertMany(DEFAULT_ROLES.map((r) => structuredClone(r)), { session: dbSession });
        const owner = roles.find((r) => r.key === 'owner');
        const [user] = await User.create(
          [{ name: ownerName, email, phone, passwordHash, roleId: owner._id, branchIds: [branch._id] }],
          { session: dbSession }
        );
        return { tenant, branch, roles, user };
      });
    });
    return result;
  } finally {
    await dbSession.endSession();
  }
}

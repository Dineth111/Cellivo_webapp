import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { provisionTenant } from '../src/modules/tenants/provisioning.service.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import Role from '../src/modules/roles/Role.model.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

const input = (email) => ({ ownerName: 'Nimal', shopName: 'Nimal Mobile', email, password: 'Passw0rdX' });

describe('provisionTenant', () => {
  it('creates tenant, branch, 5 roles and owner in one go', async () => {
    const { tenant, branch, roles, user } = await provisionTenant(input('a@x.lk'));
    expect(tenant.status).toBe('trial');
    expect(tenant.currency).toBe('LKR');
    expect(branch.invoicePrefix).toBe('INV-');
    expect(roles.map((r) => r.key).sort()).toEqual(['accountant', 'branch_manager', 'cashier', 'owner', 'technician']);
    expect(user.branchIds).toHaveLength(1);
    expect(user.tenantId.equals(tenant._id)).toBe(true);
  });

  it('two tenants get separate roles (default role constants are not shared)', async () => {
    const a = await provisionTenant(input('a@x.lk'));
    const b = await provisionTenant(input('b@x.lk'));
    const rolesB = await runWithContext({ tenantId: b.tenant._id }, async () => await Role.find());
    expect(rolesB).toHaveLength(5);
    expect(rolesB.every((r) => r.tenantId.equals(b.tenant._id))).toBe(true);
    expect(a.tenant._id.equals(b.tenant._id)).toBe(false);
  });

  it('rejects duplicate email and weak password without creating anything', async () => {
    await provisionTenant(input('a@x.lk'));
    await expect(provisionTenant(input('A@x.lk'))).rejects.toMatchObject({ status: 409 });
    await expect(provisionTenant({ ...input('c@x.lk'), password: 'short1' })).rejects.toMatchObject({ status: 400 });
    await expect(provisionTenant({ ...input('c@x.lk'), password: 'onlyletters' })).rejects.toMatchObject({ status: 400 });
    expect(await runAsPlatform(async () => await Tenant.countDocuments())).toBe(1);
  });
});

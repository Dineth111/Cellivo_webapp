import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import RepairTicket from '../src/modules/repairs/models/RepairTicket.model.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import StockLevel from '../src/modules/inventory/models/StockLevel.model.js';
import Invoice from '../src/modules/pos/models/Invoice.model.js';
import CreditNote from '../src/modules/pos/models/CreditNote.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import Role from '../src/modules/roles/Role.model.js';
import User from '../src/modules/users/User.model.js';

import { createSession } from '../src/modules/auth/session.service.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

describe('F-05 Dashboard API', () => {
  it('1. requires authentication and dashboard.view permission', async () => {
    // Unauthenticated request -> 401
    const unauth = await api('get', '/api/dashboard');
    expect(unauth.status).toBe(401);

    // Authenticated owner with dashboard.view -> 200
    const owner = await signup('dash_auth@cellivo.lk', 'Auth Shop');
    const res = await api('get', '/api/dashboard', owner.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();

    // User whose role lacks dashboard.view -> 403
    const tenantId = owner.user.tenant?._id;
    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    let noDashToken;
    await runWithContext({ tenantId }, async () => {
      const noDashRole = new Role({
        tenantId,
        name: 'No Dashboard Role',
        key: 'no_dash',
        grid: { dashboard: { view: false }, pos: { view: true } },
      });
      await noDashRole.save();

      const noDashUser = new User({
        tenantId,
        branchIds: [branchId],
        name: 'No Dash User',
        email: 'nodash@cellivo.lk',
        passwordHash: 'dummy',
        roleId: noDashRole._id,
        isActive: true,
      });
      await noDashUser.save();

      const s = await createSession(noDashUser);
      noDashToken = s.token;
    });

    const forbiddenRes = await api('get', '/api/dashboard', noDashToken);
    expect(forbiddenRes.status).toBe(403);

    const staffRes = await addStaff(owner, 'technician', 'tech_check@cellivo.lk');
    // Technician has dashboard.view -> 200
    const techRes = await api('get', '/api/dashboard', staffRes.token);
    expect(techRes.status).toBe(200);
  });

  it('2. calculates sales with returns netted out, active repairs, low stock, and receivables with known numbers', async () => {
    const owner = await signup('dash_metrics@cellivo.lk', 'Metrics Shop');
    const tenantId = owner.user.tenant?._id;

    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Nimal Silva',
      phone: '0772223344',
    });
    const customerId = custRes.body.data._id;

    await runWithContext({ tenantId }, async () => {
      // Completed Sale: 100,000 cents
      const inv1 = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-000001',
        status: 'completed',
        paymentStatus: 'paid',
        customerId,
        subtotalCents: 100000,
        grandTotalCents: 100000,
        totalPaidCents: 100000,
        lines: [{ name: 'Charger', qty: 1, unitPriceCents: 100000, grossCents: 100000, netCents: 100000, lineTotalCents: 100000 }],
      });
      await inv1.save();

      // Return / CreditNote: 20,000 cents
      const cn = new CreditNote({
        tenantId,
        branchId,
        creditNoteNumber: 'CN-000001',
        originalInvoiceId: inv1._id,
        originalInvoiceNumber: 'INV-000001',
        customerId,
        items: [{ name: 'Charger Cable', qty: 1, unitPriceCents: 20000, refundCents: 20000 }],
        subtotalCents: 20000,
        totalRefundCents: 20000,
      });
      await cn.save();

      // Partially paid Sale: 80,000 total, 30,000 paid => 50,000 due
      const inv2 = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-000002',
        status: 'completed',
        paymentStatus: 'partially_paid',
        customerId,
        subtotalCents: 80000,
        grandTotalCents: 80000,
        totalPaidCents: 30000,
        lines: [{ name: 'Glass', qty: 1, unitPriceCents: 80000, grossCents: 80000, netCents: 80000, lineTotalCents: 80000 }],
      });
      await inv2.save();

      // Draft invoice with unpaid balance: 40,000 cents -> must NOT be counted in receivables
      const invDraft = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-DRAFT-01',
        status: 'draft',
        paymentStatus: 'unpaid',
        customerId,
        subtotalCents: 40000,
        grandTotalCents: 40000,
        totalPaidCents: 0,
        lines: [{ name: 'Draft Item', qty: 1, unitPriceCents: 40000, grossCents: 40000, netCents: 40000, lineTotalCents: 40000 }],
      });
      await invDraft.save();

      // Terminal repair ticket (Delivered): should NOT count toward active repairs
      const tDelivered = new RepairTicket({
        tenantId,
        branchId,
        ticketNo: 'JOB-DELIVERED',
        customerId,
        device: { brand: 'Apple', model: 'iPhone 11' },
        faultDescription: 'Done repair',
        stage: 'Delivered',
        isArchived: false,
      });
      await tDelivered.save();

      // Low stock product: reorderLevel 5, stock 2 => low stock
      const prodLow = new Product({
        tenantId,
        name: 'Battery A32',
        barcode: 'BAT-A32-001',
        sellingPriceCents: 450000,
        reorderLevel: 5,
      });
      await prodLow.save();

      const slLow = new StockLevel({
        tenantId,
        productId: prodLow._id,
        branchId,
        qty: 2,
      });
      await slLow.save();

      // Healthy stock product: reorderLevel 3, stock 10 => ok
      const prodOk = new Product({
        tenantId,
        name: 'Case A32',
        barcode: 'CASE-A32-001',
        sellingPriceCents: 150000,
        reorderLevel: 3,
      });
      await prodOk.save();

      const slOk = new StockLevel({
        tenantId,
        productId: prodOk._id,
        branchId,
        qty: 10,
      });
      await slOk.save();

      // Service product: reorderLevel 0, stock 0 => does NOT track stock, must NOT count in low stock
      const prodService = new Product({
        tenantId,
        name: 'Service Labour Charge',
        barcode: 'SRV-LABOUR-01',
        sellingPriceCents: 200000,
        reorderLevel: 0,
      });
      await prodService.save();

      // Product with trackStock: false in database => must NOT count in low stock even if qty is 0
      const prodNoTrack = {
        tenantId,
        name: 'Non Tracked Accessory',
        barcode: 'NON-TRACK-01',
        sellingPriceCents: 50000,
        reorderLevel: 5,
        trackStock: false,
        isArchived: false,
      };
      await Product.collection.insertOne(prodNoTrack);

      const slNoTrack = new StockLevel({
        tenantId,
        productId: prodNoTrack._id,
        branchId,
        qty: 0,
      });
      await slNoTrack.save();
    });

    // Active repair ticket via API: Received
    const tActive = await api('post', '/api/repairs', owner.token).send({
      branchId,
      customerId,
      device: { brand: 'Samsung', model: 'A32' },
      faultDescription: 'No power',
    });
    expect(tActive.status).toBe(201);

    const res = await api('get', '/api/dashboard?period=today', owner.token);
    expect(res.status).toBe(200);
    const data = res.body.data;

    // Gross: 100,000 + 80,000 = 180,000. Returns: 20,000. Net: 160,000.
    expect(data.sales.grossCents).toBe(180000);
    expect(data.sales.returnsCents).toBe(20000);
    expect(data.sales.totalCents).toBe(160000);
    expect(data.sales.count).toBe(2);

    expect(data.activeRepairsCount).toBe(1);
    expect(data.lowStockCount).toBe(1);
    expect(data.receivables.totalCents).toBe(50000); // 80,000 - 30,000
    expect(data.receivables.unpaidInvoicesCents).toBe(50000);
  });

  it('3. handles sale at 00:30 Asia/Colombo time within today period', async () => {
    const owner = await signup('dash_timezone@cellivo.lk', 'Timezone Shop');
    const tenantId = owner.user.tenant?._id;

    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    // Calculate 00:30 today in Asia/Colombo time (which is 19:00 UTC previous day)
    const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const localNow = new Date(Date.now() + COLOMBO_OFFSET_MS);
    const colombo0030 = new Date(
      Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 0, 30, 0, 0) -
        COLOMBO_OFFSET_MS
    );

    await runWithContext({ tenantId }, async () => {
      const invMidnight = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-COLOMBO-0030',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 45000,
        grandTotalCents: 45000,
        totalPaidCents: 45000,
        createdAt: colombo0030,
        lines: [{ name: 'Night Service', qty: 1, unitPriceCents: 45000, grossCents: 45000, netCents: 45000, lineTotalCents: 45000 }],
      });
      await invMidnight.save();
    });

    const res = await api('get', '/api/dashboard?period=today', owner.token);
    expect(res.status).toBe(200);
    expect(res.body.data.sales.totalCents).toBe(45000);
    expect(res.body.data.sales.count).toBe(1);
  });

  it('4. gates each tile and activity-feed event type by permission (null tile when lacking permission)', async () => {
    const owner = await signup('dash_perms@cellivo.lk', 'Perms Shop');
    const tenantId = owner.user.tenant?._id;

    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    // Create a sale and a repair intake
    await runWithContext({ tenantId }, async () => {
      const inv = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-PERM-1',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 50000,
        grandTotalCents: 50000,
        totalPaidCents: 50000,
        lines: [{ name: 'Item', qty: 1, unitPriceCents: 50000, grossCents: 50000, netCents: 50000, lineTotalCents: 50000 }],
      });
      await inv.save();

      const ticket = new RepairTicket({
        tenantId,
        branchId,
        ticketNo: 'JOB-PERM-1',
        device: { brand: 'Nokia', model: '3310' },
        faultDescription: 'Battery dead',
        stage: 'Received',
        isArchived: false,
      });
      await ticket.save();
    });

    // Invite technician (has dashboard.view, repairs.view, inventory.view; lacks pos.view, finance.view)
    const tech = await addStaff(owner, 'technician', 'tech_gate@cellivo.lk');
    const res = await api('get', '/api/dashboard', tech.token);
    expect(res.status).toBe(200);
    const data = res.body.data;

    // Technician cannot view POS sales or finance receivables
    expect(data.sales).toBeNull();
    expect(data.receivables).toBeNull();

    // Technician CAN view repairs and stock
    expect(data.activeRepairsCount).toBe(1);
    expect(data.lowStockCount).toBe(0);
    expect(Array.isArray(data.overdueRepairs)).toBe(true);

    // Recent activity feed contains repair events but NO sale events
    expect(data.recentActivity.length).toBeGreaterThanOrEqual(1);
    expect(data.recentActivity.some((e) => e.type === 'sale')).toBe(false);
    expect(data.recentActivity.some((e) => e.type === 'repair_intake')).toBe(true);
  });

  it('5. guarantees tenant isolation: another tenant data never appears in any tile or feed', async () => {
    const shopA = await signup('shop_a@cellivo.lk', 'Shop A');
    const shopB = await signup('shop_b@cellivo.lk', 'Shop B');

    const bA = (await api('get', '/api/branches', shopA.token)).body.data[0]._id;

    // Create sale and repair for Shop A
    await runWithContext({ tenantId: shopA.user.tenant?._id }, async () => {
      const invA = new Invoice({
        tenantId: shopA.user.tenant?._id,
        branchId: bA,
        invoiceNumber: 'INV-A-100',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 999000,
        grandTotalCents: 999000,
        totalPaidCents: 999000,
        lines: [{ name: 'Secret A', qty: 1, unitPriceCents: 999000, grossCents: 999000, netCents: 999000, lineTotalCents: 999000 }],
      });
      await invA.save();

      const ticketA = new RepairTicket({
        tenantId: shopA.user.tenant?._id,
        branchId: bA,
        ticketNo: 'JOB-SECRET-A',
        device: { brand: 'Secret', model: 'Alpha' },
        faultDescription: 'Confidential',
        stage: 'In repair',
        isArchived: false,
      });
      await ticketA.save();
    });

    // Query Shop B's dashboard
    const dashB = await api('get', '/api/dashboard', shopB.token);
    expect(dashB.status).toBe(200);
    const dataB = dashB.body.data;

    expect(dataB.sales.totalCents).toBe(0);
    expect(dataB.sales.count).toBe(0);
    expect(dataB.activeRepairsCount).toBe(0);
    expect(dataB.receivables.totalCents).toBe(0);
    expect(dataB.recentActivity).toHaveLength(0);
  });

  it('6. enforces branch isolation: branch-limited user sees only their branch metrics', async () => {
    const owner = await signup('dash_branches@cellivo.lk', 'Branches Shop');
    const tenantId = owner.user.tenant?._id;

    await runAsPlatform(async () => {
      await Tenant.findByIdAndUpdate(tenantId, { branchLimitOverride: 5 });
    });

    const b1 = (await api('get', '/api/branches', owner.token)).body.data[0]._id;
    const b2Res = await api('post', '/api/branches', owner.token).send({ name: 'Branch Negombo', invoicePrefix: 'BN-' });
    expect(b2Res.status).toBe(201);
    const b2 = b2Res.body.data._id;

    await runWithContext({ tenantId }, async () => {
      const invB1 = new Invoice({
        tenantId,
        branchId: b1,
        invoiceNumber: 'INV-B1-99',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 150000,
        grandTotalCents: 150000,
        totalPaidCents: 150000,
        lines: [{ name: 'B1 Item', qty: 1, unitPriceCents: 150000, grossCents: 150000, netCents: 150000, lineTotalCents: 150000 }],
      });
      await invB1.save();

      const invB2 = new Invoice({
        tenantId,
        branchId: b2,
        invoiceNumber: 'INV-B2-99',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 350000,
        grandTotalCents: 350000,
        totalPaidCents: 350000,
        lines: [{ name: 'B2 Item', qty: 1, unitPriceCents: 350000, grossCents: 350000, netCents: 350000, lineTotalCents: 350000 }],
      });
      await invB2.save();
    });

    // Owner (view_all_branches) sees total: 500,000
    const ownerAll = await api('get', '/api/dashboard', owner.token);
    expect(ownerAll.body.data.sales.totalCents).toBe(500000);

    // Owner filtering by b1: 150,000
    const ownerB1 = await api('get', `/api/dashboard?branchId=${b1}`, owner.token);
    expect(ownerB1.body.data.sales.totalCents).toBe(150000);

    // Owner filtering by b2: 350,000
    const ownerB2 = await api('get', `/api/dashboard?branchId=${b2}`, owner.token);
    expect(ownerB2.body.data.sales.totalCents).toBe(350000);

    // Create staff without view_all_branches
    let noBranchToken;
    let b1OnlyToken;
    let multiBranchToken;

    await runWithContext({ tenantId }, async () => {
      const branchStaffRole = new Role({
        tenantId,
        name: 'Branch Limited Staff Role',
        key: 'branch_staff_role',
        grid: { dashboard: { view: true }, pos: { view: true } },
        special: { view_all_branches: false },
      });
      await branchStaffRole.save();

      // (a) User with no branches assigned (empty array)
      const uNoBranch = new User({
        tenantId,
        branchIds: [],
        name: 'Orphan Staff',
        email: 'orphan@cellivo.lk',
        passwordHash: 'dummy',
        roleId: branchStaffRole._id,
        isActive: true,
      });
      await User.collection.insertOne(uNoBranch.toObject());
      noBranchToken = (await createSession(uNoBranch)).token;

      // (b) User with only branch b1 assigned
      const uB1 = new User({
        tenantId,
        branchIds: [b1],
        name: 'B1 Staff Member',
        email: 'b1only@cellivo.lk',
        passwordHash: 'dummy',
        roleId: branchStaffRole._id,
        isActive: true,
      });
      await uB1.save();
      b1OnlyToken = (await createSession(uB1)).token;

      // (c) User with multiple branches assigned [b1, b2]
      const uMulti = new User({
        tenantId,
        branchIds: [b1, b2],
        name: 'Multi Branch Staff Member',
        email: 'multiroam@cellivo.lk',
        passwordHash: 'dummy',
        roleId: branchStaffRole._id,
        isActive: true,
      });
      await uMulti.save();
      multiBranchToken = (await createSession(uMulti)).token;
    });

    // (a) User without view_all_branches and no branch assigned gets 403
    const noBranchRes = await api('get', '/api/dashboard', noBranchToken);
    expect(noBranchRes.status).toBe(403);

    // (b) User requesting another branch not in their branchIds gets 403
    const forbiddenBranchRes = await api('get', `/api/dashboard?branchId=${b2}`, b1OnlyToken);
    expect(forbiddenBranchRes.status).toBe(403);

    // User requesting their assigned branch b1 gets 200 with b1 metrics
    const b1Res = await api('get', `/api/dashboard?branchId=${b1}`, b1OnlyToken);
    expect(b1Res.status).toBe(200);
    expect(b1Res.body.data.sales.totalCents).toBe(150000);

    // (c) Multi-branch user can pick branch b1 or b2
    const multiB1 = await api('get', `/api/dashboard?branchId=${b1}`, multiBranchToken);
    expect(multiB1.status).toBe(200);
    expect(multiB1.body.data.sales.totalCents).toBe(150000);

    const multiB2 = await api('get', `/api/dashboard?branchId=${b2}`, multiBranchToken);
    expect(multiB2.status).toBe(200);
    expect(multiB2.body.data.sales.totalCents).toBe(350000);
  });

  it('7. returns zeros and empty lists for empty tenant', async () => {
    const owner = await signup('empty_dash@cellivo.lk', 'Empty Shop');
    const res = await api('get', '/api/dashboard', owner.token);
    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.sales.totalCents).toBe(0);
    expect(data.sales.count).toBe(0);
    expect(data.activeRepairsCount).toBe(0);
    expect(data.lowStockCount).toBe(0);
    expect(data.receivables.totalCents).toBe(0);
    expect(data.overdueRepairs).toEqual([]);
    expect(data.recentActivity).toEqual([]);
  });

  it('8. lists overdue repairs with daysOverdue calculation', async () => {
    const owner = await signup('dash_overdue2@cellivo.lk', 'Overdue Shop 2');
    const tenantId = owner.user.tenant?._id;
    const branchId = (await api('get', '/api/branches', owner.token)).body.data[0]._id;

    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    await runWithContext({ tenantId }, async () => {
      const overdueTicket = new RepairTicket({
        tenantId,
        branchId,
        ticketNo: 'JOB-OVERDUE-88',
        device: { brand: 'Xiaomi', model: 'Redmi 12' },
        faultDescription: 'No power',
        stage: 'Diagnosing',
        promisedDate: threeDaysAgo,
        isArchived: false,
      });
      await overdueTicket.save();
    });

    const res = await api('get', '/api/dashboard', owner.token);
    expect(res.status).toBe(200);
    const { overdueRepairs } = res.body.data;

    expect(Array.isArray(overdueRepairs)).toBe(true);
    const found = overdueRepairs.find((t) => t.ticketNo === 'JOB-OVERDUE-88');
    expect(found).toBeDefined();
    expect(found.daysOverdue).toBeGreaterThanOrEqual(2);
    expect(found.stage).toBe('Diagnosing');
  });
});

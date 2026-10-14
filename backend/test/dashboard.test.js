import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import RepairTicket from '../src/modules/repairs/models/RepairTicket.model.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import StockLevel from '../src/modules/inventory/models/StockLevel.model.js';
import Invoice from '../src/modules/pos/models/Invoice.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

describe('F-05 Dashboard API', () => {
  it('requires authentication and dashboard.view permission', async () => {
    // 1. Unauthenticated request -> 401 (rejected by protect middleware)
    const unauth = await api('get', '/api/dashboard');
    expect(unauth.status).toBe(401);

    // 2. Authenticated owner has dashboard.view -> 200
    const owner = await signup('dash_auth@cellivo.lk', 'Auth Shop');
    const res = await api('get', '/api/dashboard', owner.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.sales).toBeDefined();
    expect(res.body.data.activeRepairsCount).toBe(0);
  });

  it('calculates sales, active repairs, low stock, and receivables correctly', async () => {
    const owner = await signup('dash_metrics@cellivo.lk', 'Metrics Shop');
    const tenantId = owner.user.tenant?._id;

    // Get default branch
    const branchRes = await api('get', '/api/branches', owner.token);
    expect(branchRes.status).toBe(200);
    const branchId = branchRes.body.data[0]._id;

    // Create Customer
    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Nimal Silva',
      phone: '0772223344',
    });
    const customerId = custRes.body.data._id;

    await runWithContext({ tenantId }, async () => {
      // Create settled sale invoice
      const inv1 = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-000001',
        status: 'completed',
        paymentStatus: 'paid',
        customerId,
        subtotalCents: 500000,
        grandTotalCents: 500000,
        totalPaidCents: 500000,
        lines: [
          {
            name: 'Charger',
            qty: 1,
            unitPriceCents: 500000,
            grossCents: 500000,
            netCents: 500000,
            lineTotalCents: 500000,
          },
        ],
      });
      await inv1.save();

      // Create unpaid sale invoice (receivable)
      const inv2 = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-000002',
        status: 'completed',
        paymentStatus: 'partially_paid',
        customerId,
        subtotalCents: 800000,
        grandTotalCents: 800000,
        totalPaidCents: 300000, // 500000 due
        lines: [
          {
            name: 'Screen Protector',
            qty: 1,
            unitPriceCents: 800000,
            grossCents: 800000,
            netCents: 800000,
            lineTotalCents: 800000,
          },
        ],
      });
      await inv2.save();

      // Create terminal repair ticket (Delivered - should not count towards active repairs)
      const tDelivered = new RepairTicket({
        tenantId,
        branchId,
        ticketNo: 'JOB-999999',
        customerId,
        device: { brand: 'Apple', model: 'iPhone 11' },
        faultDescription: 'Broken glass',
        stage: 'Delivered',
        isArchived: false,
      });
      await tDelivered.save();

      // Create low stock product
      const prodLow = new Product({
        tenantId,
        name: 'Battery A32',
        barcode: 'BAT-A32-001',
        sellingPriceCents: 450000,
        reorderLevel: 5,
      });
      await prodLow.save();

      const stockLevelLow = new StockLevel({
        tenantId,
        productId: prodLow._id,
        branchId,
        qty: 2, // 2 <= 5 => low stock
      });
      await stockLevelLow.save();

      // Create healthy stock product
      const prodOk = new Product({
        tenantId,
        name: 'Case A32',
        barcode: 'CASE-A32-001',
        sellingPriceCents: 150000,
        reorderLevel: 3,
      });
      await prodOk.save();

      const stockLevelOk = new StockLevel({
        tenantId,
        productId: prodOk._id,
        branchId,
        qty: 10, // 10 > 3 => ok
      });
      await stockLevelOk.save();
    });

    // Create active repair ticket (in_repair) via API
    const tActive = await api('post', '/api/repairs', owner.token).send({
      branchId,
      customerId,
      device: { brand: 'Samsung', model: 'A32' },
      faultDescription: 'No power',
    });
    expect(tActive.status).toBe(201);

    // Query Dashboard
    const dashRes = await api('get', '/api/dashboard?period=today', owner.token);
    expect(dashRes.status).toBe(200);
    const data = dashRes.body.data;

    expect(data.sales.totalCents).toBe(1300000); // 500000 + 800000
    expect(data.sales.count).toBe(2);
    expect(data.activeRepairsCount).toBe(1); // tActive only
    expect(data.lowStockCount).toBe(1); // prodLow only
    expect(data.receivables.unpaidInvoicesCents).toBe(500000); // 800000 - 300000
    expect(data.receivables.totalCents).toBe(500000);
  });

  it('lists overdue repairs with daysOverdue calculation', async () => {
    const owner = await signup('dash_overdue@cellivo.lk', 'Overdue Shop');
    const tenantId = owner.user.tenant?._id;

    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Sunil Dias',
      phone: '0779998877',
    });
    const customerId = custRes.body.data._id;

    // Past promised date: 3 days ago
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    await runWithContext({ tenantId }, async () => {
      const overdueTicket = new RepairTicket({
        tenantId,
        branchId,
        ticketNo: 'JOB-000088',
        customerId,
        device: { brand: 'Xiaomi', model: 'Redmi Note 12' },
        faultDescription: 'Charging port issue',
        stage: 'Diagnosing',
        promisedDate: threeDaysAgo,
        isArchived: false,
      });
      await overdueTicket.save();
    });

    const dashRes = await api('get', '/api/dashboard', owner.token);
    expect(dashRes.status).toBe(200);
    const { overdueRepairs } = dashRes.body.data;

    expect(Array.isArray(overdueRepairs)).toBe(true);
    expect(overdueRepairs.length).toBeGreaterThanOrEqual(1);

    const found = overdueRepairs.find((t) => t.ticketNo === 'JOB-000088');
    expect(found).toBeDefined();
    expect(found.daysOverdue).toBeGreaterThanOrEqual(2);
    expect(found.stage).toBe('Diagnosing');
    expect(found.customer.name).toBe('Sunil Dias');
  });

  it('returns recent activity feed with top 10 events sorted descending', async () => {
    const owner = await signup('dash_activity@cellivo.lk', 'Activity Shop');
    const tenantId = owner.user.tenant?._id;

    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Anura Kumara',
      phone: '0773334455',
    });
    const customerId = custRes.body.data._id;

    // Create a repair ticket via API
    const t1 = await api('post', '/api/repairs', owner.token).send({
      customerId,
      device: { brand: 'Google', model: 'Pixel 7' },
      faultDescription: 'Camera glass crack',
    });
    expect(t1.status).toBe(201);

    // Create a sale inside context
    await runWithContext({ tenantId }, async () => {
      const inv = new Invoice({
        tenantId,
        invoiceNumber: 'INV-ACTIVITY-1',
        status: 'completed',
        paymentStatus: 'paid',
        customerId,
        subtotalCents: 250000,
        grandTotalCents: 250000,
        totalPaidCents: 250000,
        lines: [
          {
            name: 'Case Pixel 7',
            qty: 1,
            unitPriceCents: 250000,
            grossCents: 250000,
            netCents: 250000,
            lineTotalCents: 250000,
          },
        ],
      });
      await inv.save();
    });

    const dashRes = await api('get', '/api/dashboard', owner.token);
    expect(dashRes.status).toBe(200);
    const { recentActivity } = dashRes.body.data;

    expect(Array.isArray(recentActivity)).toBe(true);
    expect(recentActivity.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < recentActivity.length - 1; i++) {
      const tA = new Date(recentActivity[i].timestamp).getTime();
      const tB = new Date(recentActivity[i + 1].timestamp).getTime();
      expect(tA).toBeGreaterThanOrEqual(tB);
    }
  });

  it('enforces branch isolation and filtering for branch-scoped metrics', async () => {
    const owner = await signup('dash_branch@cellivo.lk', 'Branch Dash Shop');
    const tenantId = owner.user.tenant?._id;

    // Set branchLimitOverride = 5 to allow creating extra branches
    await runAsPlatform(async () => {
      await Tenant.findByIdAndUpdate(tenantId, { branchLimitOverride: 5 });
    });

    // Default branch is b1
    const branches = (await api('get', '/api/branches', owner.token)).body.data;
    const b1 = branches[0]._id;

    // Create Branch 2
    const b2Res = await api('post', '/api/branches', owner.token).send({ name: 'Branch Kandy', invoicePrefix: 'BK-' });
    expect(b2Res.status).toBe(201);
    const b2 = b2Res.body.data._id;

    // Create sales in Branch 1 and Branch 2 inside context
    await runWithContext({ tenantId }, async () => {
      const invB1 = new Invoice({
        tenantId,
        branchId: b1,
        invoiceNumber: 'INV-B1',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 100000,
        grandTotalCents: 100000,
        totalPaidCents: 100000,
        lines: [{ name: 'Item B1', qty: 1, unitPriceCents: 100000, grossCents: 100000, netCents: 100000, lineTotalCents: 100000 }],
      });
      await invB1.save();

      const invB2 = new Invoice({
        tenantId,
        branchId: b2,
        invoiceNumber: 'INV-B2',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 200000,
        grandTotalCents: 200000,
        totalPaidCents: 200000,
        lines: [{ name: 'Item B2', qty: 1, unitPriceCents: 200000, grossCents: 200000, netCents: 200000, lineTotalCents: 200000 }],
      });
      await invB2.save();
    });

    // Owner (has view_all_branches) sees both: 300000
    const ownerDash = await api('get', '/api/dashboard', owner.token);
    expect(ownerDash.body.data.sales.totalCents).toBe(300000);

    // Owner can filter by branchId=b1
    const ownerB1Dash = await api('get', `/api/dashboard?branchId=${b1}`, owner.token);
    expect(ownerB1Dash.body.data.sales.totalCents).toBe(100000);

    // Owner can filter by branchId=b2
    const ownerB2Dash = await api('get', `/api/dashboard?branchId=${b2}`, owner.token);
    expect(ownerB2Dash.body.data.sales.totalCents).toBe(200000);
  });
});

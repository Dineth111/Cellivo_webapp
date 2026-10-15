import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import { createSession } from '../src/modules/auth/session.service.js';
import Invoice from '../src/modules/pos/models/Invoice.model.js';
import CreditNote from '../src/modules/pos/models/CreditNote.model.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import StockLevel from '../src/modules/inventory/models/StockLevel.model.js';
import RepairTicket from '../src/modules/repairs/models/RepairTicket.model.js';
import Role from '../src/modules/roles/Role.model.js';
import User from '../src/modules/users/User.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import { escapeCsvCell, buildCsv } from '../src/modules/reports/utils/csvUtils.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

describe('F-17 Reports API', () => {
  it('1. requires authentication and reports.view permission (401 and 403)', async () => {
    // Unauthenticated -> 401
    const unauth = await api('get', '/api/reports/sales');
    expect(unauth.status).toBe(401);

    const owner = await signup('reports_auth@cellivo.lk', 'Reports Auth Shop');
    const tenantId = owner.user.tenant?._id;
    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    // Owner has reports.view -> 200
    const ownerRes = await api('get', '/api/reports/sales', owner.token);
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body.data.summary).toBeDefined();

    // User lacking reports.view -> 403
    let noReportsToken;
    await runWithContext({ tenantId }, async () => {
      const noReportsRole = new Role({
        tenantId,
        name: 'No Reports Role',
        key: 'no_reports',
        grid: { reports: { view: false }, pos: { view: true } },
      });
      await noReportsRole.save();

      const noReportsUser = new User({
        tenantId,
        branchIds: [branchId],
        name: 'No Reports Staff',
        email: 'noreports@cellivo.lk',
        passwordHash: 'dummy',
        roleId: noReportsRole._id,
        isActive: true,
      });
      await noReportsUser.save();

      const s = await createSession(noReportsUser);
      noReportsToken = s.token;
    });

    const forbiddenRes = await api('get', '/api/reports/sales', noReportsToken);
    expect(forbiddenRes.status).toBe(403);
  });

  it('2. enforces 366-day maximum date range and limit <= 200', async () => {
    const owner = await signup('reports_limits@cellivo.lk', 'Reports Limits Shop');

    // 400 days range -> 400
    const wideRes = await api(
      'get',
      '/api/reports/sales?startDate=2025-01-01&endDate=2026-03-01',
      owner.token
    );
    expect(wideRes.status).toBe(400);
    expect(wideRes.body.message).toMatch(/366 days/i);

    // Limit > 200 -> 400
    const limitRes = await api('get', '/api/reports/sales?limit=250', owner.token);
    expect(limitRes.status).toBe(400);
    expect(limitRes.body.message).toMatch(/200/i);
  });

  it('3. generates Sales Report with known totals, netted returns, and view_cost_margin masking', async () => {
    const owner = await signup('reports_sales@cellivo.lk', 'Sales Reports Shop');
    const tenantId = owner.user.tenant?._id;
    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    // Create 2 sales and 1 return
    await runWithContext({ tenantId }, async () => {
      const inv1 = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-REP-001',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 100000,
        grandTotalCents: 100000,
        totalPaidCents: 100000,
        lines: [
          {
            name: 'Display Screen',
            qty: 1,
            unitPriceCents: 100000,
            costPriceCents: 60000,
            grossCents: 100000,
            netCents: 100000,
            lineTotalCents: 100000,
          },
        ],
      });
      await inv1.save();

      const inv2 = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-REP-002',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 50000,
        grandTotalCents: 50000,
        totalPaidCents: 50000,
        lines: [
          {
            name: 'Battery',
            qty: 1,
            unitPriceCents: 50000,
            costPriceCents: 20000,
            grossCents: 50000,
            netCents: 50000,
            lineTotalCents: 50000,
          },
        ],
      });
      await inv2.save();

      const cn = new CreditNote({
        tenantId,
        branchId,
        creditNoteNumber: 'CN-REP-001',
        originalInvoiceId: inv2._id,
        originalInvoiceNumber: 'INV-REP-002',
        subtotalCents: 10000,
        totalRefundCents: 10000,
        items: [{ name: 'Battery Return', qty: 1, unitPriceCents: 10000, refundCents: 10000 }],
      });
      await cn.save();
    });

    // Owner (has view_cost_margin)
    const res = await api('get', '/api/reports/sales', owner.token);
    expect(res.status).toBe(200);
    const summary = res.body.data.summary;

    expect(summary.totalInvoices).toBe(2);
    expect(summary.grossSalesCents).toBe(150000);
    expect(summary.totalRefundsCents).toBe(10000);
    expect(summary.netSalesCents).toBe(140000);
    expect(summary.totalCostCents).toBe(80000);
    expect(summary.grossProfitCents).toBe(60000); // 140,000 - 80,000 = 60,000
    expect(summary.marginPercent).toBeCloseTo(42.86, 1);

    // Cashier / Staff without view_cost_margin
    let noCostToken;
    await runWithContext({ tenantId }, async () => {
      const noCostRole = new Role({
        tenantId,
        name: 'No Cost Role',
        key: 'no_cost',
        grid: { reports: { view: true }, pos: { view: true } },
        special: { view_cost_margin: false },
      });
      await noCostRole.save();

      const noCostUser = new User({
        tenantId,
        branchIds: [branchId],
        name: 'No Cost Staff',
        email: 'nocost@cellivo.lk',
        passwordHash: 'dummy',
        roleId: noCostRole._id,
        isActive: true,
      });
      await noCostUser.save();

      const s = await createSession(noCostUser);
      noCostToken = s.token;
    });

    const noCostRes = await api('get', '/api/reports/sales', noCostToken);
    expect(noCostRes.status).toBe(200);
    const noCostSummary = noCostRes.body.data.summary;

    // Cost and profit must be completely masked (null)
    expect(noCostSummary.totalCostCents).toBeNull();
    expect(noCostSummary.grossProfitCents).toBeNull();
    expect(noCostSummary.marginPercent).toBeNull();

    // Data items cost/profit also masked
    expect(noCostRes.body.data.data[0].costCents).toBeNull();
    expect(noCostRes.body.data.data[0].profitCents).toBeNull();
  });

  it('4. calculates Inventory Valuation report with stock quantities and values', async () => {
    const owner = await signup('reports_inv@cellivo.lk', 'Inventory Reports Shop');
    const tenantId = owner.user.tenant?._id;
    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    await runWithContext({ tenantId }, async () => {
      const p1 = new Product({
        tenantId,
        name: 'Screen Guard',
        barcode: 'SG-001',
        sellingPriceCents: 100000,
        costPriceCents: 40000,
      });
      await p1.save();

      const sl1 = new StockLevel({
        tenantId,
        productId: p1._id,
        branchId,
        qty: 5,
        averageCostCents: 40000,
      });
      await sl1.save();

      const p2 = new Product({
        tenantId,
        name: 'USB Cable',
        barcode: 'USB-001',
        sellingPriceCents: 50000,
        costPriceCents: 20000,
      });
      await p2.save();

      const sl2 = new StockLevel({
        tenantId,
        productId: p2._id,
        branchId,
        qty: 10,
        averageCostCents: 20000,
      });
      await sl2.save();
    });

    const res = await api('get', '/api/reports/inventory', owner.token);
    expect(res.status).toBe(200);
    const summary = res.body.data.summary;

    expect(summary.totalProducts).toBe(2);
    expect(summary.totalUnits).toBe(15);
    // 5 * 100,000 + 10 * 50,000 = 500,000 + 500,000 = 1,000,000
    expect(summary.totalRetailValueCents).toBe(1000000);
    // 5 * 40,000 + 10 * 20,000 = 200,000 + 200,000 = 400,000
    expect(summary.totalCostValueCents).toBe(400000);
    expect(summary.potentialProfitCents).toBe(600000);
  });

  it('5. calculates Repairs Report with stage counts and revenue metrics', async () => {
    const owner = await signup('reports_rep@cellivo.lk', 'Repairs Reports Shop');
    const tenantId = owner.user.tenant?._id;
    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;
    const custRes = await api('post', '/api/customers', owner.token).send({ name: 'Kamal Perera', phone: '0711112233' });
    const customerId = custRes.body.data._id;

    await runWithContext({ tenantId }, async () => {
      // 1. Invoiced & Delivered ticket (customer owned) -> COUNTS in revenue & profit
      const t1 = new RepairTicket({
        tenantId,
        branchId,
        customerId,
        ticketNo: 'JOB-REP-01',
        stage: 'Delivered',
        device: { brand: 'Apple', model: 'iPhone 13' },
        faultDescription: 'Broken Glass',
        labourCents: 50000,
        parts: [
          {
            name: 'Original OLED',
            qty: 1,
            unitPriceCents: 75000,
            unitCostCents: 40000,
          },
        ],
        partsCostCents: 40000,
        advanceCents: 25000,
        isInvoiceSettled: true,
        isArchived: false,
      });
      await t1.save();

      // 2. Active ticket (In repair, unsettled) -> activeCount + 1, NO revenue
      const t2 = new RepairTicket({
        tenantId,
        branchId,
        customerId,
        ticketNo: 'JOB-REP-02',
        stage: 'In repair',
        device: { brand: 'Samsung', model: 'S22' },
        faultDescription: 'No Sound',
        labourCents: 30000,
        parts: [
          {
            name: 'Speaker module',
            qty: 1,
            unitPriceCents: 20000,
            unitCostCents: 10000,
          },
        ],
        partsCostCents: 10000,
        advanceCents: 0,
        isInvoiceSettled: false,
        isArchived: false,
      });
      await t2.save();

      // 3. Cancelled ticket -> cancelledCount + 1, NO revenue
      const t3 = new RepairTicket({
        tenantId,
        branchId,
        customerId,
        ticketNo: 'JOB-REP-03',
        stage: 'Cancelled',
        device: { brand: 'Google', model: 'Pixel 7' },
        faultDescription: 'Water damage',
        labourCents: 15000,
        isInvoiceSettled: false,
        isArchived: false,
      });
      await t3.save();
    });

    const res = await api('get', '/api/reports/repairs', owner.token);
    expect(res.status).toBe(200);
    const summary = res.body.data.summary;

    expect(summary.totalTickets).toBe(3);
    expect(summary.deliveredCount).toBe(1);
    expect(summary.activeCount).toBe(1);
    expect(summary.cancelledCount).toBe(1);
    expect(summary.totalRevenueCents).toBe(125000);
    expect(summary.totalLabourCents).toBe(50000);
    expect(summary.totalPartsSellingCents).toBe(75000);
    expect(summary.totalPartsCostCents).toBe(40000);
    expect(summary.netRepairsProfitCents).toBe(85000);
  });

  it('6. calculates Receivables Aging report with bucketed outstanding balances', async () => {
    const owner = await signup('reports_ar@cellivo.lk', 'Receivables Reports Shop');
    const tenantId = owner.user.tenant?._id;
    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    await runWithContext({ tenantId }, async () => {
      // Recent unpaid: 10 days old, 50,000 cents
      const invRecent = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-AR-01',
        status: 'completed',
        paymentStatus: 'unpaid',
        grandTotalCents: 50000,
        totalPaidCents: 0,
        subtotalCents: 50000,
        lines: [{ name: 'Item A', qty: 1, unitPriceCents: 50000, grossCents: 50000, netCents: 50000, lineTotalCents: 50000 }],
        createdAt: daysAgo(10),
      });
      await invRecent.save();

      // Overdue 45 days: 45 days old, 80,000 cents grand total, 30,000 paid -> 50,000 due
      const inv45 = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-AR-02',
        status: 'completed',
        paymentStatus: 'partially_paid',
        grandTotalCents: 80000,
        totalPaidCents: 30000,
        subtotalCents: 80000,
        lines: [{ name: 'Item B', qty: 1, unitPriceCents: 80000, grossCents: 80000, netCents: 80000, lineTotalCents: 80000 }],
        createdAt: daysAgo(45),
      });
      await inv45.save();
    });

    const res = await api('get', '/api/reports/receivables', owner.token);
    expect(res.status).toBe(200);
    const summary = res.body.data.summary;

    expect(summary.totalInvoices).toBe(2);
    expect(summary.totalReceivablesCents).toBe(100000); // 50k + 50k
    expect(summary.aging.current0to30Cents).toBe(50000);
    expect(summary.aging.overdue31to60Cents).toBe(50000);
  });

  it('7. CSV export escapes formula injection (=, +, -, @) and requires export_reports permission', async () => {
    const owner = await signup('reports_csv@cellivo.lk', 'CSV Export Shop');
    const tenantId = owner.user.tenant?._id;
    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    // Create a product with malicious formula names and symbols
    await runWithContext({ tenantId }, async () => {
      const pMalicious = new Product({
        tenantId,
        name: '=cmd|’ /C calc’!A0',
        barcode: '+94770001122',
        sku: '-DISCOUNT-CODE',
        description: '@danger_user',
        sellingPriceCents: 15000,
      });
      await pMalicious.save();

      const sl = new StockLevel({
        tenantId,
        productId: pMalicious._id,
        branchId,
        qty: 2,
        averageCostCents: 5000,
      });
      await sl.save();
    });

    // Owner has export_reports special permission
    const exportRes = await api('get', '/api/reports/inventory/export', owner.token);
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers['content-type']).toMatch(/text\/csv/);

    const csvText = exportRes.text;

    // Check that formula prefixes on strings are escaped with a prepended single quote "'"
    expect(csvText).toContain("'=cmd|’ /C calc’!A0");
    expect(csvText).toContain("'+94770001122");
    expect(csvText).toContain("'-DISCOUNT-CODE");

    // Test buildCsv with formulas, \t, \r, and negative numbers:
    // formula and whitespace prefixes get escaped; negative numbers stay numbers (not prepended with single quote)
    const testCsv = buildCsv(
      [
        { key: 'name', label: 'Name' },
        { key: 'tabbed', label: 'Tab' },
        { key: 'returned', label: 'CR' },
        { key: 'negativeInt', label: 'Int' },
        { key: 'negativeFloat', label: 'Float' },
      ],
      [
        {
          name: '=formula',
          tabbed: '\tTabFormula',
          returned: '\rReturnFormula',
          negativeInt: -500,
          negativeFloat: -12.5,
        },
      ]
    );
    expect(testCsv).toContain("'=formula");
    expect(testCsv).toContain("'\tTabFormula");
    expect(testCsv).toContain("'\rReturnFormula");
    expect(testCsv).toContain(",-500,-12.5");
    expect(testCsv).not.toContain("'-500");
    expect(testCsv).not.toContain("'-12.5");

    // Direct unit test of escapeCsvCell: numbers vs strings
    expect(escapeCsvCell(-500)).toBe('-500');
    expect(escapeCsvCell(-12.5)).toBe('-12.5');
    expect(escapeCsvCell('=-500')).toBe("'=-500");
    expect(escapeCsvCell('\tfoo')).toBe("'\tfoo");
    expect(escapeCsvCell('\rbar')).toBe("\"'\rbar\"");
    expect(escapeCsvCell('@admin')).toBe("'@admin");

    // Staff without export_reports -> 403
    let noExportToken;
    await runWithContext({ tenantId }, async () => {
      const noExportRole = new Role({
        tenantId,
        name: 'No Export Role',
        key: 'no_export',
        grid: { reports: { view: true } },
        special: { export_reports: false },
      });
      await noExportRole.save();

      const noExportUser = new User({
        tenantId,
        branchIds: [branchId],
        name: 'No Export Staff',
        email: 'noexport@cellivo.lk',
        passwordHash: 'dummy',
        roleId: noExportRole._id,
        isActive: true,
      });
      await noExportUser.save();

      const s = await createSession(noExportUser);
      noExportToken = s.token;
    });

    const exportForbidden = await api('get', '/api/reports/inventory/export', noExportToken);
    expect(exportForbidden.status).toBe(403);
  });

  it('8. guarantees tenant isolation: cross-tenant data never leaks into reports', async () => {
    const shopA = await signup('tenant_a@cellivo.lk', 'Tenant A Reports');
    const shopB = await signup('tenant_b@cellivo.lk', 'Tenant B Reports');

    const bA = (await api('get', '/api/branches', shopA.token)).body.data[0]._id;
    const bB = (await api('get', '/api/branches', shopB.token)).body.data[0]._id;

    // Create sale for Shop A
    await runWithContext({ tenantId: shopA.user.tenant?._id }, async () => {
      const invA = new Invoice({
        tenantId: shopA.user.tenant?._id,
        branchId: bA,
        invoiceNumber: 'INV-A-999',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 99000,
        grandTotalCents: 99000,
        totalPaidCents: 99000,
        lines: [{ name: 'Secret Item A', qty: 1, unitPriceCents: 99000, grossCents: 99000, netCents: 99000, lineTotalCents: 99000 }],
      });
      await invA.save();
    });

    // Create sale for Shop B
    await runWithContext({ tenantId: shopB.user.tenant?._id }, async () => {
      const invB = new Invoice({
        tenantId: shopB.user.tenant?._id,
        branchId: bB,
        invoiceNumber: 'INV-B-111',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 11000,
        grandTotalCents: 11000,
        totalPaidCents: 11000,
        lines: [{ name: 'Item B', qty: 1, unitPriceCents: 11000, grossCents: 11000, netCents: 11000, lineTotalCents: 11000 }],
      });
      await invB.save();
    });

    // Check Shop A reports: sees only INV-A-999, never INV-B-111
    const resA = await api('get', '/api/reports/sales', shopA.token);
    expect(resA.status).toBe(200);
    expect(resA.body.data.summary.totalInvoices).toBe(1);
    expect(resA.body.data.summary.netSalesCents).toBe(99000);
    expect(resA.body.data.data.some((i) => i.invoiceNumber === 'INV-A-999')).toBe(true);
    expect(resA.body.data.data.some((i) => i.invoiceNumber === 'INV-B-111')).toBe(false);

    // Check Shop B reports: sees only INV-B-111, never INV-A-999
    const resB = await api('get', '/api/reports/sales', shopB.token);
    expect(resB.status).toBe(200);
    expect(resB.body.data.summary.totalInvoices).toBe(1);
    expect(resB.body.data.summary.netSalesCents).toBe(11000);
    expect(resB.body.data.data.some((i) => i.invoiceNumber === 'INV-B-111')).toBe(true);
    expect(resB.body.data.data.some((i) => i.invoiceNumber === 'INV-A-999')).toBe(false);
  });

  it('9. returns zeros and empty arrays for empty tenant without error', async () => {
    const emptyOwner = await signup('reports_empty@cellivo.lk', 'Empty Reports Shop');

    const salesRes = await api('get', '/api/reports/sales', emptyOwner.token);
    expect(salesRes.status).toBe(200);
    expect(salesRes.body.data.summary.totalInvoices).toBe(0);
    expect(salesRes.body.data.summary.netSalesCents).toBe(0);
    expect(salesRes.body.data.data).toEqual([]);

    const invRes = await api('get', '/api/reports/inventory', emptyOwner.token);
    expect(invRes.status).toBe(200);
    expect(invRes.body.data.summary.totalProducts).toBe(0);
    expect(invRes.body.data.summary.totalUnits).toBe(0);
    expect(invRes.body.data.data).toEqual([]);

    const repairsRes = await api('get', '/api/reports/repairs', emptyOwner.token);
    expect(repairsRes.status).toBe(200);
    expect(repairsRes.body.data.summary.totalTickets).toBe(0);
    expect(repairsRes.body.data.data).toEqual([]);

    const arRes = await api('get', '/api/reports/receivables', emptyOwner.token);
    expect(arRes.status).toBe(200);
    expect(arRes.body.data.summary.totalInvoices).toBe(0);
    expect(arRes.body.data.summary.totalReceivablesCents).toBe(0);
    expect(arRes.body.data.data).toEqual([]);
  });

  it('10. enforces fail-closed branch scoping for branch-limited users', async () => {
    const owner = await signup('reports_branches@cellivo.lk', 'Branch Reports Shop');
    const tenantId = owner.user.tenant?._id;

    await runAsPlatform(async () => {
      await Tenant.findByIdAndUpdate(tenantId, { branchLimitOverride: 5 });
    });

    const b1 = (await api('get', '/api/branches', owner.token)).body.data[0]._id;
    const b2Res = await api('post', '/api/branches', owner.token).send({ name: 'Branch Kandy', invoicePrefix: 'BK-' });
    expect(b2Res.status).toBe(201);
    const b2 = b2Res.body.data._id;

    await runWithContext({ tenantId }, async () => {
      const invB1 = new Invoice({
        tenantId,
        branchId: b1,
        invoiceNumber: 'INV-B1-01',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 100000,
        grandTotalCents: 100000,
        totalPaidCents: 100000,
        lines: [{ name: 'B1 Item', qty: 1, unitPriceCents: 100000, grossCents: 100000, netCents: 100000, lineTotalCents: 100000 }],
      });
      await invB1.save();

      const invB2 = new Invoice({
        tenantId,
        branchId: b2,
        invoiceNumber: 'INV-B2-01',
        status: 'completed',
        paymentStatus: 'paid',
        subtotalCents: 200000,
        grandTotalCents: 200000,
        totalPaidCents: 200000,
        lines: [{ name: 'B2 Item', qty: 1, unitPriceCents: 200000, grossCents: 200000, netCents: 200000, lineTotalCents: 200000 }],
      });
      await invB2.save();
    });

    let noBranchToken;
    let b1OnlyToken;
    let multiBranchToken;

    await runWithContext({ tenantId }, async () => {
      const branchStaffRole = new Role({
        tenantId,
        name: 'Report Branch Limited Role',
        key: 'report_branch_staff',
        grid: { reports: { view: true } },
        special: { view_all_branches: false, export_reports: true },
      });
      await branchStaffRole.save();

      // (a) User with no branches assigned
      const uNoBranch = new User({
        tenantId,
        branchIds: [],
        name: 'No Branch Reporter',
        email: 'nobranch_rep@cellivo.lk',
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
        name: 'B1 Reporter',
        email: 'b1_rep@cellivo.lk',
        passwordHash: 'dummy',
        roleId: branchStaffRole._id,
        isActive: true,
      });
      await uB1.save();
      b1OnlyToken = (await createSession(uB1)).token;

      // (c) Multi-branch user with [b1, b2]
      const uMulti = new User({
        tenantId,
        branchIds: [b1, b2],
        name: 'Multi Branch Reporter',
        email: 'multi_rep@cellivo.lk',
        passwordHash: 'dummy',
        roleId: branchStaffRole._id,
        isActive: true,
      });
      await uMulti.save();
      multiBranchToken = (await createSession(uMulti)).token;
    });

    // (a) User with no branches assigned gets 403
    const noBranchRes = await api('get', '/api/reports/sales', noBranchToken);
    expect(noBranchRes.status).toBe(403);
    expect(noBranchRes.body.message).toMatch(/no branch assigned/i);

    // (b) User requesting another branch gets 403
    const forbiddenBranchRes = await api('get', `/api/reports/sales?branchId=${b2}`, b1OnlyToken);
    expect(forbiddenBranchRes.status).toBe(403);
    expect(forbiddenBranchRes.body.message).toMatch(/forbidden/i);

    // Default request for b1 user scopes to b1
    const b1Default = await api('get', '/api/reports/sales', b1OnlyToken);
    expect(b1Default.status).toBe(200);
    expect(b1Default.body.data.summary.netSalesCents).toBe(100000);

    // (c) Multi-branch user can pick their own branches
    const multiB1 = await api('get', `/api/reports/sales?branchId=${b1}`, multiBranchToken);
    expect(multiB1.status).toBe(200);
    expect(multiB1.body.data.summary.netSalesCents).toBe(100000);

    const multiB2 = await api('get', `/api/reports/sales?branchId=${b2}`, multiBranchToken);
    expect(multiB2.status).toBe(200);
    expect(multiB2.body.data.summary.netSalesCents).toBe(200000);
  });

  it('11. excludes held and draft invoices from sales and receivables reports', async () => {
    const owner = await signup('reports_draft@cellivo.lk', 'Draft Invoices Shop');
    const tenantId = owner.user.tenant?._id;
    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    await runWithContext({ tenantId }, async () => {
      // 1. Completed invoice: 50,000 cents (unpaid) -> MUST be in sales and receivables
      const invCompleted = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-VALID-01',
        status: 'completed',
        paymentStatus: 'unpaid',
        grandTotalCents: 50000,
        subtotalCents: 50000,
        totalPaidCents: 0,
        lines: [{ name: 'Screen Protector', qty: 1, unitPriceCents: 50000, grossCents: 50000, netCents: 50000, lineTotalCents: 50000 }],
      });
      await invCompleted.save();

      // 2. Draft invoice: 30,000 cents -> EXCLUDED from sales and receivables
      const invDraft = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-DRAFT-01',
        status: 'draft',
        paymentStatus: 'unpaid',
        grandTotalCents: 30000,
        subtotalCents: 30000,
        totalPaidCents: 0,
        lines: [{ name: 'Cable', qty: 1, unitPriceCents: 30000, grossCents: 30000, netCents: 30000, lineTotalCents: 30000 }],
      });
      await invDraft.save();

      // 3. Voided invoice: 20,000 cents -> EXCLUDED from sales and receivables
      const invVoided = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-VOID-01',
        status: 'voided',
        paymentStatus: 'unpaid',
        grandTotalCents: 20000,
        subtotalCents: 20000,
        totalPaidCents: 0,
        lines: [{ name: 'Case', qty: 1, unitPriceCents: 20000, grossCents: 20000, netCents: 20000, lineTotalCents: 20000 }],
      });
      await invVoided.save();
    });

    const salesRes = await api('get', '/api/reports/sales', owner.token);
    expect(salesRes.status).toBe(200);
    expect(salesRes.body.data.summary.totalInvoices).toBe(1);
    expect(salesRes.body.data.summary.grossSalesCents).toBe(50000);

    const recRes = await api('get', '/api/reports/receivables', owner.token);
    expect(recRes.status).toBe(200);
    expect(recRes.body.data.summary.totalInvoices).toBe(1);
    expect(recRes.body.data.summary.totalReceivablesCents).toBe(50000);
  });

  it('12. repairs report validates stage and technicianId, filters by technician, and excludes cancelled tickets from revenue', async () => {
    const owner = await signup('reports_tech_filter@cellivo.lk', 'Tech Filter Shop');
    const tenantId = owner.user.tenant?._id;
    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    // Validate 400 on malformed queries
    const badStageObj = await api('get', '/api/reports/repairs?stage[$ne]=Cancelled', owner.token);
    expect(badStageObj.status).toBe(400);

    const badStageUnknown = await api('get', '/api/reports/repairs?stage=NonExistentStage', owner.token);
    expect(badStageUnknown.status).toBe(400);

    const badTechId = await api('get', '/api/reports/repairs?technicianId=not-an-objectid', owner.token);
    expect(badTechId.status).toBe(400);

    // Create a technician staff user
    const staffRes = await addStaff(owner, 'technician', 'tech_assigned@cellivo.lk');
    const techUser = staffRes.user;

    const custRes = await api('post', '/api/customers', owner.token).send({ name: 'Saman Kumara', phone: '0779998877' });
    const customerId = custRes.body.data._id;

    await runWithContext({ tenantId }, async () => {
      // Ticket 1 assigned to technician: Delivered & settled (60,000 cents)
      const tAssigned = new RepairTicket({
        tenantId,
        branchId,
        customerId,
        technicianId: techUser._id,
        ticketNo: 'JOB-TECH-01',
        stage: 'Delivered',
        device: { brand: 'Xiaomi', model: 'Note 11' },
        faultDescription: 'Screen issue',
        labourCents: 60000,
        isInvoiceSettled: true,
        isArchived: false,
      });
      await tAssigned.save();

      // Ticket 2 unassigned (technicianId: null): Delivered & settled (40,000 cents)
      const tUnassigned = new RepairTicket({
        tenantId,
        branchId,
        customerId,
        technicianId: null,
        ticketNo: 'JOB-UNASSIGNED-01',
        stage: 'Delivered',
        device: { brand: 'Vivo', model: 'Y20' },
        faultDescription: 'Mic issue',
        labourCents: 40000,
        isInvoiceSettled: true,
        isArchived: false,
      });
      await tUnassigned.save();
    });

    // All tickets without technician filter -> totalRevenue = 100,000
    const allRes = await api('get', '/api/reports/repairs', owner.token);
    expect(allRes.status).toBe(200);
    expect(allRes.body.data.summary.totalRevenueCents).toBe(100000);

    // Filter by technicianId -> totalRevenue = 60,000, only 1 ticket returned
    const techFilterRes = await api('get', `/api/reports/repairs?technicianId=${techUser._id}`, owner.token);
    expect(techFilterRes.status).toBe(200);
    expect(techFilterRes.body.data.summary.totalRevenueCents).toBe(60000);
    expect(techFilterRes.body.data.summary.totalTickets).toBe(1);
    expect(techFilterRes.body.data.data[0].technicianName).toBe(techUser.name);
  });

  it('13. inventory valuation computes sum over each stock level of qty * averageCostCents and excludes non-stock products', async () => {
    const owner = await signup('reports_multistock@cellivo.lk', 'Multi Stock Shop');
    const tenantId = owner.user.tenant?._id;

    await runAsPlatform(async () => {
      await Tenant.findByIdAndUpdate(tenantId, { branchLimitOverride: 5 });
    });

    const b1 = (await api('get', '/api/branches', owner.token)).body.data[0]._id;
    const b2Res = await api('post', '/api/branches', owner.token).send({
      name: 'Branch Kandy',
      invoicePrefix: 'BK-',
    });
    expect(b2Res.status).toBe(201);
    const b2 = b2Res.body.data._id;

    await runWithContext({ tenantId }, async () => {
      // Product 1: In 2 branches with different average costs
      // Branch 1: qty = 10, averageCost = 10,000 cents -> 100,000 cents
      // Branch 2: qty = 5, averageCost = 20,000 cents -> 100,000 cents
      // Sum over each stock level = 200,000 cents (NOT 15 * 15,000 = 225,000 cents)
      const p1 = new Product({
        tenantId,
        name: 'Battery Pack',
        barcode: 'BP-001',
        sellingPriceCents: 30000,
        reorderLevel: 8,
        trackStock: true,
      });
      await p1.save();

      const sl1 = new StockLevel({
        tenantId,
        branchId: b1,
        productId: p1._id,
        qty: 10,
        averageCostCents: 10000,
      });
      await sl1.save();

      const sl2 = new StockLevel({
        tenantId,
        branchId: b2,
        productId: p1._id,
        qty: 5,
        averageCostCents: 20000,
      });
      await sl2.save();

      // Product 2: Non-stock-tracked product -> MUST be excluded from inventory valuation
      const p2Id = new (await import('mongoose')).default.Types.ObjectId();
      await Product.collection.insertOne({
        _id: p2Id,
        tenantId,
        name: 'Software Upgrade Service',
        barcode: 'SRV-001',
        sellingPriceCents: 40000,
        reorderLevel: 0,
        trackStock: false,
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    const res = await api('get', '/api/reports/inventory', owner.token);
    expect(res.status).toBe(200);
    const summary = res.body.data.summary;

    expect(summary.totalProducts).toBe(1);
    expect(summary.totalUnits).toBe(15);
    // Exact sum over each stock level: (10 * 10,000) + (5 * 20,000) = 200,000 cents
    expect(summary.totalCostValueCents).toBe(200000);
    // Retail value: 15 * 30,000 = 450,000 cents
    expect(summary.totalRetailValueCents).toBe(450000);

    // Single branch filter: b1 only -> totalUnits = 10, totalCostValueCents = 100000
    const resB1 = await api('get', `/api/reports/inventory?branchId=${b1}`, owner.token);
    expect(resB1.status).toBe(200);
    expect(resB1.body.data.summary.totalUnits).toBe(10);
    expect(resB1.body.data.summary.totalCostValueCents).toBe(100000);
  });

  it('14. CSV export formats negative profit and refunds without apostrophe, and exports > 200 rows without silent truncation', async () => {
    const owner = await signup('reports_csv_negative@cellivo.lk', 'Negative CSV Shop');
    const tenantId = owner.user.tenant?._id;
    const branchRes = await api('get', '/api/branches', owner.token);
    const branchId = branchRes.body.data[0]._id;

    await runWithContext({ tenantId }, async () => {
      // 1. Sale with negative profit: selling price 5,000 cents, cost price 17,500 cents -> profit = -12,500 cents (-125.00 Rs)
      const invNegative = new Invoice({
        tenantId,
        branchId,
        invoiceNumber: 'INV-LOSS-01',
        status: 'completed',
        paymentStatus: 'paid',
        grandTotalCents: 5000,
        subtotalCents: 5000,
        totalPaidCents: 5000,
        lines: [
          {
            name: 'Clearance Case',
            qty: 1,
            unitPriceCents: 5000,
            costPriceCents: 17500,
            grossCents: 5000,
            netCents: 5000,
            lineTotalCents: 5000,
          },
        ],
      });
      await invNegative.save();

      // 2. Refund CreditNote: 2,000 cents refund
      const cn = new CreditNote({
        tenantId,
        branchId,
        creditNoteNumber: 'CN-REFUND-01',
        originalInvoiceId: invNegative._id,
        originalInvoiceNumber: invNegative.invoiceNumber,
        subtotalCents: 2000,
        totalRefundCents: 2000,
        items: [{ name: 'Clearance Case', qty: 1, unitPriceCents: 2000, refundCents: 2000 }],
      });
      await cn.save();

      // 3. Batch seed 205 invoices to test > 200 rows pagination without truncation
      const tObjId = new mongoose.Types.ObjectId(tenantId);
      const bObjId = new mongoose.Types.ObjectId(branchId);
      const bulkInvoices = [];
      for (let i = 1; i <= 205; i++) {
        bulkInvoices.push({
          tenantId: tObjId,
          branchId: bObjId,
          invoiceNumber: `INV-BULK-${String(i).padStart(4, '0')}`,
          status: 'completed',
          paymentStatus: 'paid',
          grandTotalCents: 10000,
          subtotalCents: 10000,
          totalPaidCents: 10000,
          lines: [{ name: 'Bulk Item', qty: 1, unitPriceCents: 10000, grossCents: 10000, netCents: 10000, lineTotalCents: 10000 }],
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      await Invoice.collection.insertMany(bulkInvoices);
    });

    const exportRes = await api('get', '/api/reports/sales/export', owner.token);
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers['content-type']).toMatch(/text\/csv/);

    const csvText = exportRes.text;

    // (a) Verify negative profit format: "-125.00" must NOT be prefixed with apostrophe "'-125.00"
    expect(csvText).toContain('-125.00');
    expect(csvText).not.toContain("'-125.00");

    // (b) Verify that all 206 invoices are exported (not truncated at page 1 / 200 items)
    const lines = csvText.trim().split('\r\n');
    // Header + at least 206 data rows
    expect(lines.length).toBeGreaterThanOrEqual(207);
    expect(csvText).toContain('INV-LOSS-01');
    expect(csvText).toContain('INV-BULK-0001');
    expect(csvText).toContain('INV-BULK-0205');
  });
});

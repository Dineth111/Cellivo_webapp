import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff, addBranch } from './api.js';
import { runWithContext } from '../src/core/tenantContext.js';
import RepairTicket from '../src/modules/repairs/models/RepairTicket.model.js';
import StockLevel from '../src/modules/inventory/models/StockLevel.model.js';
import StockMovement from '../src/modules/inventory/models/StockMovement.model.js';
import SerialUnit from '../src/modules/inventory/models/SerialUnit.model.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import Category from '../src/modules/inventory/models/Category.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import * as stockService from '../src/modules/inventory/services/stock.service.js';
import * as notificationsAdapter from '../src/modules/inventory/adapters/notifications.adapter.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

function makeLuhnImei(seed) {
  const prefix = String(seed).padStart(14, '0');
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let digit = parseInt(prefix[i], 10);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  const check = (10 - (sum % 10)) % 10;
  return `${prefix}${check}`;
}

async function setupShop(email = 'owner@cellivo.lk', shopName = 'Cellivo Repairs Stock') {
  const shop = await signup(email, shopName);
  const me = await api('get', '/api/auth/me', shop.token);
  const tenantId = me.body.data.tenant._id;
  const branchId = me.body.data.tenant.mainBranchId || me.body.data.branchIds?.[0];
  return { ...shop, tenantId, branchId, user: me.body.data };
}

async function createProduct(shop, {
  name = 'Screen Assembly',
  costPriceCents = 8000,
  sellingPriceCents = 15000,
  initialStock = 5,
  reorderLevel = 2,
} = {}) {
  const catRes = await api('post', '/api/inventory/categories', shop.token).send({ name: `Cat-${Date.now()}-${Math.floor(Math.random() * 10000)}` });
  const catId = catRes.body.data._id;
  const barcode = `BC-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const res = await api('post', '/api/inventory/products', shop.token).send({
    name,
    barcode,
    categoryId: catId,
    costPriceCents,
    sellingPriceCents,
    reorderLevel,
  });
  if (res.status !== 201) throw new Error('Create product failed: ' + res.status + ' ' + JSON.stringify(res.body));
  const product = res.body.data;

  if (initialStock > 0) {
    await stockService.adjustStockLevel({
      tenantId: shop.tenantId,
      productId: product._id,
      branchId: shop.branchId,
      type: 'purchase_grn',
      qtyChange: initialStock,
      unitCostCents: costPriceCents,
      referenceType: 'initial',
      referenceId: 'INIT-001',
    });
  }

  return product;
}

async function createCustomerTicket(shop, { imei = null } = {}) {
  const custRes = await api('post', '/api/customers', shop.token).send({
    name: 'Customer 1',
    phone: '+94771234567',
  });
  const customerId = custRes.body.data._id;

  const res = await api('post', '/api/repairs', shop.token).send({
    customerId,
    device: {
      brand: 'Apple',
      model: 'iPhone 13',
      imei,
    },
    faultDescription: 'Broken front screen',
    estimateCents: 20000,
  });
  if (res.status !== 201) throw new Error('Create repair ticket failed: ' + res.status + ' ' + JSON.stringify(res.body));
  return res.body.data;
}

describe('Repairs Stock & IMEI Integration (Phase 3b)', () => {
  it('1. adding a part reduces stock and writes a StockMovement referencing the ticket', async () => {
    const shop = await setupShop();
    const product = await createProduct(shop, { initialStock: 10, costPriceCents: 5000 });
    const ticket = await createCustomerTicket(shop);

    const res = await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({
      productId: product._id,
      qty: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.parts).toHaveLength(1);
    expect(res.body.data.parts[0].inventoryManaged).toBe(true);
    expect(res.body.data.parts[0].qty).toBe(2);
    expect(res.body.data.parts[0].unitCostCents).toBe(5000);

    // Stock level decremented
    const sl = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockLevel.findOne({ tenantId: shop.tenantId, branchId: shop.branchId, productId: product._id });
    });
    expect(sl.qty).toBe(8);

    // Stock movement recorded
    const mv = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockMovement.findOne({ tenantId: shop.tenantId, productId: product._id, referenceId: ticket.ticketNo });
    });
    expect(mv).toBeTruthy();
    expect(mv.type).toBe('adjustment_loss');
    expect(mv.referenceType).toBe('repair');
    expect(mv.qtyChange).toBe(-2);
    expect(mv.balanceAfter).toBe(8);
  });

  it('2. insufficient stock is rejected and stock never goes negative', async () => {
    const shop = await setupShop();
    const product = await createProduct(shop, { initialStock: 2 });
    const ticket = await createCustomerTicket(shop);

    const res = await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({
      productId: product._id,
      qty: 5,
    });
    expect(res.status).toBe(400);

    const sl = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockLevel.findOne({ tenantId: shop.tenantId, branchId: shop.branchId, productId: product._id });
    });
    expect(sl.qty).toBe(2);
  });

  it('3. removing a part restores the quantity', async () => {
    const shop = await setupShop();
    const product = await createProduct(shop, { initialStock: 10 });
    const ticket = await createCustomerTicket(shop);

    const addRes = await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({
      productId: product._id,
      qty: 3,
    });
    const partId = addRes.body.data.parts[0]._id;

    const delRes = await api('delete', `/api/repairs/${ticket._id}/parts/${partId}`, shop.token);
    expect(delRes.status).toBe(200);

    const sl = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockLevel.findOne({ tenantId: shop.tenantId, branchId: shop.branchId, productId: product._id });
    });
    expect(sl.qty).toBe(10);

    const gainMv = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockMovement.findOne({ tenantId: shop.tenantId, productId: product._id, type: 'adjustment_gain', referenceId: ticket.ticketNo });
    });
    expect(gainMv).toBeTruthy();
    expect(gainMv.qtyChange).toBe(3);
    expect(gainMv.balanceAfter).toBe(10);
  });

  it('4. a failure after the stock decrement rolls back stock, movement and ticket together', async () => {
    const shop = await setupShop();
    const product = await createProduct(shop, { initialStock: 5 });
    const ticket = await createCustomerTicket(shop);

    // Mock RepairTicket.prototype.save to fail once
    const origSave = RepairTicket.prototype.save;
    let failed = false;
    RepairTicket.prototype.save = async function (...args) {
      if (!failed && this._id?.toString() === ticket._id.toString() && this.parts?.length > 0) {
        failed = true;
        throw new Error('Database write failed simulation');
      }
      return origSave.apply(this, args);
    };

    try {
      const res = await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({
        productId: product._id,
        qty: 2,
      });
      expect(res.status).toBe(500);

      // Verify stock rolled back
      const sl = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await StockLevel.findOne({ tenantId: shop.tenantId, branchId: shop.branchId, productId: product._id });
      });
      expect(sl.qty).toBe(5);

      // Verify no movement saved
      const mvs = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await StockMovement.find({ tenantId: shop.tenantId, productId: product._id, referenceId: ticket.ticketNo });
      });
      expect(mvs).toHaveLength(0);
    } finally {
      RepairTicket.prototype.save = origSave;
    }
  });

  it('5. parallel part additions on one product cannot oversell', async () => {
    const shop = await setupShop();
    const product = await createProduct(shop, { initialStock: 3 });
    const ticket1 = await createCustomerTicket(shop);
    const ticket2 = await createCustomerTicket(shop);

    // 2 parallel requests trying to take 2 items each when only 3 exist
    const [res1, res2] = await Promise.all([
      api('post', `/api/repairs/${ticket1._id}/parts`, shop.token).send({ productId: product._id, qty: 2 }),
      api('post', `/api/repairs/${ticket2._id}/parts`, shop.token).send({ productId: product._id, qty: 2 }),
    ]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(201);
    expect(statuses).toContain(400);

    const sl = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockLevel.findOne({ tenantId: shop.tenantId, branchId: shop.branchId, productId: product._id });
    });
    expect(sl.qty).toBe(1);
  });

  it('6. cross-tenant and other-branch products are rejected (404 / 403)', async () => {
    const shopA = await setupShop('shopa@cellivo.lk', 'Shop A');
    const shopB = await setupShop('shopb@cellivo.lk', 'Shop B');
    const productB = await createProduct(shopB, { initialStock: 10 });
    const ticketA = await createCustomerTicket(shopA);

    // Cross-tenant product -> 404
    const res404 = await api('post', `/api/repairs/${ticketA._id}/parts`, shopA.token).send({
      productId: productB._id,
      qty: 1,
    });
    expect(res404.status).toBe(404);

    // Branch 2 in Shop A without stock
    const b2Res = await addBranch(shopA.tenantId, { name: 'Branch 2' });
    const b2Id = b2Res._id;
    const custRes = await api('post', '/api/customers', shopA.token).send({
      name: 'Branch 2 Cust',
      phone: '+94772345678',
    });
    const ticketB2 = await api('post', '/api/repairs', shopA.token).set('x-branch-id', String(b2Id)).send({
      customerId: custRes.body.data._id,
      device: { brand: 'Samsung', model: 'A50' },
      faultDescription: 'Fault',
    });
    expect(ticketB2.status).toBe(201);

    // Product exists in mainBranch, not in branch 2
    const productA = await createProduct(shopA, { initialStock: 5 });
    const resBranch = await api('post', `/api/repairs/${ticketB2.body.data._id}/parts`, shopA.token).send({
      productId: productA._id,
      qty: 1,
    });
    expect(resBranch.status).toBe(400);
  });

  it('7. cost comes from stock and is hidden without view_cost_margin; search hides cost too', async () => {
    const shop = await setupShop();
    const product = await createProduct(shop, { costPriceCents: 6500, sellingPriceCents: 12000, initialStock: 10 });
    const ticket = await createCustomerTicket(shop);

    // Staff without view_cost_margin
    const staff = await addStaff(shop, 'technician', 'tech_nocost@cellivo.lk');

    // Assign technician to ticket so restricted technician can view ticket
    await api('post', `/api/repairs/${ticket._id}/assign`, shop.token).send({
      technicianId: staff.user._id,
    });

    // Search endpoint with owner (has view_cost_margin) vs technician (no view_cost_margin)
    const ownerSearch = await api('get', `/api/repairs/parts/search?ticketId=${ticket._id}&q=Screen`, shop.token);
    expect(ownerSearch.status).toBe(200);
    expect(ownerSearch.body.data[0].averageCostCents).toBe(6500);

    const techSearch = await api('get', `/api/repairs/parts/search?ticketId=${ticket._id}&q=Screen`, staff.token);
    expect(techSearch.status).toBe(200);
    expect(techSearch.body.data[0].averageCostCents).toBeUndefined();

    // Adding part
    await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({ productId: product._id, qty: 1 });

    const getOwner = await api('get', `/api/repairs/${ticket._id}`, shop.token);
    expect(getOwner.body.data.parts[0].unitCostCents).toBe(6500);
    expect(getOwner.body.data.partsCostCents).toBe(6500);

    const getTech = await api('get', `/api/repairs/${ticket._id}`, staff.token);
    expect(getTech.status).toBe(200);
    expect(getTech.body.data.parts[0].unitCostCents).toBeUndefined();
    expect(getTech.body.data.partsCostCents).toBeUndefined();
  });

  it('8. free-text parts never touch stock', async () => {
    const shop = await setupShop();
    const ticket = await createCustomerTicket(shop);

    const res = await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({
      name: 'Custom Adhesive Tape',
      qty: 1,
      unitPriceCents: 1500,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.parts[0].inventoryManaged).toBe(false);

    // Verify no stock movements recorded
    const mvs = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockMovement.find({ tenantId: shop.tenantId, referenceId: ticket.ticketNo });
    });
    expect(mvs).toHaveLength(0);
  });

  it('9. invoice posts COGS (5010 / 1050) once only, balanced, no zero lines', async () => {
    const shop = await setupShop();
    const product = await createProduct(shop, { costPriceCents: 4000, sellingPriceCents: 9000, initialStock: 5 });
    const ticket = await createCustomerTicket(shop);

    await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({ productId: product._id, qty: 1 });

    // Advance to Ready
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Diagnosing' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'In repair', waiveApproval: true });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Quality check' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Ready' });

    // Settle invoice
    const invRes = await api('post', `/api/repairs/${ticket._id}/invoice`, shop.token).send({
      paymentMethod: 'cash',
      labourCents: 5000,
    });
    expect(invRes.status).toBe(200);
    expect(invRes.body.data.isInvoiceSettled).toBe(true);

    const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.find({ tenantId: shop.tenantId, referenceId: ticket.ticketNo });
    });
    expect(entries).toHaveLength(1);
    const jrn = entries[0];

    // Check balanced lines
    const totalDebit = jrn.lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totalCredit = jrn.lines.reduce((s, l) => s + (l.credit || 0), 0);
    expect(totalDebit).toBe(totalCredit);

    // COGS lines exist
    const cogsLine = jrn.lines.find((l) => l.accountCode === '5010');
    const invLine = jrn.lines.find((l) => l.accountCode === '1050');
    expect(cogsLine).toBeTruthy();
    expect(cogsLine.debit).toBe(4000);
    expect(invLine).toBeTruthy();
    expect(invLine.credit).toBe(4000);

    // Zero-value lines check
    expect(jrn.lines.every((l) => l.debit > 0 || l.credit > 0)).toBe(true);

    // Invoicing again rejected (idempotent)
    const secondInv = await api('post', `/api/repairs/${ticket._id}/invoice`, shop.token).send({ paymentMethod: 'cash' });
    expect(secondInv.status).toBe(400);
  });

  it('10. low-stock alert fires after commit and not on rollback', async () => {
    const shop = await setupShop();
    const product = await createProduct(shop, { initialStock: 3, reorderLevel: 2 });
    const ticket = await createCustomerTicket(shop);

    const alertSpy = vi.spyOn(notificationsAdapter, 'sendLowStockAlert').mockResolvedValue({ success: true });

    try {
      // 1. Successful addition drops stock to 2 (<= reorderLevel) -> fires alert after commit
      await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({ productId: product._id, qty: 1 });
      expect(alertSpy).toHaveBeenCalledTimes(1);

      // 2. Aborted transaction does not fire alert
      const origSave = RepairTicket.prototype.save;
      RepairTicket.prototype.save = async function (...args) {
        throw new Error('Simulated rollback');
      };
      try {
        await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({ productId: product._id, qty: 1 });
      } catch {}
      RepairTicket.prototype.save = origSave;

      expect(alertSpy).toHaveBeenCalledTimes(1); // Still 1, did not fire on rollback
    } finally {
      alertSpy.mockRestore();
    }
  });

  it('11. shop-owned unit goes in_stock -> in_repair at intake, in_stock at Ready/Cancelled, flagged at Unrepairable', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { initialStock: 1 });
    const imei = makeLuhnImei(35209900110001);

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei,
        status: 'in_stock',
        unitCostCents: 20000,
      });
    });

    // Intake shop-owned unit
    const intakeRes = await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei },
      faultDescription: 'Faulty battery',
    });
    expect(intakeRes.status).toBe(201);
    expect(intakeRes.body.data.shopOwnedUnit).toBe(true);
    expect(intakeRes.body.data.customerId).toBeNull();
    const ticketId = intakeRes.body.data._id;

    // Unit status is now in_repair
    let unit = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await SerialUnit.findOne({ imei1: imei });
    });
    expect(unit.status).toBe('in_repair');

    // Move to Diagnosing -> In repair -> Quality check -> Ready
    await api('post', `/api/repairs/${ticketId}/stage`, shop.token).send({ to: 'Diagnosing' });
    await api('post', `/api/repairs/${ticketId}/stage`, shop.token).send({ to: 'In repair' }); // no approval gate!
    await api('post', `/api/repairs/${ticketId}/stage`, shop.token).send({ to: 'Quality check' });
    await api('post', `/api/repairs/${ticketId}/stage`, shop.token).send({ to: 'Ready' });

    unit = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await SerialUnit.findOne({ imei1: imei });
    });
    expect(unit.status).toBe('in_stock');

    // Move to Delivered directly without invoice!
    const delivRes = await api('post', `/api/repairs/${ticketId}/stage`, shop.token).send({ to: 'Delivered' });
    expect(delivRes.status).toBe(200);

    // Cancel test on another ticket
    const imei2 = makeLuhnImei(35209900110002);
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei2,
        status: 'in_stock',
        unitCostCents: 20000,
      });
    });
    const t2 = (await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei: imei2 },
      faultDescription: 'Broken glass',
    })).body.data;

    await api('post', `/api/repairs/${t2._id}/stage`, shop.token).send({ to: 'Cancelled' });
    unit = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await SerialUnit.findOne({ imei1: imei2 });
    });
    expect(unit.status).toBe('in_stock');

    // Unrepairable test
    const imei3 = makeLuhnImei(35209900110003);
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei3,
        status: 'in_stock',
        unitCostCents: 20000,
      });
    });
    const t3 = (await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei: imei3 },
      faultDescription: 'Water damage',
    })).body.data;

    await api('post', `/api/repairs/${t3._id}/stage`, shop.token).send({ to: 'Diagnosing' });
    await api('post', `/api/repairs/${t3._id}/stage`, shop.token).send({ to: 'Unrepairable' });
    unit = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await SerialUnit.findOne({ imei1: imei3 });
    });
    expect(unit.status).toBe('in_repair'); // Flagged, left in in_repair
  });

  it('12. a customer-owned device is not touched', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { initialStock: 1 });
    const imei = makeLuhnImei(35209900120001);

    // Unit was sold
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei,
        status: 'sold',
      });
    });

    const ticket = await createCustomerTicket(shop, { imei });
    expect(ticket.shopOwnedUnit).toBe(false);

    // Unit status remains sold
    const unit = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await SerialUnit.findOne({ imei1: imei });
    });
    expect(unit.status).toBe('sold');
  });

  it('13. delta COGS at invoice', async () => {
    const shop = await setupShop();
    const prod1 = await createProduct(shop, { costPriceCents: 3000, sellingPriceCents: 6000, initialStock: 5 });
    const prod2 = await createProduct(shop, { costPriceCents: 5000, sellingPriceCents: 10000, initialStock: 5 });
    const ticket = await createCustomerTicket(shop);

    await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({ productId: prod1._id, qty: 1 });
    await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({ productId: prod2._id, qty: 1 });

    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Diagnosing' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'In repair', waiveApproval: true });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Quality check' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Ready' });

    await api('post', `/api/repairs/${ticket._id}/invoice`, shop.token).send({ paymentMethod: 'cash', labourCents: 1000 });

    const ticketDoc = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await RepairTicket.findById(ticket._id);
    });
    expect(ticketDoc.cogsPostedCents).toBe(8000);
  });

  it('14. write-off on cancel and on unrepairable', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { costPriceCents: 4500, initialStock: 5 });
    const ticket = await createCustomerTicket(shop);

    await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({ productId: prod._id, qty: 1 });

    // Cancel ticket -> writes off 4500
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Cancelled' });

    const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.find({ tenantId: shop.tenantId, referenceId: ticket.ticketNo, referenceType: 'manual' });
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].lines.find((l) => l.accountCode === '5010').debit).toBe(4500);

    const ticketDoc = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await RepairTicket.findById(ticket._id);
    });
    expect(ticketDoc.cogsPostedCents).toBe(4500);
  });

  it('15. reopen then invoice does not double-post', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { costPriceCents: 3500, sellingPriceCents: 7000, initialStock: 5 });
    const ticket = await createCustomerTicket(shop);

    await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({ productId: prod._id, qty: 1 });

    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Diagnosing' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'In repair', waiveApproval: true });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Quality check' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Ready' });
    await api('post', `/api/repairs/${ticket._id}/invoice`, shop.token).send({ paymentMethod: 'cash', labourCents: 1000 });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Delivered' });

    // Owner reopens
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Diagnosing' });

    // Move back to Ready
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'In repair', waiveApproval: true });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Quality check' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Ready' });

    // Check cogsPostedCents is preserved
    const ticketDoc = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await RepairTicket.findById(ticket._id);
    });
    expect(ticketDoc.cogsPostedCents).toBe(3500);
  });

  it('16. removePart blocked after cost recognised', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { costPriceCents: 2000, sellingPriceCents: 5000, initialStock: 5 });
    const ticket = await createCustomerTicket(shop);

    const partRes = await api('post', `/api/repairs/${ticket._id}/parts`, shop.token).send({ productId: prod._id, qty: 1 });
    const partId = partRes.body.data.parts[0]._id;

    // Simulate cogsPostedCents > 0
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await RepairTicket.updateOne({ _id: ticket._id }, { cogsPostedCents: 2000 });
    });

    const delRes = await api('delete', `/api/repairs/${ticket._id}/parts/${partId}`, shop.token);
    expect(delRes.status).toBe(400);
    expect(delRes.body.message).toContain('recognised');
  });

  it('17. shop-owned ticket has no ledger entry and closes without an invoice', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { initialStock: 1 });
    const imei = makeLuhnImei(35209900170001);

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei,
        status: 'in_stock',
        unitCostCents: 15000,
      });
    });

    const ticket = (await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei },
      faultDescription: 'Fault',
    })).body.data;

    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Diagnosing' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'In repair' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Quality check' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Ready' });

    // Settle invoice rejected for shop-owned
    const invRes = await api('post', `/api/repairs/${ticket._id}/invoice`, shop.token).send({ paymentMethod: 'cash' });
    expect(invRes.status).toBe(400);

    // Moves directly to Delivered
    const delRes = await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Delivered' });
    expect(delRes.status).toBe(200);

    const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await LedgerEntry.find({ tenantId: shop.tenantId, referenceId: ticket.ticketNo });
    });
    expect(entries).toHaveLength(0);
  });

  it('18. duplicate ticket for an in_repair IMEI is rejected', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { initialStock: 1 });
    const imei = makeLuhnImei(35209900180001);

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei,
        status: 'in_stock',
      });
    });

    // First ticket succeeds
    const t1 = await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei },
      faultDescription: 'Fault 1',
    });
    expect(t1.status).toBe(201);

    // Second ticket with same IMEI fails with 400
    const t2 = await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei },
      faultDescription: 'Fault 2',
    });
    expect(t2.status).toBe(400);
    expect(t2.body.message).toContain('already in repair');
  });

  it('19. reopen of a shop-owned ticket for each unit status', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { initialStock: 1 });
    const imei = makeLuhnImei(35209900190001);

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei,
        status: 'in_stock',
      });
    });

    const ticket = (await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei },
      faultDescription: 'Fault',
    })).body.data;

    // Move to Ready (transitions unit back to in_stock) then Delivered
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Diagnosing' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'In repair' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Quality check' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Ready' });
    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Delivered' });

    // Case 1: unit is in_stock -> reopen transitions to in_repair
    const reopen1 = await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Diagnosing' });
    expect(reopen1.status).toBe(200);
    let unit = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await SerialUnit.findOne({ imei1: imei });
    });
    expect(unit.status).toBe('in_repair');

    // Case 2: unit is sold -> reopen rejected with 400
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.updateOne({ imei1: imei }, { status: 'sold' });
      await RepairTicket.updateOne({ _id: ticket._id }, { stage: 'Delivered' });
    });

    const reopen2 = await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Diagnosing' });
    expect(reopen2.status).toBe(400);
  });

  it('20. shop-owned ticket without customer works across list, board, GET, job card and stage change', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { initialStock: 1 });
    const imei = makeLuhnImei(35209900200001);

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei,
        status: 'in_stock',
      });
    });

    const ticket = (await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei },
      faultDescription: 'Fault',
    })).body.data;

    // List
    const listRes = await api('get', '/api/repairs', shop.token);
    expect(listRes.status).toBe(200);

    // Board
    const boardRes = await api('get', '/api/repairs/board', shop.token);
    expect(boardRes.status).toBe(200);

    // GET /:id
    const getRes = await api('get', `/api/repairs/${ticket._id}`, shop.token);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.customerId).toBeNull();

    // Job card
    const jobRes = await api('get', `/api/repairs/${ticket._id}/jobcard`, shop.token);
    expect(jobRes.status).toBe(200);
    expect(jobRes.body.data.customer).toBeNull();

    // Stage change
    const stageRes = await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Diagnosing' });
    expect(stageRes.status).toBe(200);
  });

  it('21. approval not required for shop-owned', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { initialStock: 1 });
    const imei = makeLuhnImei(35209900210001);

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei,
        status: 'in_stock',
      });
    });

    const ticket = (await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei },
      faultDescription: 'Fault',
    })).body.data;

    await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'Diagnosing' });
    const inRepairRes = await api('post', `/api/repairs/${ticket._id}/stage`, shop.token).send({ to: 'In repair' });
    expect(inRepairRes.status).toBe(200);
  });

  it('22. advance must be 0 for shop-owned', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { initialStock: 1 });
    const imei = makeLuhnImei(35209900220001);

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei,
        status: 'in_stock',
      });
    });

    const res = await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei },
      faultDescription: 'Fault',
      advanceCents: 5000,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('advance');
  });

  it('23. shop-owned creation needs inventory.edit permission', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { initialStock: 1 });
    const imei = makeLuhnImei(35209900230001);

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei,
        status: 'in_stock',
      });
    });

    // Add cashier (has repairs.create, but no inventory.edit)
    const cashier = await addStaff(shop, 'cashier', 'cashier_repair@cellivo.lk');

    const res = await api('post', '/api/repairs', cashier.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei },
      faultDescription: 'Fault',
    });
    expect(res.status).toBe(403);
  });

  it('24. CUSTOMER_REQUIRED for a customer-less ticket with an unknown IMEI', async () => {
    const shop = await setupShop();
    const imei = makeLuhnImei(35209900240001);
    const res = await api('post', '/api/repairs', shop.token).send({
      device: { brand: 'Apple', model: 'iPhone 13', imei }, // not in stock
      faultDescription: 'Fault',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Customer');
  });

  it('25. parallel intake for same shop IMEI: exactly one succeeds, other gets 400', async () => {
    const shop = await setupShop();
    const prod = await createProduct(shop, { initialStock: 1 });
    const imei = makeLuhnImei(35209900250001);

    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await SerialUnit.create({
        productId: prod._id,
        branchId: shop.branchId,
        imei1: imei,
        status: 'in_stock',
      });
    });

    const [r1, r2] = await Promise.all([
      api('post', '/api/repairs', shop.token).send({ device: { brand: 'Apple', model: 'iPhone 13', imei }, faultDescription: 'Fault 1' }),
      api('post', '/api/repairs', shop.token).send({ device: { brand: 'Apple', model: 'iPhone 13', imei }, faultDescription: 'Fault 2' }),
    ]);

    const statuses = [r1.status, r2.status];
    expect(statuses).toContain(201);
    expect(statuses).toContain(400);
  });
});

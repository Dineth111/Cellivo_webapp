import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import StockLevel from '../src/modules/inventory/models/StockLevel.model.js';
import WooSyncQueue from '../src/modules/inventory/models/WooSyncQueue.model.js';
import WooSettings from '../src/modules/inventory/models/WooSettings.model.js';
import AuditLog from '../src/modules/audit/AuditLog.model.js';
import { runAsPlatform, runWithContext } from '../src/core/tenantContext.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function setupShop(plan = 'growth', email = 'owner@cellivo.lk') {
  const s = await signup(email, 'Cellivo Online');
  const meRes = await api('get', '/api/auth/me', s.token);
  const tenantId = meRes.body.data.tenant._id;
  const branchRes = await api('get', '/api/branches', s.token);
  const branchId = branchRes.body.data[0]._id;

  if (plan !== 'lite') {
    await runAsPlatform(async () => {
      await Tenant.findByIdAndUpdate(tenantId, { planCode: plan, subscriptionStatus: 'active' });
    });
  }

  return { ...s, tenantId, branchId };
}

describe('INT-01 WooCommerce Sync & Queue', () => {
  it('1. Plan gating: rejects access on starter plan without woocommerce feature (403 FEATURE_NOT_IN_PLAN)', async () => {
    // Signup defaults to trial/starter without woocommerce
    const shop = await setupShop('starter', 'starter-shop@cellivo.lk');

    const res = await api('get', '/api/inventory/woocommerce/settings', shop.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_NOT_IN_PLAN');
  });

  it('2. Settings management on growth plan with woocommerce feature', async () => {
    const shop = await setupShop('growth', 'growth-shop@cellivo.lk');

    // Get default settings
    const getRes = await api('get', '/api/inventory/woocommerce/settings', shop.token);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.isActive).toBe(false);

    // Update settings
    const upRes = await api('post', '/api/inventory/woocommerce/settings', shop.token).send({
      storeUrl: 'https://myshop.lk',
      consumerKey: 'ck_test1234567890',
      consumerSecret: 'cs_test1234567890',
      isActive: true,
      autoSyncStock: true,
    });
    expect(upRes.status).toBe(200);
    expect(upRes.body.data.storeUrl).toBe('https://myshop.lk');
    expect(upRes.body.data.isActive).toBe(true);
  });

  it('3. Product push, stock push, and retry queue processing', async () => {
    const shop = await setupShop('growth', 'sync-shop@cellivo.lk');

    // Create a product
    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Anker Soundcore 2 Bluetooth Speaker',
      barcode: 'ANK-SC-02',
      costPriceCents: 850000,
      sellingPriceCents: 1250000,
      isSerialised: false,
    });
    const productId = prodRes.body.data._id;

    // Enqueue product push
    const pushProdRes = await api('post', '/api/inventory/woocommerce/sync-products', shop.token).send({
      productId,
    });
    expect(pushProdRes.status).toBe(200);
    expect(pushProdRes.body.data.queued).toBe(true);

    // Enqueue stock push
    const pushStockRes = await api('post', '/api/inventory/woocommerce/sync-stock', shop.token).send({
      productId,
      branchId: shop.branchId,
    });
    expect(pushStockRes.status).toBe(200);
    expect(pushStockRes.body.data.queued).toBe(true);

    // Verify tasks exist in queue
    const queueRes = await api('get', '/api/inventory/woocommerce/queue', shop.token);
    expect(queueRes.status).toBe(200);
    expect(queueRes.body.data).toHaveLength(2);
    expect(queueRes.body.data.some((t) => t.action === 'push_product')).toBe(true);
    expect(queueRes.body.data.some((t) => t.action === 'push_stock')).toBe(true);

    // Trigger queue processing worker
    const processRes = await api('post', '/api/inventory/woocommerce/queue/process', shop.token);
    expect(processRes.status).toBe(200);
    expect(processRes.body.data.processed).toBe(2);

    // Verify tasks are completed
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const completed = await WooSyncQueue.find({ status: 'completed' });
      expect(completed).toHaveLength(2);
    });
  });

  it('4. Pull orders from WooCommerce', async () => {
    const shop = await setupShop('growth', 'orders-shop@cellivo.lk');

    // Activate WooCommerce settings
    await api('post', '/api/inventory/woocommerce/settings', shop.token).send({
      storeUrl: 'https://cellivo-demo.lk',
      isActive: true,
    });

    const ordersRes = await api('post', '/api/inventory/woocommerce/pull-orders', shop.token);
    expect(ordersRes.status).toBe(200);
    expect(ordersRes.body.data.success).toBe(true);
    expect(ordersRes.body.data.ordersCount).toBeGreaterThan(0);
  });
});

describe('Dev 4 review: 9. WooCommerce secret & permissions', () => {
  it('masks credentials for cashier and owner, requires settings.edit for update, and audits without secret', async () => {
    const shop = await setupShop('growth', 'woo-secret-shop@cellivo.lk');

    // 1. Owner updates WooCommerce settings with secrets
    const upRes = await api('post', '/api/inventory/woocommerce/settings', shop.token).send({
      storeUrl: 'https://secretshop.lk',
      consumerKey: 'ck_secret_key_123',
      consumerSecret: 'cs_super_secret_456',
      isActive: true,
    });
    expect(upRes.status).toBe(200);
    // Response should NOT contain secrets
    expect(upRes.body.data.consumerKey).toBeUndefined();
    expect(upRes.body.data.consumerSecret).toBeUndefined();
    expect(upRes.body.data.hasCredentials).toBe(true);

    // 2. Owner fetches settings -> no secrets returned
    const ownerGetRes = await api('get', '/api/inventory/woocommerce/settings', shop.token);
    expect(ownerGetRes.status).toBe(200);
    expect(ownerGetRes.body.data.consumerKey).toBeUndefined();
    expect(ownerGetRes.body.data.consumerSecret).toBeUndefined();
    expect(ownerGetRes.body.data.hasCredentials).toBe(true);

    // 3. Create a Cashier staff member
    const cashier = await addStaff(shop, 'cashier', 'cashier-woo@cellivo.lk');

    // Cashier fetches settings -> no secrets returned
    const cashierGetRes = await api('get', '/api/inventory/woocommerce/settings', cashier.token);
    expect(cashierGetRes.status).toBe(200);
    expect(cashierGetRes.body.data.consumerKey).toBeUndefined();
    expect(cashierGetRes.body.data.consumerSecret).toBeUndefined();
    expect(cashierGetRes.body.data.hasCredentials).toBe(true);

    // 4. Cashier attempts to update settings -> 403 Forbidden (lacks settings.edit)
    const cashierUpdateRes = await api('post', '/api/inventory/woocommerce/settings', cashier.token).send({
      storeUrl: 'https://hackedshop.lk',
    });
    expect(cashierUpdateRes.status).toBe(403);

    // 5. Verify audit log entry exists and does NOT contain secrets
    const auditLogs = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await AuditLog.find({ action: 'settings.woocommerce_updated' });
    });
    expect(auditLogs.length).toBeGreaterThan(0);
    const lastAudit = auditLogs[auditLogs.length - 1];
    expect(lastAudit.after?.consumerKey).toBeUndefined();
    expect(lastAudit.after?.consumerSecret).toBeUndefined();
    expect(lastAudit.after?.storeUrl).toBe('https://secretshop.lk');
  });
});


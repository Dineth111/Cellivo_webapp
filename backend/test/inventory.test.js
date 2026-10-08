import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addBranch, addStaff } from './api.js';
import * as stockService from '../src/modules/inventory/services/stock.service.js';
import Category from '../src/modules/inventory/models/Category.model.js';
import Brand from '../src/modules/inventory/models/Brand.model.js';
import ProductModel from '../src/modules/inventory/models/ProductModel.model.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import StockLevel from '../src/modules/inventory/models/StockLevel.model.js';
import StockMovement from '../src/modules/inventory/models/StockMovement.model.js';
import { runWithContext } from '../src/core/tenantContext.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function setupShop(email = 'owner@cellivo.lk', shopName = 'Cellivo Main') {
  const s = await signup(email, shopName);
  const meRes = await api('get', '/api/auth/me', s.token);
  const tenantId = meRes.body.data.tenant._id;
  const branchRes = await api('get', '/api/branches', s.token);
  const branchId = branchRes.body.data[0]._id;
  return { ...s, tenantId, branchId };
}

describe('F-06 Catalogue Core: Categories, Brands, Models & Products', () => {
  it('handles category CRUD, unique name per tenant', async () => {
    const shop = await setupShop();

    // Create
    const res = await api('post', '/api/inventory/categories', shop.token).send({
      name: 'Smartphones',
      description: 'Mobile phones and devices',
    });
    expect(res.status).toBe(201);
    const catId = res.body.data._id;
    expect(res.body.data.name).toBe('Smartphones');

    // Duplicate in same tenant rejected
    const dupRes = await api('post', '/api/inventory/categories', shop.token).send({ name: 'Smartphones' });
    expect(dupRes.status).toBe(400);

    // List
    const listRes = await api('get', '/api/inventory/categories', shop.token);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);

    // Update
    const upRes = await api('put', `/api/inventory/categories/${catId}`, shop.token).send({
      name: 'Mobile Phones',
    });
    expect(upRes.status).toBe(200);
    expect(upRes.body.data.name).toBe('Mobile Phones');

    // Archive
    const delRes = await api('delete', `/api/inventory/categories/${catId}`, shop.token);
    expect(delRes.status).toBe(200);

    const afterList = await api('get', '/api/inventory/categories', shop.token);
    expect(afterList.body.data).toHaveLength(0);
  });

  it('handles brands and product models', async () => {
    const shop = await setupShop();

    // Create Brand
    const brandRes = await api('post', '/api/inventory/brands', shop.token).send({
      name: 'Samsung',
      description: 'Samsung Electronics',
    });
    expect(brandRes.status).toBe(201);
    const brandId = brandRes.body.data._id;

    // Create Model under Brand
    const modelRes = await api('post', '/api/inventory/models', shop.token).send({
      brandId,
      name: 'Galaxy S24',
    });
    expect(modelRes.status).toBe(201);
    const modelId = modelRes.body.data._id;

    // List Models
    const listRes = await api('get', `/api/inventory/models?brandId=${brandId}`, shop.token);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data[0].name).toBe('Galaxy S24');
  });

  it('creates and manages products with variants and barcode uniqueness', async () => {
    const shop = await setupShop();

    const brandRes = await api('post', '/api/inventory/brands', shop.token).send({ name: 'Apple' });
    const brandId = brandRes.body.data._id;

    const catRes = await api('post', '/api/inventory/categories', shop.token).send({ name: 'iPhones' });
    const categoryId = catRes.body.data._id;

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'iPhone 15 Pro 256GB Natural Titanium',
      barcode: '194253782910',
      sku: 'IPH15P-256-NAT',
      categoryId,
      brandId,
      isSerialised: true,
      variantAttributes: { color: 'Natural Titanium', storage: '256GB', ram: '8GB' },
      sellingPriceCents: 35000000, // Rs 350,000
      wholesalePriceCents: 33000000,
      costPriceCents: 30000000,
      reorderLevel: 5,
    });
    expect(prodRes.status).toBe(201);
    expect(prodRes.body.data.name).toContain('iPhone 15 Pro');
    expect(prodRes.body.data.sellingPriceCents).toBe(35000000);

    // Duplicate barcode fails
    const dupRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Another iPhone',
      barcode: '194253782910',
      sellingPriceCents: 30000000,
    });
    expect(dupRes.status).toBe(400);

    // Duplicate SKU fails
    const dupSkuRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Another iPhone with same SKU',
      barcode: '999999999999',
      sku: 'IPH15P-256-NAT',
      sellingPriceCents: 30000000,
    });
    expect(dupSkuRes.status).toBe(400);
  });
});

describe('F-06 Stock Service: Atomic Updates, WAC & Concurrent Safety', () => {
  it('correctly calculates weighted average cost on multiple stock additions', async () => {
    const shop = await setupShop();

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'USB-C Cable 1m',
      barcode: '890123456789',
      sellingPriceCents: 250000,
      costPriceCents: 100000,
    });
    const productId = prodRes.body.data._id;

    // 1st lot: 10 units @ Rs 1,000 (100,000 cents)
    const lot1 = await stockService.adjustStockLevel({
      tenantId: shop.tenantId,
      productId,
      branchId: shop.branchId,
      type: 'purchase_grn',
      qtyChange: 10,
      unitCostCents: 100000,
      referenceType: 'grn',
      referenceId: 'GRN-001',
    });
    expect(lot1.stockLevel.qty).toBe(10);
    expect(lot1.stockLevel.averageCostCents).toBe(100000);

    // 2nd lot: 10 units @ Rs 2,000 (200,000 cents)
    // Weighted avg: (10*100000 + 10*200000) / 20 = 150000 cents (Rs 1,500)
    const lot2 = await stockService.adjustStockLevel({
      tenantId: shop.tenantId,
      productId,
      branchId: shop.branchId,
      type: 'purchase_grn',
      qtyChange: 10,
      unitCostCents: 200000,
      referenceType: 'grn',
      referenceId: 'GRN-002',
    });
    expect(lot2.stockLevel.qty).toBe(20);
    expect(lot2.stockLevel.averageCostCents).toBe(150000);

    // 3rd lot: 5 units @ Rs 2,500 (250,000 cents)
    // Weighted avg: (20*150000 + 5*250000) / 25 = (3000000 + 1250000) / 25 = 170000 cents (Rs 1,700)
    const lot3 = await stockService.adjustStockLevel({
      tenantId: shop.tenantId,
      productId,
      branchId: shop.branchId,
      type: 'purchase_grn',
      qtyChange: 5,
      unitCostCents: 250000,
      referenceType: 'grn',
      referenceId: 'GRN-003',
    });
    expect(lot3.stockLevel.qty).toBe(25);
    expect(lot3.stockLevel.averageCostCents).toBe(170000);

    // Verify movements recorded
    const movements = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await StockMovement.find({ productId }).sort({ createdAt: 1 });
    });
    expect(movements).toHaveLength(3);
    expect(movements[0].balanceAfter).toBe(10);
    expect(movements[1].balanceAfter).toBe(20);
    expect(movements[2].balanceAfter).toBe(25);
  });

  it('atomically prevents deducting more stock than available', async () => {
    const shop = await setupShop();

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Tempered Glass',
      barcode: '555111222333',
      sellingPriceCents: 50000,
    });
    const productId = prodRes.body.data._id;

    // Add 3 units
    await stockService.adjustStockLevel({
      tenantId: shop.tenantId,
      productId,
      branchId: shop.branchId,
      type: 'initial',
      qtyChange: 3,
      unitCostCents: 20000,
    });

    // Deduct 2 units -> OK
    const ded1 = await stockService.adjustStockLevel({
      tenantId: shop.tenantId,
      productId,
      branchId: shop.branchId,
      type: 'sale',
      qtyChange: -2,
    });
    expect(ded1.stockLevel.qty).toBe(1);

    // Deduct 2 more units -> Fails with V-05 error
    await expect(
      stockService.adjustStockLevel({
        tenantId: shop.tenantId,
        productId,
        branchId: shop.branchId,
        type: 'sale',
        qtyChange: -2,
      })
    ).rejects.toThrow(/Only 1 left at this branch/);

    // Balance remains 1
    const sl = await stockService.getStockLevel(shop.tenantId, shop.branchId, productId);
    expect(sl.qty).toBe(1);
  });

  it('concurrent deductions never make stock balance negative', async () => {
    const shop = await setupShop();

    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Fast Charger 65W',
      barcode: '777888999111',
      sellingPriceCents: 850000,
    });
    const productId = prodRes.body.data._id;

    // Add 5 units
    await stockService.adjustStockLevel({
      tenantId: shop.tenantId,
      productId,
      branchId: shop.branchId,
      type: 'initial',
      qtyChange: 5,
      unitCostCents: 400000,
    });

    // Run 2 parallel requests trying to deduct 4 units each (total 8 > 5)
    const results = await Promise.allSettled([
      stockService.adjustStockLevel({
        tenantId: shop.tenantId,
        productId,
        branchId: shop.branchId,
        type: 'sale',
        qtyChange: -4,
      }),
      stockService.adjustStockLevel({
        tenantId: shop.tenantId,
        productId,
        branchId: shop.branchId,
        type: 'sale',
        qtyChange: -4,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toContain('Only 1 left at this branch');

    const sl = await stockService.getStockLevel(shop.tenantId, shop.branchId, productId);
    expect(sl.qty).toBe(1);
  });
});

describe('F-06 Tenant Isolation & Cost Masking', () => {
  it('tenant B cannot see or modify tenant A products', async () => {
    const shopA = await setupShop('shopA@cellivo.lk', 'Shop A');
    const shopB = await setupShop('shopB@cellivo.lk', 'Shop B');

    // Create product in Shop A
    const resA = await api('post', '/api/inventory/products', shopA.token).send({
      name: 'Exclusive Phone A',
      barcode: 'BARCODE-A-001',
      sellingPriceCents: 10000000,
    });
    const prodAId = resA.body.data._id;

    // Shop B lists products -> 0 items
    const listB = await api('get', '/api/inventory/products', shopB.token);
    expect(listB.body.total).toBe(0);

    // Shop B tries to read/update/delete product A -> 404
    expect((await api('get', `/api/inventory/products/${prodAId}`, shopB.token)).status).toBe(404);
    expect((await api('put', `/api/inventory/products/${prodAId}`, shopB.token).send({ name: 'Hacked' })).status).toBe(404);
    expect((await api('delete', `/api/inventory/products/${prodAId}`, shopB.token)).status).toBe(404);

    // Shop B creating a product with the same barcode -> Success (unique per tenant)
    const resB = await api('post', '/api/inventory/products', shopB.token).send({
      name: 'Same Barcode Phone B',
      barcode: 'BARCODE-A-001',
      sellingPriceCents: 12000000,
    });
    expect(resB.status).toBe(201);
  });

  it('masks cost and margin fields for users without view_cost_margin', async () => {
    const shop = await setupShop();

    // Create a product with cost price
    const prodRes = await api('post', '/api/inventory/products', shop.token).send({
      name: 'Wireless Earbuds',
      barcode: 'EARBUD-001',
      sellingPriceCents: 1500000,
      costPriceCents: 800000,
    });
    const prodId = prodRes.body.data._id;

    // Owner has view_cost_margin -> sees costPriceCents
    const ownerGet = await api('get', `/api/inventory/products/${prodId}`, shop.token);
    expect(ownerGet.body.data.costPriceCents).toBe(800000);

    // Create Cashier user (cashier does not have view_cost_margin)
    const cashier = await addStaff(shop, 'cashier', 'bob@cellivo.lk');

    // Cashier reads product -> costPriceCents is masked/undefined
    const cashierGet = await api('get', `/api/inventory/products/${prodId}`, cashier.token);
    expect(cashierGet.body.data.costPriceCents).toBeUndefined();
    expect(cashierGet.body.data.sellingPriceCents).toBe(1500000);
  });
});

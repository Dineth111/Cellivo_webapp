import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import * as barcodeService from '../src/modules/inventory/services/barcode.service.js';
import Product from '../src/modules/inventory/models/Product.model.js';
import { runWithContext } from '../src/core/tenantContext.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function setupShop(email = 'barcodes@shop.lk', name = 'Barcode Shop') {
  const s = await signup(email, name);
  const meRes = await api('get', '/api/auth/me', s.token);
  const tenantId = meRes.body.data.tenant._id;
  const branchRes = await api('get', '/api/branches', s.token);
  const branchId = branchRes.body.data[0]._id;
  return { ...s, tenantId, branchId };
}

describe('INV-06 Barcode Generation & Label Sheet Preview', () => {
  it('generates unique valid barcodes with checksum', async () => {
    const shop = await setupShop();

    const barcode1 = await barcodeService.generateUniqueBarcode(shop.tenantId);
    const barcode2 = await barcodeService.generateUniqueBarcode(shop.tenantId);

    expect(barcode1).toMatch(/^20\d{10}$/);
    expect(barcode2).toMatch(/^20\d{10}$/);
    expect(barcode1).not.toBe(barcode2);

    const res = await api('post', '/api/inventory/products/generate-barcode', shop.token);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.barcode).toMatch(/^20\d{10}$/);
  });

  it('assigns generated barcode to an existing product without barcode', async () => {
    const shop = await setupShop('assign-bc@shop.lk', 'Assign BC Shop');

    const createdProd = (await api('post', '/api/inventory/products', shop.token).send({
      name: 'Unlabeled Battery',
      barcode: 'TEMP-WILL-REPLACE',
      sellingPriceCents: 450000,
    })).body.data;

    // Remove barcode in DB
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await Product.updateOne({ _id: createdProd._id }, { $set: { barcode: '' } });
    });

    const assignRes = await api('post', `/api/inventory/products/${createdProd._id}/assign-barcode`, shop.token);
    expect(assignRes.status).toBe(200);
    expect(assignRes.body.success).toBe(true);
    expect(assignRes.body.barcode).toMatch(/^20\d{10}$/);

    const check = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Product.findById(createdProd._id);
    });
    expect(check.barcode).toBe(assignRes.body.barcode);
  });

  it('provides label presets and formats label sheet with repeated items for printing', async () => {
    const shop = await setupShop('labels@shop.lk', 'Label Shop');

    // Check presets
    const presetsRes = await api('get', '/api/inventory/labels/presets', shop.token);
    expect(presetsRes.status).toBe(200);
    expect(presetsRes.body.presets['50x25']).toBeDefined();
    expect(presetsRes.body.presets['a4_24']).toBeDefined();

    // Format labels
    const previewRes = await api('post', '/api/inventory/labels/preview', shop.token).send({
      labelSize: '50x25',
      items: [
        {
          name: 'Fast Charger 20W',
          barcode: '201234567890',
          sellingPriceCents: 250000, // Rs. 2,500.00
          qty: 3,
        },
        {
          name: 'Type-C Braided Cable',
          barcode: '209876543210',
          sellingPriceCents: 85000, // Rs. 850.00
          qty: 2,
        },
      ],
      showPrice: true,
      showName: true,
    });

    expect(previewRes.status).toBe(200);
    expect(previewRes.body.data.totalLabels).toBe(5); // 3 + 2
    expect(previewRes.body.data.labels[0].name).toBe('Fast Charger 20W');
    expect(previewRes.body.data.labels[0].price).toContain('2,500.00');
    expect(previewRes.body.data.labels[3].name).toBe('Type-C Braided Cable');
    expect(previewRes.body.data.labels[3].price).toContain('850.00');
  });
});

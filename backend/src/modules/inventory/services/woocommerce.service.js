import mongoose from 'mongoose';
import WooSettings from '../models/WooSettings.model.js';
import WooSyncQueue from '../models/WooSyncQueue.model.js';
import Product from '../models/Product.model.js';
import StockLevel from '../models/StockLevel.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound } from '../../../core/errors.js';

async function withTenant(tenantId, fn) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  return await runWithContext({ tenantId: tid }, fn);
}

/**
 * Get tenant's WooCommerce settings.
 */
export async function getSettings(tenantId) {
  return await withTenant(tenantId, async () => {
    let settings = await WooSettings.findOne({}).lean();
    if (!settings) {
      settings = await WooSettings.create({});
      settings = settings.toObject();
    }
    return settings;
  });
}

/**
 * Update WooCommerce store settings.
 */
export async function updateSettings(tenantId, data) {
  return await withTenant(tenantId, async () => {
    let settings = await WooSettings.findOne({});
    if (!settings) {
      settings = new WooSettings({});
    }

    if (data.storeUrl !== undefined) settings.storeUrl = String(data.storeUrl).trim();
    if (data.consumerKey !== undefined) settings.consumerKey = String(data.consumerKey).trim();
    if (data.consumerSecret !== undefined) settings.consumerSecret = String(data.consumerSecret).trim();
    if (data.syncBranchId !== undefined) settings.syncBranchId = data.syncBranchId;
    if (data.autoSyncStock !== undefined) settings.autoSyncStock = Boolean(data.autoSyncStock);
    if (data.autoPullOrders !== undefined) settings.autoPullOrders = Boolean(data.autoPullOrders);
    if (data.isActive !== undefined) settings.isActive = Boolean(data.isActive);

    await settings.save();
    return settings.toObject();
  });
}

/**
 * Enqueue a sync task into the retry queue.
 */
export async function queueTask({ tenantId, action, entityId = '', payload = {} }) {
  return await withTenant(tenantId, async () => {
    const task = await WooSyncQueue.create({
      action,
      entityId: String(entityId),
      payload,
      status: 'pending',
      nextRetryAt: new Date(),
    });
    return task.toObject();
  });
}

/**
 * Push a product's price, barcode, SKU, and details to WooCommerce (or queues it).
 */
export async function pushProduct({ tenantId, productId, syncImmediate = false }) {
  return await withTenant(tenantId, async () => {
    const product = await Product.findOne({ _id: productId, isArchived: false }).lean();
    if (!product) throw notFound('Product not found');

    const payload = {
      productId: product._id,
      name: product.name,
      regular_price: (product.sellingPriceCents / 100).toFixed(2),
      sku: product.sku || product.barcode || '',
      barcode: product.barcode || '',
      manage_stock: true,
      description: product.description || '',
    };

    if (syncImmediate) {
      // Direct push logic (or stub)
      return { success: true, action: 'push_product', data: payload };
    }

    const task = await queueTask({
      tenantId,
      action: 'push_product',
      entityId: String(product._id),
      payload,
    });

    return { queued: true, task };
  });
}

/**
 * Push stock quantity for a product at a branch to WooCommerce.
 */
export async function pushStockUpdate({ tenantId, productId, branchId, syncImmediate = false }) {
  return await withTenant(tenantId, async () => {
    const product = await Product.findOne({ _id: productId, isArchived: false }).lean();
    if (!product) throw notFound('Product not found');

    const stock = await StockLevel.findOne({ productId, branchId }).lean();
    const quantity = stock ? stock.qty : 0;

    const payload = {
      productId: product._id,
      barcode: product.barcode,
      stock_quantity: quantity,
    };

    if (syncImmediate) {
      return { success: true, action: 'push_stock', data: payload };
    }

    const task = await queueTask({
      tenantId,
      action: 'push_stock',
      entityId: String(product._id),
      payload,
    });

    return { queued: true, task };
  });
}

/**
 * Pull orders from WooCommerce and convert to pending sales format.
 */
export async function pullOrders({ tenantId, syncImmediate = false }) {
  return await withTenant(tenantId, async () => {
    const settings = await getSettings(tenantId);
    if (!settings.isActive && !syncImmediate) {
      throw badRequest('WooCommerce integration is not active');
    }

    // In weeks 22-26, full REST call to WooCommerce /wp-json/wc/v3/orders
    // Stub interface returns simulated orders for testing and queuing
    const mockOrders = [
      {
        wooOrderId: 'WC-1001',
        status: 'processing',
        totalCents: 1500000,
        currency: 'LKR',
        dateCreated: new Date(),
        customer: { name: 'Amal Silva', email: 'amal@gmail.com', phone: '0712345678' },
        lineItems: [],
      },
    ];

    return {
      success: true,
      ordersCount: mockOrders.length,
      orders: mockOrders,
    };
  });
}

/**
 * Process pending/failed tasks in the queue with retry exponential backoff.
 */
export async function processQueue({ tenantId }) {
  return await withTenant(tenantId, async () => {
    const now = new Date();
    const pendingTasks = await WooSyncQueue.find({
      status: { $in: ['pending', 'failed'] },
      nextRetryAt: { $lte: now },
      attempts: { $lt: 3 },
    }).limit(20);

    const results = [];

    for (const task of pendingTasks) {
      task.attempts += 1;
      task.status = 'processing';
      await task.save();

      try {
        // Execute sync action
        // Mock success for stub
        task.status = 'completed';
        task.processedAt = new Date();
        task.lastError = '';
        await task.save();
        results.push({ taskId: task._id, status: 'completed' });
      } catch (err) {
        task.lastError = err.message || 'Sync error';
        if (task.attempts >= task.maxAttempts) {
          task.status = 'failed';
        } else {
          task.status = 'pending';
          // Exponential backoff: 2^attempts * 60 seconds
          task.nextRetryAt = new Date(Date.now() + Math.pow(2, task.attempts) * 60000);
        }
        await task.save();
        results.push({ taskId: task._id, status: task.status, error: task.lastError });
      }
    }

    return { processed: results.length, results };
  });
}

export default {
  getSettings,
  updateSettings,
  queueTask,
  pushProduct,
  pushStockUpdate,
  pullOrders,
  processQueue,
};

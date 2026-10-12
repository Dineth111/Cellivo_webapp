import * as wooService from '../services/woocommerce.service.js';
import WooSyncQueue from '../models/WooSyncQueue.model.js';
import { requireId, pageParams } from '../../../core/validate.js';
import { resolveBranch } from '../../pos/utils/branch.js';
import { record as recordAudit } from '../../../core/audit.js';

export async function getSettings(req, res) {
  const settings = await wooService.getSettings(req.auth.tenantId);
  const { consumerKey, consumerSecret, ...safeSettings } = settings;
  res.json({
    data: {
      ...safeSettings,
      hasCredentials: Boolean(settings.hasCredentials || (consumerKey && consumerSecret)),
    },
  });
}

export async function updateSettings(req, res) {
  const settings = await wooService.updateSettings(req.auth.tenantId, req.body);
  const { consumerKey, consumerSecret, ...safeBody } = req.body;

  await recordAudit({
    action: 'settings.woocommerce_updated',
    entity: 'WooSettings',
    entityId: settings._id,
    after: safeBody,
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  const { consumerKey: ck, consumerSecret: cs, ...safeSettings } = settings;
  res.json({
    data: {
      ...safeSettings,
      hasCredentials: Boolean(settings.hasCredentials || (settings.consumerKey && settings.consumerSecret)),
    },
  });
}

export async function syncProduct(req, res) {
  const productId = requireId(req.body.productId, 'productId');
  const syncImmediate = req.body.immediate === true;
  const result = await wooService.pushProduct({
    tenantId: req.auth.tenantId,
    productId,
    syncImmediate,
  });
  res.json({ data: result });
}

export async function syncStock(req, res) {
  const productId = requireId(req.body.productId, 'productId');
  const branch = await resolveBranch(req);
  const syncImmediate = req.body.immediate === true;
  const result = await wooService.pushStockUpdate({
    tenantId: req.auth.tenantId,
    productId,
    branchId: branch._id,
    syncImmediate,
  });
  res.json({ data: result });
}

export async function pullOrders(req, res) {
  const syncImmediate = req.body.immediate === true;
  const result = await wooService.pullOrders({
    tenantId: req.auth.tenantId,
    syncImmediate,
  });
  res.json({ data: result });
}

export async function listQueue(req, res) {
  const { skip, limit } = pageParams(req);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const [items, total] = await Promise.all([
    WooSyncQueue.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    WooSyncQueue.countDocuments(filter),
  ]);

  res.json({
    data: items,
    pagination: { total, skip, limit },
  });
}

export async function processQueue(req, res) {
  const result = await wooService.processQueue({ tenantId: req.auth.tenantId });
  res.json({ data: result });
}

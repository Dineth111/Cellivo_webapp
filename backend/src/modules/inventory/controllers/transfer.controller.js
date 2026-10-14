import StockTransfer from '../models/StockTransfer.model.js';
import * as transferService from '../services/transfer.service.js';
import { str, requireId, pageParams } from '../../../core/validate.js';
import { badRequest, notFound } from '../../../core/errors.js';
import { record as recordAudit } from '../../../core/audit.js';
import { maskCost } from '../utils/maskCost.js';
import { resolveBranch } from '../../pos/utils/branch.js';

export async function listTransfers(req, res) {
  const { skip, limit } = pageParams(req);
  const filter = {};

  if (req.query.fromBranchId) {
    filter.fromBranchId = requireId(req.query.fromBranchId, 'fromBranchId');
  }
  if (req.query.toBranchId) {
    filter.toBranchId = requireId(req.query.toBranchId, 'toBranchId');
  }
  if (req.query.status) {
    filter.status = str(req.query.status);
  }

  const [items, total] = await Promise.all([
    StockTransfer.find(filter)
      .populate('fromBranchId', 'name')
      .populate('toBranchId', 'name')
      .populate('items.productId', 'name barcode isSerialised')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    StockTransfer.countDocuments(filter),
  ]);

  res.json({
    data: maskCost(items, req.auth.role),
    pagination: { total, skip, limit },
  });
}

export async function getTransfer(req, res) {
  const id = requireId(req.params.id, 'Transfer ID');
  const transfer = await StockTransfer.findById(id)
    .populate('fromBranchId', 'name')
    .populate('toBranchId', 'name')
    .populate('items.productId', 'name barcode isSerialised')
    .lean();

  if (!transfer) throw notFound('Transfer not found');

  res.json({ data: maskCost(transfer, req.auth.role) });
}

export async function requestTransfer(req, res) {
  const fromBranchId = requireId(req.body.fromBranchId, 'fromBranchId');
  const toBranchId = requireId(req.body.toBranchId, 'toBranchId');
  const items = req.body.items;
  const notes = str(req.body.notes) || '';

  // Validate requester has branch access to fromBranch (or toBranch)
  await resolveBranch(req, { branchId: fromBranchId });

  const transfer = await transferService.requestTransfer({
    tenantId: req.auth.tenantId,
    fromBranchId,
    toBranchId,
    items,
    notes,
    userId: req.auth.userId,
  });

  await recordAudit({
    action: 'inventory.transfer_requested',
    entity: 'StockTransfer',
    entityId: transfer._id,
    after: transfer.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    branchId: fromBranchId,
  });

  res.status(201).json({ data: maskCost(transfer.toObject(), req.auth.role) });
}

export async function approveTransfer(req, res) {
  const id = requireId(req.params.id, 'Transfer ID');
  const existing = await StockTransfer.findById(id);
  if (!existing) throw notFound('Transfer not found');

  // Validate user branch access
  await resolveBranch(req, { branchId: existing.fromBranchId });

  const transfer = await transferService.approveTransfer({
    tenantId: req.auth.tenantId,
    transferId: id,
    userId: req.auth.userId,
  });

  await recordAudit({
    action: 'inventory.transfer_approved',
    entity: 'StockTransfer',
    entityId: transfer._id,
    after: transfer.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    branchId: transfer.fromBranchId,
  });

  res.json({ data: maskCost(transfer.toObject(), req.auth.role) });
}

export async function dispatchTransfer(req, res) {
  const id = requireId(req.params.id, 'Transfer ID');
  const existing = await StockTransfer.findById(id);
  if (!existing) throw notFound('Transfer not found');

  // Sending branch check
  await resolveBranch(req, { branchId: existing.fromBranchId });

  const dispatchItems = req.body.items || null;

  const transfer = await transferService.dispatchTransfer({
    tenantId: req.auth.tenantId,
    transferId: id,
    dispatchItems,
    userId: req.auth.userId,
  });

  await recordAudit({
    action: 'inventory.transfer_dispatched',
    entity: 'StockTransfer',
    entityId: transfer._id,
    after: transfer.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    branchId: transfer.fromBranchId,
  });

  res.json({ data: maskCost(transfer.toObject(), req.auth.role) });
}

export async function receiveTransfer(req, res) {
  const id = requireId(req.params.id, 'Transfer ID');
  const existing = await StockTransfer.findById(id);
  if (!existing) throw notFound('Transfer not found');

  // Receiving branch check
  await resolveBranch(req, { branchId: existing.toBranchId });

  const receivedItems = req.body.items;
  if (!Array.isArray(receivedItems) || receivedItems.length === 0) {
    throw badRequest('Received items array is required');
  }

  const notes = str(req.body.notes) || '';

  const transfer = await transferService.receiveTransfer({
    tenantId: req.auth.tenantId,
    transferId: id,
    receivedItems,
    notes,
    userId: req.auth.userId,
  });

  await recordAudit({
    action: 'inventory.transfer_received',
    entity: 'StockTransfer',
    entityId: transfer._id,
    after: transfer.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    branchId: transfer.toBranchId,
  });

  res.json({ data: maskCost(transfer.toObject(), req.auth.role) });
}

export async function cancelTransfer(req, res) {
  const id = requireId(req.params.id, 'Transfer ID');
  const existing = await StockTransfer.findById(id);
  if (!existing) throw notFound('Transfer not found');

  await resolveBranch(req, { branchId: existing.fromBranchId });

  const reason = str(req.body.reason) || 'Cancelled by user';

  const transfer = await transferService.cancelTransfer({
    tenantId: req.auth.tenantId,
    transferId: id,
    reason,
    userId: req.auth.userId,
  });

  await recordAudit({
    action: 'inventory.transfer_cancelled',
    entity: 'StockTransfer',
    entityId: transfer._id,
    after: transfer.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    branchId: transfer.fromBranchId,
  });

  res.json({ data: maskCost(transfer.toObject(), req.auth.role) });
}

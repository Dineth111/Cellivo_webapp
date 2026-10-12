import mongoose from 'mongoose';
import Supplier from '../models/Supplier.model.js';
import PurchaseOrder, { PO_STATUSES } from '../models/PurchaseOrder.model.js';
import GoodsReceivedNote from '../models/GoodsReceivedNote.model.js';
import SupplierBill from '../models/SupplierBill.model.js';
import SupplierPayment from '../models/SupplierPayment.model.js';
import PurchaseReturn from '../models/PurchaseReturn.model.js';
import * as purchasingService from '../services/purchasing.service.js';
import { str, requireId, pageParams, escapeRegex } from '../../../core/validate.js';
import { badRequest, notFound } from '../../../core/errors.js';
import { record as recordAudit } from '../../../core/audit.js';
import { maskCost } from '../utils/maskCost.js';
import { resolveBranch, resolveRecordBranch } from '../../pos/utils/branch.js';

// ==========================================
// SUPPLIERS
// ==========================================

export async function listSuppliers(req, res) {
  const { skip, limit } = pageParams(req);
  const filter = {};

  if (req.query.isArchived !== undefined) {
    filter.isArchived = req.query.isArchived === 'true';
  } else {
    filter.isArchived = false;
  }

  if (req.query.search) {
    const rx = escapeRegex(req.query.search);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { contactPerson: { $regex: rx, $options: 'i' } },
      { phone: { $regex: rx, $options: 'i' } },
      { email: { $regex: rx, $options: 'i' } },
    ];
  }

  const [items, total] = await Promise.all([
    Supplier.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
    Supplier.countDocuments(filter),
  ]);

  res.json({
    data: items,
    pagination: { total, skip, limit },
  });
}

export async function createSupplier(req, res) {
  const name = str(req.body.name);
  if (!name) throw badRequest('Supplier name is required');

  const contactPerson = str(req.body.contactPerson) || '';
  const phone = str(req.body.phone) || '';
  const email = str(req.body.email) || '';
  const address = str(req.body.address) || '';
  const paymentTermsDays = req.body.paymentTermsDays != null ? Math.max(0, parseInt(req.body.paymentTermsDays, 10)) : 30;
  const openingBalanceCents = req.body.openingBalanceCents != null ? Math.max(0, parseInt(req.body.openingBalanceCents, 10)) : 0;
  const notes = str(req.body.notes) || '';

  const [supplier] = await Supplier.create([
    {
      name,
      contactPerson,
      phone,
      email,
      address,
      paymentTermsDays,
      openingBalanceCents,
      currentBalanceCents: openingBalanceCents,
      notes,
    },
  ]);

  await recordAudit({
    action: 'purchases.supplier_created',
    entity: 'Supplier',
    entityId: supplier._id,
    after: supplier.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.status(201).json({ data: supplier });
}

export async function getSupplier(req, res) {
  const id = requireId(req.params.id, 'Supplier ID');
  const supplier = await Supplier.findById(id).lean();
  if (!supplier) throw notFound('Supplier not found');

  res.json({ data: supplier });
}

export async function updateSupplier(req, res) {
  const id = requireId(req.params.id, 'Supplier ID');
  const supplier = await Supplier.findById(id);
  if (!supplier) throw notFound('Supplier not found');

  const before = supplier.toObject();

  if (req.body.name !== undefined) supplier.name = str(req.body.name);
  if (req.body.contactPerson !== undefined) supplier.contactPerson = str(req.body.contactPerson) || '';
  if (req.body.phone !== undefined) supplier.phone = str(req.body.phone) || '';
  if (req.body.email !== undefined) supplier.email = str(req.body.email) || '';
  if (req.body.address !== undefined) supplier.address = str(req.body.address) || '';
  if (req.body.paymentTermsDays !== undefined) supplier.paymentTermsDays = Math.max(0, parseInt(req.body.paymentTermsDays, 10));
  if (req.body.notes !== undefined) supplier.notes = str(req.body.notes) || '';
  if (req.body.isArchived !== undefined) supplier.isArchived = Boolean(req.body.isArchived);

  await supplier.save();

  await recordAudit({
    action: 'purchases.supplier_updated',
    entity: 'Supplier',
    entityId: supplier._id,
    before,
    after: supplier.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ data: supplier });
}

export async function archiveSupplier(req, res) {
  const id = requireId(req.params.id, 'Supplier ID');
  const supplier = await Supplier.findById(id);
  if (!supplier) throw notFound('Supplier not found');

  const before = supplier.toObject();
  supplier.isArchived = true;
  await supplier.save();

  await recordAudit({
    action: 'purchases.supplier_archived',
    entity: 'Supplier',
    entityId: supplier._id,
    before,
    after: supplier.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ success: true, message: 'Supplier archived' });
}

// ==========================================
// PURCHASE ORDERS
// ==========================================

export async function listPurchaseOrders(req, res) {
  const { skip, limit } = pageParams(req);
  const filter = {};

  if (req.query.supplierId) {
    filter.supplierId = requireId(req.query.supplierId, 'supplierId');
  }
  if (req.query.status) {
    filter.status = str(req.query.status);
  }
  if (req.query.branchId) {
    filter.branchId = requireId(req.query.branchId, 'branchId');
  }

  const [items, total] = await Promise.all([
    PurchaseOrder.find(filter)
      .populate('supplierId', 'name contactPerson phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PurchaseOrder.countDocuments(filter),
  ]);

  res.json({
    data: maskCost(items, req.auth.role),
    pagination: { total, skip, limit },
  });
}

export async function createPurchaseOrder(req, res) {
  const branch = await resolveBranch(req);
  const supplierId = requireId(req.body.supplierId, 'supplierId');
  const items = req.body.items;
  const expectedDate = req.body.expectedDate || null;
  const notes = str(req.body.notes) || '';

  const po = await purchasingService.createPurchaseOrder({
    tenantId: req.auth.tenantId,
    branchId: branch._id,
    supplierId,
    items,
    expectedDate,
    notes,
    userId: req.auth.userId,
  });

  await recordAudit({
    action: 'purchases.po_created',
    entity: 'PurchaseOrder',
    entityId: po._id,
    after: po.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    branchId: branch._id,
  });

  res.status(201).json({ data: maskCost(po.toObject(), req.auth.role) });
}

export async function getPurchaseOrder(req, res) {
  const id = requireId(req.params.id, 'Purchase Order ID');
  await resolveRecordBranch(req, PurchaseOrder, id, 'Purchase Order');

  const po = await PurchaseOrder.findById(id)
    .populate('supplierId', 'name contactPerson phone email')
    .populate('items.productId', 'name barcode isSerialised')
    .lean();

  if (!po) throw notFound('Purchase Order not found');

  res.json({ data: maskCost(po, req.auth.role) });
}

export async function updatePoStatus(req, res) {
  const id = requireId(req.params.id, 'Purchase Order ID');
  await resolveRecordBranch(req, PurchaseOrder, id, 'Purchase Order');

  const status = str(req.body.status);
  if (!status) throw badRequest('Status is required');

  const po = await purchasingService.updatePoStatus({
    tenantId: req.auth.tenantId,
    poId: id,
    status,
  });

  await recordAudit({
    action: 'purchases.po_status_updated',
    entity: 'PurchaseOrder',
    entityId: po._id,
    after: po.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ data: maskCost(po.toObject(), req.auth.role) });
}

// ==========================================
// GOODS RECEIVED NOTES (GRN)
// ==========================================

export async function listGrns(req, res) {
  const { skip, limit } = pageParams(req);
  const filter = {};

  if (req.query.supplierId) {
    filter.supplierId = requireId(req.query.supplierId, 'supplierId');
  }
  if (req.query.branchId) {
    filter.branchId = requireId(req.query.branchId, 'branchId');
  }
  if (req.query.status) {
    filter.status = str(req.query.status);
  }

  const [items, total] = await Promise.all([
    GoodsReceivedNote.find(filter)
      .populate('supplierId', 'name contactPerson phone')
      .populate('purchaseOrderId', 'poNumber')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    GoodsReceivedNote.countDocuments(filter),
  ]);

  res.json({
    data: maskCost(items, req.auth.role),
    pagination: { total, skip, limit },
  });
}

export async function createGrn(req, res) {
  const branch = await resolveBranch(req);
  const supplierId = requireId(req.body.supplierId, 'supplierId');
  const purchaseOrderId = req.body.purchaseOrderId ? requireId(req.body.purchaseOrderId, 'purchaseOrderId') : null;
  const paymentType = str(req.body.paymentType) || 'credit';
  const items = req.body.items;
  const notes = str(req.body.notes) || '';

  const { grn, bill } = await purchasingService.createGrn({
    tenantId: req.auth.tenantId,
    branchId: branch._id,
    supplierId,
    purchaseOrderId,
    paymentType,
    items,
    notes,
    userId: req.auth.userId,
  });

  await recordAudit({
    action: 'purchases.grn_posted',
    entity: 'GoodsReceivedNote',
    entityId: grn._id,
    after: grn.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    branchId: branch._id,
  });

  res.status(201).json({
    data: {
      grn: maskCost(grn.toObject(), req.auth.role),
      bill: bill ? bill.toObject() : null,
    },
  });
}

export async function getGrn(req, res) {
  const id = requireId(req.params.id, 'GRN ID');
  await resolveRecordBranch(req, GoodsReceivedNote, id, 'GRN');

  const grn = await GoodsReceivedNote.findById(id)
    .populate('supplierId', 'name contactPerson phone email')
    .populate('purchaseOrderId', 'poNumber')
    .populate('items.productId', 'name barcode isSerialised')
    .lean();

  if (!grn) throw notFound('GRN not found');

  res.json({ data: maskCost(grn, req.auth.role) });
}

// ==========================================
// SUPPLIER BILLS & AGEING
// ==========================================

export async function listBills(req, res) {
  const { skip, limit } = pageParams(req);
  const filter = {};

  if (req.query.supplierId) {
    filter.supplierId = requireId(req.query.supplierId, 'supplierId');
  }
  if (req.query.status) {
    filter.status = str(req.query.status);
  }

  const [items, total] = await Promise.all([
    SupplierBill.find(filter)
      .populate('supplierId', 'name contactPerson phone')
      .sort({ dueDate: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SupplierBill.countDocuments(filter),
  ]);

  res.json({
    data: items,
    pagination: { total, skip, limit },
  });
}

export async function getBillsAgeing(req, res) {
  const supplierId = req.query.supplierId ? requireId(req.query.supplierId, 'supplierId') : null;
  const report = await purchasingService.getSupplierAgeing(req.auth.tenantId, supplierId);
  res.json({ data: report });
}

export async function triggerPaymentReminders(req, res) {
  const daysAhead = req.body.daysAhead != null ? parseInt(req.body.daysAhead, 10) : 3;
  const result = await purchasingService.sendUpcomingPaymentReminders({
    tenantId: req.auth.tenantId,
    daysAhead,
  });
  res.json({ data: result });
}

// ==========================================
// SUPPLIER PAYMENTS
// ==========================================

export async function listPayments(req, res) {
  const { skip, limit } = pageParams(req);
  const filter = {};

  if (req.query.supplierId) {
    filter.supplierId = requireId(req.query.supplierId, 'supplierId');
  }
  if (req.query.billId) {
    filter.billId = requireId(req.query.billId, 'billId');
  }

  const [items, total] = await Promise.all([
    SupplierPayment.find(filter)
      .populate('supplierId', 'name contactPerson phone')
      .populate('billId', 'billNumber dueDate')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SupplierPayment.countDocuments(filter),
  ]);

  res.json({
    data: items,
    pagination: { total, skip, limit },
  });
}

export async function createPayment(req, res) {
  const branch = await resolveBranch(req);
  const supplierId = requireId(req.body.supplierId, 'supplierId');
  const billId = req.body.billId ? requireId(req.body.billId, 'billId') : null;
  const amountCents = req.body.amountCents;
  const paymentMethod = str(req.body.paymentMethod);
  const reference = str(req.body.reference) || '';
  const notes = str(req.body.notes) || '';

  if (!paymentMethod) throw badRequest('Payment method is required');

  const { payment, bill, supplier } = await purchasingService.paySupplier({
    tenantId: req.auth.tenantId,
    branchId: branch._id,
    supplierId,
    billId,
    amountCents,
    paymentMethod,
    reference,
    notes,
    userId: req.auth.userId,
  });

  await recordAudit({
    action: 'purchases.payment_created',
    entity: 'SupplierPayment',
    entityId: payment._id,
    after: payment.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    branchId: branch._id,
  });

  res.status(201).json({
    data: {
      payment: payment.toObject(),
      bill: bill ? bill.toObject() : null,
      supplierBalanceCents: supplier.currentBalanceCents,
    },
  });
}

// ==========================================
// PURCHASE RETURNS
// ==========================================

export async function listPurchaseReturns(req, res) {
  const { skip, limit } = pageParams(req);
  const filter = {};

  if (req.query.supplierId) {
    filter.supplierId = requireId(req.query.supplierId, 'supplierId');
  }
  if (req.query.branchId) {
    filter.branchId = requireId(req.query.branchId, 'branchId');
  }

  const [items, total] = await Promise.all([
    PurchaseReturn.find(filter)
      .populate('supplierId', 'name contactPerson phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PurchaseReturn.countDocuments(filter),
  ]);

  res.json({
    data: maskCost(items, req.auth.role),
    pagination: { total, skip, limit },
  });
}

export async function createPurchaseReturn(req, res) {
  const branch = await resolveBranch(req);
  const supplierId = requireId(req.body.supplierId, 'supplierId');
  const grnId = req.body.grnId ? requireId(req.body.grnId, 'grnId') : null;
  const items = req.body.items;
  const notes = str(req.body.notes) || '';

  const purchaseReturn = await purchasingService.createPurchaseReturn({
    tenantId: req.auth.tenantId,
    branchId: branch._id,
    supplierId,
    grnId,
    items,
    notes,
    userId: req.auth.userId,
  });

  await recordAudit({
    action: 'purchases.return_created',
    entity: 'PurchaseReturn',
    entityId: purchaseReturn._id,
    after: purchaseReturn.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    branchId: branch._id,
  });

  res.status(201).json({ data: maskCost(purchaseReturn.toObject(), req.auth.role) });
}

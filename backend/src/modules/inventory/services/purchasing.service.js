import mongoose from 'mongoose';
import Supplier from '../models/Supplier.model.js';
import PurchaseOrder, { PO_STATUSES } from '../models/PurchaseOrder.model.js';
import GoodsReceivedNote from '../models/GoodsReceivedNote.model.js';
import SupplierBill from '../models/SupplierBill.model.js';
import SupplierPayment from '../models/SupplierPayment.model.js';
import PurchaseReturn from '../models/PurchaseReturn.model.js';
import Product from '../models/Product.model.js';
import SerialUnit from '../models/SerialUnit.model.js';
import * as stockService from './stock.service.js';
import * as imeiService from './imei.service.js';
import * as ledgerService from '../../pos/services/ledger.service.js';
import DocumentSequence from '../models/DocumentSequence.model.js';
import * as financeService from '../../pos/services/finance.service.js';
import notificationsAdapter from '../adapters/notifications.adapter.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound } from '../../../core/errors.js';

async function withTenant(tenantId, fn) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  return await runWithContext({ tenantId: tid }, fn);
}

async function executeWithSession(passedSession, fn) {
  if (passedSession) {
    return await fn(passedSession);
  }
  const maxRetries = 10;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(async () => {
        return await fn(session);
      });
    } catch (err) {
      const isTransient =
        err?.errorLabels?.has?.('TransientTransactionError') ||
        err?.errorLabels?.includes?.('TransientTransactionError') ||
        (Array.isArray(err?.errorLabels) && err.errorLabels.includes('TransientTransactionError')) ||
        (err?.errorLabelSet && err.errorLabelSet.has('TransientTransactionError')) ||
        err?.hasErrorLabel?.('TransientTransactionError') ||
        err?.code === 112 ||
        err?.codeName === 'WriteConflict';

      if (isTransient && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 25 * attempt + Math.floor(Math.random() * 30)));
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

/**
 * Creates a new purchase order.
 */
export async function createPurchaseOrder({
  tenantId,
  branchId,
  supplierId,
  items = [],
  expectedDate = null,
  notes = '',
  userId = null,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    return await executeWithSession(session, async (s) => {
      const supplier = await Supplier.findOne({ _id: supplierId, isArchived: false }).session(s);
      if (!supplier) throw notFound('Supplier not found');

      if (!Array.isArray(items) || items.length === 0) {
        throw badRequest('Purchase order must contain at least one item');
      }

      const poNumber = await DocumentSequence.getNextNumber(tenantId, branchId, 'PO', s);
      let subtotalCents = 0;
      const processedItems = [];

      for (const item of items) {
        const product = await Product.findOne({ _id: item.productId, isArchived: false }).session(s);
        if (!product) throw notFound(`Product ${item.productId} not found`);

        const qty = Math.max(1, parseInt(item.qty, 10) || 1);
        const unitCostCents = item.unitCostCents != null ? Number(item.unitCostCents) : (product.costPriceCents || 0);
        const totalCostCents = qty * unitCostCents;
        subtotalCents += totalCostCents;

        processedItems.push({
          productId: product._id,
          name: product.name,
          barcode: product.barcode || '',
          qty,
          unitCostCents,
          totalCostCents,
          receivedQty: 0,
        });
      }

      const totalCents = subtotalCents;

      const [po] = await PurchaseOrder.create(
        [
          {
            branchId,
            poNumber,
            supplierId: supplier._id,
            status: 'draft',
            items: processedItems,
            subtotalCents,
            taxCents: 0,
            totalCents,
            expectedDate: expectedDate ? new Date(expectedDate) : null,
            notes,
            createdBy: userId,
          },
        ],
        { session: s }
      );

      return po;
    });
  });
}

/**
 * Updates status of a purchase order.
 */
export async function updatePoStatus({
  tenantId,
  poId,
  status,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    return await executeWithSession(session, async (s) => {
      if (!PO_STATUSES.includes(status)) {
        throw badRequest(`Invalid status: ${status}. Must be one of: ${PO_STATUSES.join(', ')}`);
      }

      const po = await PurchaseOrder.findOne({ _id: poId }).session(s);
      if (!po) throw notFound('Purchase order not found');

      if (['received', 'closed', 'cancelled'].includes(po.status) && po.status !== status) {
        throw badRequest(`Cannot change status of a ${po.status} purchase order`);
      }

      po.status = status;
      await po.save({ session: s });
      return po;
    });
  });
}

/**
 * Posts a Goods Received Note, receives inventory, scans IMEIs, and creates ledger journals.
 */
export async function createGrn({
  tenantId,
  branchId,
  supplierId,
  purchaseOrderId = null,
  paymentType = 'credit',
  items = [],
  notes = '',
  userId = null,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    return await executeWithSession(session, async (s) => {
      const supplier = await Supplier.findOne({ _id: supplierId, isArchived: false }).session(s);
      if (!supplier) throw notFound('Supplier not found');

      if (!Array.isArray(items) || items.length === 0) {
        throw badRequest('GRN must contain at least one item');
      }

      let po = null;
      if (purchaseOrderId) {
        po = await PurchaseOrder.findOne({ _id: purchaseOrderId }).session(s);
        if (!po) throw notFound('Purchase order not found');

        // Supplier must match
        if (String(po.supplierId) !== String(supplierId)) {
          throw badRequest('Supplier does not match purchase order supplier');
        }

        // PO status must be sent or partially_received
        if (!['sent', 'partially_received'].includes(po.status)) {
          throw badRequest(`Purchase order status must be 'sent' or 'partially_received' (current: ${po.status})`);
        }
      }

      const grnNumber = await DocumentSequence.getNextNumber(tenantId, branchId, 'GRN', s);
      let totalAmountCents = 0;
      const processedItems = [];

      for (const item of items) {
        const pid = item.productId;
        const product = await Product.findOne({ _id: pid, isArchived: false }).session(s);
        if (!product) throw notFound(`Product ${pid} not found`);

        const qty = Math.max(1, parseInt(item.qty, 10) || 1);

        // unitCostCents must be a non-negative integer
        let rawUnitCost = item.unitCostCents != null ? item.unitCostCents : product.costPriceCents;
        if (rawUnitCost == null || !Number.isInteger(Number(rawUnitCost)) || Number(rawUnitCost) < 0) {
          throw badRequest('unitCostCents must be a non-negative integer');
        }
        const unitCostCents = Number(rawUnitCost);
        const itemTotalCost = qty * unitCostCents;
        totalAmountCents += itemTotalCost;

        // With PO: product must be on PO, received qty cannot exceed ordered - received
        if (po) {
          const poLine = po.items.find((i) => String(i.productId) === String(product._id));
          if (!poLine) {
            throw badRequest(`Product ${product.name} is not on the purchase order`);
          }
          const remaining = poLine.qty - (poLine.receivedQty || 0);
          if (qty > remaining) {
            throw badRequest(`Received quantity (${qty}) exceeds remaining ordered quantity (${remaining}) for product ${product.name}`);
          }
        }

        const scannedImeis = [];
        if (product.isSerialised) {
          if (!Array.isArray(item.imeis) || item.imeis.length !== qty) {
            throw badRequest(`Serialised product ${product.name} requires exactly ${qty} scanned IMEI(s)`);
          }

          const seenInBatch = new Set();
          for (const imei of item.imeis) {
            const validated = imeiService.validateImei(imei);
            if (seenInBatch.has(validated)) {
              throw badRequest(`Duplicate IMEI ${validated} in batch`);
            }
            seenInBatch.add(validated);

            // Check database uniqueness within tenant
            const existing = await SerialUnit.findOne({
              $or: [{ imei1: validated }, { imei2: validated }],
            }).session(s);

            if (existing) {
              throw badRequest(`IMEI ${validated} already exists in this tenant (status: ${existing.status})`);
            }

            scannedImeis.push(validated);
          }
        }

        processedItems.push({
          productId: product._id,
          name: product.name,
          barcode: product.barcode,
          qty,
          unitCostCents,
          totalCostCents: itemTotalCost,
          imeis: scannedImeis,
        });
      }

      // 1. Create GRN document
      const [grn] = await GoodsReceivedNote.create(
        [
          {
            branchId,
            grnNumber,
            supplierId,
            purchaseOrderId: purchaseOrderId || null,
            paymentType,
            items: processedItems,
            totalAmountCents,
            notes,
            receivedBy: userId,
          },
        ],
        { session: s }
      );

      // 2. Adjust stock levels and create SerialUnits
      for (const pItem of processedItems) {
        await stockService.adjustStockLevel({
          tenantId,
          productId: pItem.productId,
          branchId,
          type: 'purchase_grn',
          qtyChange: pItem.qty,
          unitCostCents: pItem.unitCostCents,
          referenceType: 'purchase',
          referenceId: grnNumber,
          note: `GRN from ${supplier.name}`,
          userId,
          session: s,
        });

        if (pItem.imeis && pItem.imeis.length > 0) {
          const unitsToCreate = pItem.imeis.map((imei) => ({
            imei1: imei,
            productId: pItem.productId,
            branchId,
            unitCostCents: pItem.unitCostCents,
            supplierId: supplier._id,
            grnId: grn._id,
            grnNumber,
            status: 'in_stock',
          }));

          await SerialUnit.create(unitsToCreate, { session: s, ordered: true });
        }
      }

      // 3. Update Purchase Order if attached
      if (po) {
        for (const pItem of processedItems) {
          const poLine = po.items.find((i) => String(i.productId) === String(pItem.productId));
          if (poLine) {
            poLine.receivedQty = (poLine.receivedQty || 0) + pItem.qty;
          }
        }
        const allReceived = po.items.every((i) => (i.receivedQty || 0) >= i.qty);
        po.status = allReceived ? 'received' : 'partially_received';
        await po.save({ session: s });
      }

      // 4. Ledger posting & Supplier Bill / Balance
      let bill = null;
      const dueDate = new Date(Date.now() + (supplier.paymentTermsDays || 30) * 86400000);

      if (paymentType === 'credit') {
        // Post Dr 1050 Inventory / Cr 2040 Accounts payable (skip if total is 0)
        if (totalAmountCents > 0) {
          await ledgerService.postJournal({
            tenantId,
            branchId,
            referenceType: 'purchase',
            referenceId: grnNumber,
            description: `GRN ${grnNumber} from ${supplier.name} on credit`,
            lines: [
              { accountCode: '1050', debit: totalAmountCents, credit: 0 },
              { accountCode: '2040', debit: 0, credit: totalAmountCents },
            ],
            createdBy: userId,
            session: s,
          });
        }

        supplier.currentBalanceCents = (supplier.currentBalanceCents || 0) + totalAmountCents;
        await supplier.save({ session: s });

        const billNumber = await DocumentSequence.getNextNumber(tenantId, branchId, 'BIL', s);
        [bill] = await SupplierBill.create(
          [
            {
              branchId,
              billNumber,
              supplierId: supplier._id,
              grnId: grn._id,
              grnNumber,
              totalAmountCents,
              paidAmountCents: 0,
              balanceCents: totalAmountCents,
              dueDate,
              status: 'unpaid',
              notes,
            },
          ],
          { session: s }
        );
      } else {
        // Immediate payment method: post journal only if total > 0
        if (totalAmountCents > 0) {
          const paymentAccount = ledgerService.accountForMethod(paymentType);
          await ledgerService.postJournal({
            tenantId,
            branchId,
            referenceType: 'purchase',
            referenceId: grnNumber,
            description: `GRN ${grnNumber} from ${supplier.name} paid via ${paymentType}`,
            lines: [
              { accountCode: '1050', debit: totalAmountCents, credit: 0 },
              { accountCode: paymentAccount, debit: 0, credit: totalAmountCents },
            ],
            createdBy: userId,
            session: s,
          });

          // paymentType cash: update open cash session through financeService (as cash-out with reason "GRN <number>")
          if (paymentType === 'cash') {
            await financeService.recordCashOut({
              tenantId,
              branchId,
              amountCents: totalAmountCents,
              reason: `GRN ${grnNumber}`,
              userId,
              session: s,
            });
          }
        }

        const billNumber = await DocumentSequence.getNextNumber(tenantId, branchId, 'BIL', s);
        [bill] = await SupplierBill.create(
          [
            {
              branchId,
              billNumber,
              supplierId: supplier._id,
              grnId: grn._id,
              grnNumber,
              totalAmountCents,
              paidAmountCents: totalAmountCents,
              balanceCents: 0,
              dueDate,
              status: 'paid',
              notes,
            },
          ],
          { session: s }
        );

        if (totalAmountCents > 0) {
          const paymentNumber = await DocumentSequence.getNextNumber(tenantId, branchId, 'SPY', s);
          await SupplierPayment.create(
            [
              {
                branchId,
                paymentNumber,
                supplierId: supplier._id,
                billId: bill._id,
                amountCents: totalAmountCents,
                paymentMethod: paymentType,
                reference: grnNumber,
                notes: 'Immediate payment upon delivery',
                paidBy: userId,
              },
            ],
            { session: s }
          );
        }
      }

      return { grn, bill };
    });
  });
}

/**
 * Record a payment to a supplier and post to the ledger.
 */
export async function paySupplier({
  tenantId,
  branchId,
  supplierId,
  billId = null,
  amountCents,
  paymentMethod,
  reference = '',
  notes = '',
  userId = null,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    return await executeWithSession(session, async (s) => {
      const supplier = await Supplier.findOne({ _id: supplierId, isArchived: false }).session(s);
      if (!supplier) throw notFound('Supplier not found');

      const paymentAmount = Number(amountCents);
      if (!paymentAmount || paymentAmount <= 0) {
        throw badRequest('Payment amount must be greater than 0');
      }

      let bill = null;
      if (billId) {
        bill = await SupplierBill.findOne({ _id: billId, supplierId }).session(s);
        if (!bill) throw notFound('Supplier bill not found');
        if (bill.status === 'paid') throw badRequest('Bill is already fully paid');

        bill.paidAmountCents = (bill.paidAmountCents || 0) + paymentAmount;
        bill.balanceCents = Math.max(0, bill.totalAmountCents - bill.paidAmountCents);
        bill.status = bill.balanceCents === 0 ? 'paid' : 'partially_paid';
        await bill.save({ session: s });
      }

      supplier.currentBalanceCents = Math.max(0, (supplier.currentBalanceCents || 0) - paymentAmount);
      await supplier.save({ session: s });

      const paymentNumber = await DocumentSequence.getNextNumber(tenantId, branchId, 'SPY', s);
      const [payment] = await SupplierPayment.create(
        [
          {
            branchId,
            paymentNumber,
            supplierId: supplier._id,
            billId: bill ? bill._id : null,
            amountCents: paymentAmount,
            paymentMethod,
            reference,
            notes,
            paidBy: userId,
          },
        ],
        { session: s }
      );

      // Ledger posting: Dr 2040 Accounts payable / Cr accountForMethod
      const creditAccount = ledgerService.accountForMethod(paymentMethod);
      await ledgerService.postJournal({
        tenantId,
        branchId,
        referenceType: 'supplier_payment',
        referenceId: paymentNumber,
        description: `Supplier payment ${paymentNumber} to ${supplier.name}`,
        lines: [
          { accountCode: '2040', debit: paymentAmount, credit: 0 },
          { accountCode: creditAccount, debit: 0, credit: paymentAmount },
        ],
        createdBy: userId,
        session: s,
      });

      return { payment, bill, supplier };
    });
  });
}

/**
 * Process a purchase return: return items to supplier, reduce stock, and credit accounts payable.
 */
export async function createPurchaseReturn({
  tenantId,
  branchId,
  supplierId,
  grnId = null,
  items = [],
  notes = '',
  userId = null,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    return await executeWithSession(session, async (s) => {
      const supplier = await Supplier.findOne({ _id: supplierId, isArchived: false }).session(s);
      if (!supplier) throw notFound('Supplier not found');

      if (!Array.isArray(items) || items.length === 0) {
        throw badRequest('Purchase return must contain items');
      }

      const returnNumber = await DocumentSequence.getNextNumber(tenantId, branchId, 'PRT', s);
      let totalAmountCents = 0;
      const processedItems = [];

      for (const item of items) {
        const product = await Product.findOne({ _id: item.productId, isArchived: false }).session(s);
        if (!product) throw notFound(`Product ${item.productId} not found`);

        const qty = Math.max(1, parseInt(item.qty, 10) || 1);
        const unitCostCents = item.unitCostCents != null ? Number(item.unitCostCents) : (product.costPriceCents || 0);
        const itemTotalCost = qty * unitCostCents;
        totalAmountCents += itemTotalCost;

        // If non-serialised, deduct stock atomically via adjustStockLevel
        if (!Array.isArray(item.imeis) || item.imeis.length === 0) {
          await stockService.adjustStockLevel({
            tenantId,
            productId: product._id,
            branchId,
            type: 'purchase_return',
            qtyChange: -qty,
            unitCostCents,
            referenceType: 'purchase_return',
            referenceId: returnNumber,
            note: `Return to supplier ${supplier.name}: ${notes}`,
            userId,
            session: s,
          });
        } else {
          // Serialised: transitionStatus moves stock level (-1) atomically for each unit
          for (const imei of item.imeis) {
            await imeiService.transitionStatus({
              tenantId,
              imei,
              newStatus: 'with_supplier',
              branchId,
              reason: item.reason || notes || 'Purchase return to supplier',
              userId,
              session: s,
            });
          }
        }

        processedItems.push({
          productId: product._id,
          name: product.name,
          barcode: product.barcode,
          qty,
          unitCostCents,
          totalCostCents: itemTotalCost,
          imeis: item.imeis || [],
          reason: item.reason || '',
        });
      }

      const [purchaseReturn] = await PurchaseReturn.create(
        [
          {
            branchId,
            returnNumber,
            supplierId: supplier._id,
            grnId: grnId || null,
            items: processedItems,
            totalAmountCents,
            notes,
            processedBy: userId,
          },
        ],
        { session: s }
      );

      // Reduce supplier balance
      supplier.currentBalanceCents = Math.max(0, (supplier.currentBalanceCents || 0) - totalAmountCents);
      await supplier.save({ session: s });

      // Ledger posting: Dr 2040 Accounts payable / Cr 1050 Inventory
      await ledgerService.postJournal({
        tenantId,
        branchId,
        referenceType: 'purchase_return',
        referenceId: returnNumber,
        description: `Purchase return ${returnNumber} to ${supplier.name}`,
        lines: [
          { accountCode: '2040', debit: totalAmountCents, credit: 0 },
          { accountCode: '1050', debit: 0, credit: totalAmountCents },
        ],
        createdBy: userId,
        session: s,
      });

      return purchaseReturn;
    });
  });
}

/**
 * Calculate supplier ageing buckets for unpaid bills.
 */
export async function getSupplierAgeing(tenantId, supplierId = null) {
  return await withTenant(tenantId, async () => {
    const filter = { status: { $in: ['unpaid', 'partially_paid'] } };
    if (supplierId) filter.supplierId = supplierId;

    const bills = await SupplierBill.find(filter).populate('supplierId', 'name contactPerson phone').lean();
    const now = Date.now();

    const summary = {
      totalOutstandingCents: 0,
      currentCents: 0, // 0-30 days
      thirtyToSixtyCents: 0, // 31-60 days
      sixtyToNinetyCents: 0, // 61-90 days
      overNinetyCents: 0, // > 90 days
      bills: [],
    };

    for (const bill of bills) {
      summary.totalOutstandingCents += bill.balanceCents;
      const ageDays = Math.max(0, Math.floor((now - new Date(bill.createdAt).getTime()) / (1000 * 60 * 60 * 24)));

      let bucket = 'current';
      if (ageDays > 90) {
        summary.overNinetyCents += bill.balanceCents;
        bucket = 'over_90';
      } else if (ageDays > 60) {
        summary.sixtyToNinetyCents += bill.balanceCents;
        bucket = '61_90';
      } else if (ageDays > 30) {
        summary.thirtyToSixtyCents += bill.balanceCents;
        bucket = '31_60';
      } else {
        summary.currentCents += bill.balanceCents;
      }

      summary.bills.push({
        ...bill,
        ageDays,
        bucket,
      });
    }

    return summary;
  });
}

/**
 * Send upcoming payment reminders via notification adapter.
 */
export async function sendUpcomingPaymentReminders({
  tenantId,
  daysAhead = 3,
}) {
  return await withTenant(tenantId, async () => {
    const cutoffDate = new Date(Date.now() + daysAhead * 86400000);
    const bills = await SupplierBill.find({
      status: { $in: ['unpaid', 'partially_paid'] },
      dueDate: { $lte: cutoffDate },
    }).populate('supplierId', 'name email phone');

    const sent = [];
    for (const bill of bills) {
      const res = await notificationsAdapter.sendSupplierPaymentReminder({
        tenantId,
        supplierId: bill.supplierId?._id || bill.supplierId,
        supplierName: bill.supplierId?.name || 'Unknown Supplier',
        billNumber: bill.billNumber,
        amountCents: bill.balanceCents,
        dueDate: bill.dueDate,
      });
      sent.push({ billId: bill._id, billNumber: bill.billNumber, res });
    }

    return { count: sent.length, reminders: sent };
  });
}

export default {
  createPurchaseOrder,
  updatePoStatus,
  createGrn,
  paySupplier,
  createPurchaseReturn,
  getSupplierAgeing,
  sendUpcomingPaymentReminders,
};

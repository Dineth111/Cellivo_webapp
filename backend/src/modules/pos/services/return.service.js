import mongoose from 'mongoose';
import Invoice from '../models/Invoice.model.js';
import CreditNote from '../models/CreditNote.model.js';
import Payment from '../models/Payment.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound, forbidden, AppError } from '../../../core/errors.js';
import { hasSpecial } from '../../../core/permissions.js';
import * as money from '../money.js';
import * as ledgerService from './ledger.service.js';
import * as stockAdapter from '../adapters/stock.adapter.js';
import * as auditAdapter from '../adapters/audit.adapter.js';
import { completeSale } from './sale.service.js';
import * as financeService from './finance.service.js';
import * as loyaltyService from './loyalty.service.js';

/**
 * Format Credit Note sequence: CN-YYYYMMDD-XXXX
 */
function generateCreditNoteNumber() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `CN-${dateStr}-${rand}`;
}

import { isValidImei } from '../utils/imei.js';
export { isValidImei };

/**
 * Looks up an invoice and calculates eligible return items and remaining quantities.
 */
export async function getInvoiceForReturn({ tenantId, invoiceNumber, returnWindowDays = 7 }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  return await runWithContext({ tenantId: tid }, async () => {
    const invoice = await Invoice.findOne({ invoiceNumber: String(invoiceNumber).trim() })
      .populate('customerId', 'name phone email')
      .lean();

    if (!invoice) throw notFound(`Invoice ${invoiceNumber} not found`);

    if (['voided', 'returned'].includes(invoice.status)) {
      throw badRequest(`Invoice ${invoiceNumber} is already ${invoice.status}`, 'INVOICE_NOT_RETURNABLE');
    }

    // Check return window
    const now = new Date();
    const invoiceDate = new Date(invoice.createdAt);
    const diffDays = (now - invoiceDate) / (1000 * 60 * 60 * 24);
    const isWithinWindow = diffDays <= returnWindowDays;

    // Fetch prior credit notes for this invoice to calculate cumulative returned quantities
    const creditNotes = await CreditNote.find({ originalInvoiceId: invoice._id }).lean();

    const returnedQtyMap = {};
    for (const cn of creditNotes) {
      for (const itm of cn.items) {
        const key = itm.imei || itm.barcode || String(itm.productId || itm.name);
        returnedQtyMap[key] = (returnedQtyMap[key] || 0) + (itm.qty || 1);
      }
    }

    const eligibleItems = invoice.lines.map((l) => {
      const key = l.imei || l.barcode || String(l.productId || l.name);
      const alreadyReturned = returnedQtyMap[key] || 0;
      const remainingQty = Math.max(0, l.qty - alreadyReturned);

      return {
        lineId: l._id,
        productId: l.productId,
        name: l.name,
        barcode: l.barcode,
        imei: l.imei,
        soldQty: l.qty,
        alreadyReturnedQty: alreadyReturned,
        eligibleQty: remainingQty,
        unitPriceCents: l.unitPriceCents,
        discountCents: l.discountCents,
        netUnitPriceCents: l.qty > 0 ? Math.round(l.netCents / l.qty) : l.unitPriceCents,
        taxCents: l.taxCents,
      };
    });

    return {
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      branchId: invoice.branchId,
      createdAt: invoice.createdAt,
      status: invoice.status,
      customerSnapshot: invoice.customerSnapshot,
      customerId: invoice.customerId,
      grandTotalCents: invoice.grandTotalCents,
      isWithinWindow,
      daysSincePurchase: Math.floor(diffDays),
      returnWindowDays,
      eligibleItems,
    };
  });
}

/**
 * Processes counter return, creates CreditNote, restocks if resellable, and posts ledger entries.
 */
export async function processReturn({
  tenantId,
  branchId,
  userId,
  userRole,
  permissions = {},
  data = {},
  returnWindowDays = 7,
}) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId
    ? branchId instanceof mongoose.Types.ObjectId
      ? branchId
      : new mongoose.Types.ObjectId(String(branchId))
    : null;

  const {
    invoiceId,
    items = [], // [{ lineId, productId, name, imei, barcode, qty, refundCents, condition, reason }]
    refundMethod = 'cash', // 'cash', 'card', 'store_credit'
    notes = '',
  } = data;

  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest('Return must specify at least one item', 'EMPTY_RETURN_ITEMS');
  }

  // Manager approval check: if cashier lacks approve_return permission
  const canApprove = hasSpecial(userRole, 'approve_return') || permissions['pos.returns.approve'];
  if (!canApprove && userRole?.name === 'Cashier') {
    throw forbidden('Returns require manager approval. Ask a supervisor to authorize.', 'V-06');
  }

  return await runWithContext({ tenantId: tid }, async () => {
    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) throw notFound('Original invoice not found');
    if (!hasSpecial(userRole, 'view_all_branches') && String(invoice.branchId) !== String(bid)) {
      throw forbidden('This invoice belongs to another branch', 'BRANCH_FORBIDDEN');
    }

    if (['voided', 'returned'].includes(invoice.status)) {
      throw badRequest(`Invoice is already ${invoice.status}`, 'INVOICE_ALREADY_CLOSED');
    }

    // Verify return window
    const now = new Date();
    const invoiceDate = new Date(invoice.createdAt);
    const diffDays = (now - invoiceDate) / (1000 * 60 * 60 * 24);
    if (diffDays > returnWindowDays) {
      throw new AppError(
        400,
        `Return window of ${returnWindowDays} days has passed (invoice date was ${Math.floor(diffDays)} days ago)`,
        'RETURN_WINDOW_EXPIRED'
      );
    }

    // Verify item eligibility and cumulative quantities
    const previousCreditNotes = await CreditNote.find({ originalInvoiceId: invoice._id }).lean();
    const returnedQtyMap = {};
    for (const cn of previousCreditNotes) {
      for (const itm of cn.items) {
        const key = itm.imei || itm.barcode || String(itm.productId || itm.name);
        returnedQtyMap[key] = (returnedQtyMap[key] || 0) + (itm.qty || 1);
      }
    }

    let subtotalRefundCents = 0;
    const validatedReturnItems = [];
    let restockedCostCents = 0;

    for (const retItem of items) {
      const line = invoice.lines.find(
        (l) =>
          (retItem.lineId && String(l._id) === String(retItem.lineId)) ||
          (retItem.imei && l.imei === retItem.imei) ||
          (retItem.barcode && l.barcode === retItem.barcode)
      );

      if (!line) {
        throw badRequest(`Item ${retItem.name || retItem.imei || 'specified'} was not part of original invoice`, 'INVALID_RETURN_ITEM');
      }

      if (retItem.imei && line.imei && retItem.imei !== line.imei) {
        throw badRequest(`IMEI ${retItem.imei} does not match original invoice IMEI ${line.imei}`, 'IMEI_MISMATCH');
      }

      const key = line.imei || line.barcode || String(line.productId || line.name);
      const priorReturned = returnedQtyMap[key] || 0;
      const requestedQty = Number(retItem.qty || 1);
      if (priorReturned + requestedQty > line.qty) {
        throw badRequest(
          `Cannot return ${requestedQty} units of ${line.name}. Already returned: ${priorReturned}, original qty: ${line.qty}`,
          'RETURN_QTY_EXCEEDED'
        );
      }
      returnedQtyMap[key] = priorReturned + requestedQty;

      // Calculate unit refund
      const netPerUnit = line.qty > 0 ? Math.round(line.netCents / line.qty) : line.unitPriceCents;
      const calculatedRefund = retItem.refundCents != null ? money.round(retItem.refundCents) : money.multiplyByQty(netPerUnit, requestedQty);

      subtotalRefundCents = money.add(subtotalRefundCents, calculatedRefund);

      const condition = retItem.condition || 'Resellable';
      validatedReturnItems.push({
        productId: line.productId,
        name: line.name,
        barcode: line.barcode,
        imei: line.imei,
        qty: requestedQty,
        unitPriceCents: line.unitPriceCents,
        refundCents: calculatedRefund,
        condition,
        reason: retItem.reason || 'Customer return',
      });

      // If item is resellable, calculate cost for COGS reversal
      if (condition === 'Resellable') {
        const lineCost = line.costPriceCents || 0;
        restockedCostCents = money.add(restockedCostCents, money.multiplyByQty(lineCost, requestedQty));
      }
    }

    // Execute atomic transaction for CreditNote, Stock, and Ledger
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(async () => {
        const creditNoteNumber = generateCreditNoteNumber();

        const creditNote = new CreditNote({
          branchId: bid || invoice.branchId,
          creditNoteNumber,
          originalInvoiceId: invoice._id,
          originalInvoiceNumber: invoice.invoiceNumber,
          customerId: invoice.customerId,
          items: validatedReturnItems,
          subtotalCents: subtotalRefundCents,
          taxCents: 0,
          totalRefundCents: subtotalRefundCents,
          refundMethod,
          approvedBy: userId,
          processedBy: userId,
          notes,
        });

        await creditNote.save({ session });

        // Restock resellable items
        for (const item of validatedReturnItems) {
          if (item.condition === 'Resellable') {
            await stockAdapter.restockReturn(
              tid,
              bid || invoice.branchId,
              item.imei || item.barcode || item.productId,
              item.qty,
              session
            );
          }
        }

        // Post Double-Entry Ledger entries
        if (refundMethod === 'store_credit') {
          await ledgerService.postStoreCredit({
            tenantId: tid,
            branchId: bid || invoice.branchId,
            customerId: invoice.customerId || String(invoice._id),
            amountCents: subtotalRefundCents,
            reason: `Return on invoice ${invoice.invoiceNumber} (CN: ${creditNoteNumber})`,
            createdBy: userId,
            session,
          });
        } else {
          await ledgerService.postRefund({
            tenantId: tid,
            branchId: bid || invoice.branchId,
            refundId: creditNote._id,
            amountCents: subtotalRefundCents,
            paymentMethod: refundMethod,
            restockedCostCents,
            createdBy: userId,
            session,
          });
        }

        // Update active CashSession if refund method was cash
        if (refundMethod === 'cash' && subtotalRefundCents > 0) {
          await financeService.updateSessionCashSale({
            tenantId: tid,
            branchId: bid || invoice.branchId,
            amountCents: subtotalRefundCents,
            isRefund: true,
            session,
            userId,
          });
        }

        // Reverse loyalty points originally earned on returned item value
        if (invoice.customerId && subtotalRefundCents > 0) {
          await loyaltyService.reversePoints({
            tenantId: tid,
            branchId: bid || invoice.branchId,
            customerId: invoice.customerId,
            invoiceId: invoice._id,
            refundedAmountCents: subtotalRefundCents,
            session,
          });
        }

        // Check if invoice is now fully returned or partially returned
        let allSoldItemsReturned = true;
        for (const line of invoice.lines) {
          const key = line.imei || line.barcode || String(line.productId || line.name);
          if ((returnedQtyMap[key] || 0) < line.qty) {
            allSoldItemsReturned = false;
            break;
          }
        }

        invoice.status = allSoldItemsReturned ? 'returned' : 'partially_returned';
        await invoice.save({ session });

        // Audit log
        await auditAdapter.record({
          action: 'pos.return_processed',
          entity: 'CreditNote',
          entityId: creditNote._id,
          after: {
            creditNoteNumber,
            invoiceNumber: invoice.invoiceNumber,
            totalRefundCents: subtotalRefundCents,
            refundMethod,
          },
          tenantId: tid,
          userId,
        });

        return creditNote;
      });
    } finally {
      await session.endSession();
    }
  });
}

/**
 * Processes an atomic exchange: counter return + new sale in one transaction.
 */
export async function processExchange({
  tenantId,
  branchId,
  userId,
  userRole,
  permissions = {},
  data = {},
  returnWindowDays = 7,
}) {
  const {
    returnPayload, // { invoiceId, items, notes }
    salePayload, // { customerId, lines, payments, invoiceDiscountPercent, tradeIn, notes }
  } = data;

  if (!returnPayload || !salePayload) {
    throw badRequest('Exchange requires both returnPayload and salePayload', 'INVALID_EXCHANGE_DATA');
  }

  // 1. Process return with store credit / exchange credit
  const returnResult = await processReturn({
    tenantId,
    branchId,
    userId,
    userRole,
    permissions,
    data: {
      ...returnPayload,
      refundMethod: 'store_credit', // credited towards exchange
    },
    returnWindowDays,
  });

  const exchangeCreditCents = returnResult.totalRefundCents;

  // 2. Adjust payments or tradeIn on salePayload with exchange credit
  const salePayments = Array.isArray(salePayload.payments) ? [...salePayload.payments] : [];

  // Add the store credit from return as an automatic payment line
  salePayments.unshift({
    method: 'store_credit',
    amountCents: exchangeCreditCents,
    reference: `Exchange Credit Note ${returnResult.creditNoteNumber}`,
  });

  // Complete the new sale
  const saleResult = await completeSale({
    tenantId,
    branchId,
    userId,
    userRole,
    permissions,
    data: {
      ...salePayload,
      payments: salePayments,
      notes: `${salePayload.notes || ''} [Exchange CN: ${returnResult.creditNoteNumber}]`.trim(),
    },
  });

  return {
    creditNote: returnResult,
    exchangeInvoice: saleResult,
    exchangeCreditCents,
  };
}

export default {
  isValidImei,
  getInvoiceForReturn,
  processReturn,
  processExchange,
};

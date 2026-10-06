import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import Invoice from '../models/Invoice.model.js';
import Payment from '../models/Payment.model.js';
import InvoiceSequence from '../models/InvoiceSequence.model.js';
import HeldCart from '../models/HeldCart.model.js';
import Quotation from '../models/Quotation.model.js';
import Customer from '../../customers/Customer.model.js';
import Branch from '../../branches/Branch.model.js';
import Tenant from '../../tenants/Tenant.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound, forbidden, AppError } from '../../../core/errors.js';
import { hasSpecial } from '../../../core/permissions.js';
import * as money from '../money.js';
import * as ledgerService from './ledger.service.js';
import * as stockAdapter from '../adapters/stock.adapter.js';
import * as auditAdapter from '../adapters/audit.adapter.js';
import { verifyApprovalPin } from '../adapters/approvalPin.adapter.js';
import { isValidImei } from '../utils/imei.js';
import * as creditService from './credit.service.js';

export const posEvents = new EventEmitter();

/**
 * Strips costPriceCents, unitCost, and margin from lines and invoice
 * if the user lacks the 'view_cost_margin' special permission.
 */
export function maskCostMargins(invoiceOrLines, allowCostMargin = false) {
  if (allowCostMargin) return invoiceOrLines;

  const sanitizeLine = (line) => {
    const l = typeof line.toObject === 'function' ? line.toObject() : { ...line };
    delete l.costPriceCents;
    delete l.unitCost;
    delete l.margin;
    return l;
  };

  if (Array.isArray(invoiceOrLines)) {
    return invoiceOrLines.map(sanitizeLine);
  }

  const inv = typeof invoiceOrLines.toObject === 'function' ? invoiceOrLines.toObject() : { ...invoiceOrLines };
  if (inv.lines) {
    inv.lines = inv.lines.map(sanitizeLine);
  }
  delete inv.costPriceCents;
  delete inv.totalCostCents;
  delete inv.margin;
  return inv;
}

/**
 * Calculates cart totals using money utility.
 */
export function calculateCartTotals(params) {
  return money.calculateInvoiceTotals(params);
}

/**
 * Completes a POS checkout transaction atomically.
 * Single MongoDB transaction spanning Invoice + Payments + Stock deduction + Double-entry Ledger posting.
 */
export async function completeSale({
  tenantId,
  branchId,
  userId,
  userRole,
  permissions = {},
  data = {},
  idempotencyKey = null,
}) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;
  const allowCostMargin = hasSpecial(userRole, 'view_cost_margin');

  return await runWithContext({ tenantId: tid }, async () => {
    // 1. Idempotency protection: return existing invoice if already processed
    if (idempotencyKey) {
      const existing = await Invoice.findOne({ idempotencyKey }).lean();
      if (existing) {
        return maskCostMargins(existing, allowCostMargin);
      }
    }

    const {
      customerId = null,
      lines = [],
      payments = [],
      invoiceDiscountPercent = 0,
      invoiceDiscountAmountCents = 0,
      tradeInValueCents = 0,
      tradeIn = null,
      installmentPlan = null,
      taxRatePercent = 0,
      notes = '',
      managerPin = null,
    } = data;

    if (!Array.isArray(lines) || lines.length === 0) {
      throw badRequest('Cart cannot be empty', 'EMPTY_CART');
    }

    // 2. Validate Customer and credit conditions
    let customerSnapshot = { name: 'Walk-in Customer', phone: '', email: '', nic: '' };
    let isWholesaleCustomer = false;
    let customerNic = '';
    if (customerId) {
      const cust = await Customer.findById(customerId).lean();
      if (!cust) throw notFound('Customer not found');
      customerSnapshot = { name: cust.name, phone: cust.phone || '', email: cust.email || '', nic: cust.nic || '' };
      customerNic = cust.nic || '';
      isWholesaleCustomer = cust.type === 'wholesale';
    }

    const isCreditSale = payments.some((p) => p.method === 'credit') || !!installmentPlan;
    if (isCreditSale && !customerId) {
      throw badRequest('Walk-in customers cannot purchase on credit. Please select a customer.', 'CREDIT_REQUIRES_CUSTOMER');
    }

    // Trade-in regulatory compliance (IMEI Luhn check + Customer NIC identification)
    if (tradeIn || (tradeInValueCents && tradeInValueCents > 0)) {
      if (tradeIn) {
        const imeiStr = tradeIn.imei ? String(tradeIn.imei).trim() : '';
        const isNumeric = imeiStr && /^\d+$/.test(imeiStr);
        const isStandardImei = imeiStr && /^\d{14,16}$/.test(imeiStr);

        if ((isNumeric && !isValidImei(imeiStr)) || (tradeIn.compliance && !isValidImei(imeiStr))) {
          throw badRequest('Invalid trade-in IMEI: failed Luhn checksum validation', 'INVALID_TRADE_IN_IMEI');
        }

        if (isStandardImei || tradeIn.compliance) {
          const identity = customerNic || tradeIn.customerNic || tradeIn.nic || (data.customerNic ? String(data.customerNic).trim() : '');
          if (!identity) {
            throw badRequest('Trade-in compliance requires customer identity verification (NIC / Passport)', 'TRADE_IN_NIC_REQUIRED');
          }
        }
      }
    }

    // 3. Validate items, IMEI duplication, and prices
    const processedLines = [];
    const seenImeis = new Set();
    let requiresPriceOverrideApproval = false;
    let requiresDiscountApproval = false;
    let highestDiscountPercent = Number(invoiceDiscountPercent || 0);

    for (const raw of lines) {
      const qty = Number(raw.qty || 1);

      // Auto-apply wholesale price if customer is wholesale and raw price wasn't manually overridden
      let unitPriceCents = money.round(raw.unitPriceCents ?? raw.priceCents ?? 0);
      if (isWholesaleCustomer && raw.wholesalePriceCents && raw.wholesalePriceCents > 0) {
        unitPriceCents = money.round(raw.wholesalePriceCents);
      } else if (isWholesaleCustomer && (raw.barcode || raw.imei)) {
        const stockItem = await stockAdapter.lookupByBarcode(tid, bid, raw.barcode);
        if (stockItem && stockItem.wholesalePriceCents > 0) {
          unitPriceCents = money.round(stockItem.wholesalePriceCents);
        }
      }

      // IMEI validations
      if (raw.imei) {
        const imeiStr = String(raw.imei).trim();
        if (qty !== 1) {
          throw badRequest(`IMEI line ${imeiStr} quantity must be 1`, 'INVALID_IMEI_QTY');
        }
        if (seenImeis.has(imeiStr)) {
          throw badRequest(`Duplicate IMEI in cart: ${imeiStr}`, 'DUPLICATE_IMEI');
        }
        seenImeis.add(imeiStr);

        // Check if IMEI was already sold in an active invoice
        const alreadySold = await Invoice.findOne({
          status: { $nin: ['voided', 'returned'] },
          'lines.imei': imeiStr,
        }).lean();

        if (alreadySold) {
          throw new AppError(
            400,
            `IMEI ${imeiStr} was sold on invoice ${alreadySold.invoiceNumber}. Choose another unit or process a return first.`,
            'V-03'
          );
        }
      }

      // Cost price resolution
      let costPriceCents = money.round(raw.costPriceCents || 0);
      if (costPriceCents === 0 && (raw.barcode || raw.imei)) {
        costPriceCents = await stockAdapter.getCost(tid, raw.imei || raw.barcode);
      }

      // Below cost check (requires override_price special permission)
      if (unitPriceCents < costPriceCents) {
        if (!hasSpecial(userRole, 'override_price')) {
          requiresPriceOverrideApproval = true;
        }
      }

      // Line discount check
      const lineDiscPercent = Number(raw.discountPercent || 0);
      if (lineDiscPercent > highestDiscountPercent) {
        highestDiscountPercent = lineDiscPercent;
      }

      const calculatedLine = money.calculateLine({
        unitPriceCents,
        qty,
        discountPercent: lineDiscPercent,
        discountAmountCents: money.round(raw.discountAmountCents || 0),
        taxRatePercent: Number(raw.taxRatePercent || taxRatePercent || 0),
      });

      processedLines.push({
        productId: raw.productId || null,
        name: raw.name || 'Product',
        barcode: raw.barcode || '',
        imei: raw.imei ? String(raw.imei).trim() : null,
        qty,
        unitPriceCents,
        costPriceCents,
        discountPercent: lineDiscPercent,
        discountAmountCents: money.round(raw.discountAmountCents || 0),
        taxRatePercent: Number(raw.taxRatePercent || taxRatePercent || 0),
        grossCents: calculatedLine.grossCents,
        discountCents: calculatedLine.discountCents,
        netCents: calculatedLine.netCents,
        taxCents: calculatedLine.taxCents,
        lineTotalCents: calculatedLine.lineTotalCents,
      });
    }

    // Role discount limit check
    const userLimit = Number(userRole?.discountLimitPercent ?? userRole?.discountLimit ?? 0);
    if (highestDiscountPercent > userLimit) {
      requiresDiscountApproval = true;
    }

    // Verify Manager Approval PIN if required
    let approvedBy = null;
    if (requiresPriceOverrideApproval || requiresDiscountApproval) {
      const pinVerify = await verifyApprovalPin(tid, managerPin);
      if (!pinVerify.approved) {
        if (requiresDiscountApproval) {
          throw new AppError(400, 'This discount is above your limit. Ask a manager to approve.', 'V-06');
        } else {
          throw forbidden('Price override below cost requires manager approval PIN', 'PRICE_OVERRIDE_REQUIRES_APPROVAL');
        }
      }
      approvedBy = pinVerify.approver?._id || null;

      // Audit approval
      await auditAdapter.record({
        action: requiresDiscountApproval ? 'pos.discount_approved' : 'pos.price_override_approved',
        entity: 'Invoice',
        before: { limit: userLimit },
        after: { highestDiscountPercent, approvedBy },
        tenantId: tid,
        userId,
      });
    }

    // 4. Calculate invoice totals
    const totals = calculateCartTotals({
      lines: processedLines,
      invoiceDiscountPercent,
      invoiceDiscountAmountCents,
      tradeInValueCents,
      taxRatePercent,
    });

    // Credit Limit & Exposure Validation (V-07)
    if (isCreditSale && customerId) {
      const custDoc = await Customer.findById(customerId);
      const financedOrCreditCents = installmentPlan
        ? totals.grandTotalCents - Math.round(Number(installmentPlan.downPaymentCents || 0))
        : payments.filter((p) => p.method === 'credit').reduce((s, p) => s + p.amountCents, 0) || Math.max(0, totals.grandTotalCents - (payments.reduce((s, p) => s + p.amountCents, 0)));

      if (financedOrCreditCents > 0 && custDoc) {
        const currentBal = custDoc.currentBalanceCents || 0;
        const limit = custDoc.creditLimitCents || 0;
        const exposure = currentBal + financedOrCreditCents;

        if (exposure > limit) {
          const excess = exposure - limit;
          const pinVerify = await verifyApprovalPin(tid, managerPin);
          if (!pinVerify.approved) {
            throw new AppError(
              400,
              `${custDoc.name} would go over their credit limit by ${excess}. Take a payment or ask a manager to approve.`,
              'V-07'
            );
          }
        }
      }
    }

    // 5. Payments validation
    let totalPaidCents = 0;
    const normalizedPayments = [];

    for (const p of payments) {
      const amt = money.round(p.amountCents);
      if (amt <= 0) continue;
      totalPaidCents = money.add(totalPaidCents, amt);
      normalizedPayments.push({
        method: p.method,
        amountCents: amt,
        reference: p.reference || '',
        status: 'paid',
        receivedBy: userId,
      });
    }

    if (!isCreditSale && totalPaidCents < totals.grandTotalCents) {
      throw new AppError(400, `Payments are ${totals.grandTotalCents - totalPaidCents} short of the total.`, 'V-08');
    }

    const changeDueCents = Math.max(0, money.subtract(totalPaidCents, totals.grandTotalCents));
    const cashOrCollectedPaidCents = normalizedPayments
      .filter((p) => p.method !== 'credit')
      .reduce((sum, p) => sum + p.amountCents, 0);

    let paymentStatus = 'paid';
    if (isCreditSale) {
      paymentStatus = cashOrCollectedPaidCents === 0 ? 'unpaid' : cashOrCollectedPaidCents >= totals.grandTotalCents ? 'paid' : 'partially_paid';
    }

    // 6. Execute atomic transaction (with retry for write conflicts under high parallel concurrency)
    let createdInvoice;
    let savedPayments = [];
    let attempts = 0;

    while (attempts < 5) {
      attempts++;
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Atomic sequential invoice number
        const invoiceNumber = await InvoiceSequence.getNextNumber(tid, bid, 'INV-');

        // Deduct stock for all lines
        for (const line of processedLines) {
          await stockAdapter.deductStock(tid, bid, line.imei || line.barcode || line.productId, line.qty, session);
        }

        // Add trade-in device to stock if present
        if (totals.tradeInValueCents > 0 && tradeIn) {
          await stockAdapter.addTradeIn(
            tid,
            bid,
            {
              ...tradeIn,
              valuationCents: totals.tradeInValueCents,
            },
            session
          );
        }

        // Create Invoice
        createdInvoice = new Invoice({
          branchId: bid,
          invoiceNumber,
          idempotencyKey: idempotencyKey || undefined,
          status: 'completed',
          paymentStatus,
          customerId,
          customerSnapshot,
          salespersonId: userId,
          subtotalCents: totals.subtotalCents,
          discountCents: totals.totalDiscountCents,
          taxCents: totals.taxCents,
          tradeInCents: totals.tradeInValueCents,
          grandTotalCents: totals.grandTotalCents,
          totalPaidCents: isCreditSale ? cashOrCollectedPaidCents : totalPaidCents,
          changeDueCents,
          lines: processedLines,
          notes,
        });

        await createdInvoice.save({ session });

        // If installment plan requested, create plan document inside transaction
        let createdPlan = null;
        if (installmentPlan) {
          createdPlan = await creditService.createInstallmentPlan({
            tenantId: tid,
            branchId: bid,
            invoiceId: createdInvoice._id,
            invoiceNumber,
            customerId,
            customerSnapshot,
            totalAmountCents: totals.grandTotalCents,
            downPaymentCents: installmentPlan.downPaymentCents || 0,
            numberOfInstallments: installmentPlan.numberOfInstallments || 3,
            frequency: installmentPlan.frequency || 'monthly',
            firstDueDate: installmentPlan.firstDueDate || null,
            userId,
            session,
          });

          createdInvoice.installmentPlanId = createdPlan._id;
          await createdInvoice.save({ session });
        } else if (isCreditSale && customerId) {
          const creditAmt = payments.filter((p) => p.method === 'credit').reduce((s, p) => s + p.amountCents, 0) || Math.max(0, totals.grandTotalCents - totalPaidCents);
          if (creditAmt > 0) {
            const custToUpdate = await Customer.findById(customerId).session(session);
            if (custToUpdate) {
              custToUpdate.currentBalanceCents = (custToUpdate.currentBalanceCents || 0) + creditAmt;
              await custToUpdate.save({ session });
            }
          }
        }

        // Save Payment documents
        savedPayments = [];
        for (const p of normalizedPayments) {
          const payDoc = new Payment({
            branchId: bid,
            invoiceId: createdInvoice._id,
            method: p.method,
            amountCents: p.amountCents,
            reference: p.reference,
            status: p.status,
            receivedBy: userId,
          });
          await payDoc.save({ session });
          savedPayments.push(payDoc);
        }

        // Post double-entry Ledger entry
        const totalCostCents = processedLines.reduce((acc, l) => acc + money.multiplyByQty(l.costPriceCents, l.qty), 0);

        if (totals.tradeInValueCents > 0) {
          await ledgerService.postTradeIn({
            tenantId: tid,
            branchId: bid,
            saleId: invoiceNumber,
            tradeInValueCents: totals.tradeInValueCents,
            saleAmountCents: totals.grandTotalCents + totals.tradeInValueCents,
            cashPaidCents: totals.grandTotalCents,
            taxCents: totals.taxCents,
            costCents: totalCostCents,
            createdBy: userId,
            session,
          });
        } else if (isCreditSale) {
          const cashOrCardPaid = normalizedPayments
            .filter((p) => p.method !== 'credit')
            .reduce((sum, p) => sum + p.amountCents, 0);

          await ledgerService.postCreditSale({
            tenantId: tid,
            branchId: bid,
            saleId: invoiceNumber,
            amountCents: totals.grandTotalCents,
            paidAmountCents: cashOrCardPaid,
            paymentMethod: normalizedPayments.find((p) => p.method !== 'credit')?.method || 'cash',
            taxCents: totals.taxCents,
            costCents: totalCostCents,
            createdBy: userId,
            session,
          });
        } else if (normalizedPayments.length > 1) {
          await ledgerService.postSplitPayment({
            tenantId: tid,
            branchId: bid,
            saleId: invoiceNumber,
            payments: normalizedPayments,
            totalCents: totals.grandTotalCents,
            taxCents: totals.taxCents,
            costCents: totalCostCents,
            createdBy: userId,
            session,
          });
        } else if (normalizedPayments[0]?.method === 'card') {
          await ledgerService.postCardSale({
            tenantId: tid,
            branchId: bid,
            saleId: invoiceNumber,
            amountCents: totals.grandTotalCents,
            taxCents: totals.taxCents,
            costCents: totalCostCents,
            createdBy: userId,
            session,
          });
        } else {
          await ledgerService.postCashSale({
            tenantId: tid,
            branchId: bid,
            saleId: invoiceNumber,
            amountCents: totals.grandTotalCents,
            taxCents: totals.taxCents,
            costCents: totalCostCents,
            createdBy: userId,
            session,
          });
        }

        await session.commitTransaction();
        session.endSession();
        break;
      } catch (err) {
        await session.abortTransaction();
        session.endSession();
        if ((err.errorLabels?.has?.('TransientTransactionError') || err.code === 112) && attempts < 5) {
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 50));
          continue;
        }
        throw err;
      }
    }

    // 7. Emit in-process sale.completed event
    posEvents.emit('sale.completed', {
      invoice: createdInvoice,
      payments: savedPayments,
      tenantId: tid,
      branchId: bid,
      userId,
    });

    return maskCostMargins(createdInvoice, allowCostMargin);
  });
}

/**
 * Voids a completed invoice.
 * Requires 'void_invoice' special permission and mandatory reason.
 * Reverses stock, reverses ledger via void reversal, marks invoice voided.
 */
export async function voidInvoice({
  tenantId,
  branchId,
  invoiceId,
  reason,
  userId,
  userRole,
}) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  if (!hasSpecial(userRole, 'void_invoice')) {
    throw forbidden('Voiding an invoice requires the void_invoice special permission');
  }

  if (!reason || !String(reason).trim()) {
    throw badRequest('Void reason is mandatory', 'MISSING_REASON');
  }

  return await runWithContext({ tenantId: tid }, async () => {
    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status === 'voided') {
      throw badRequest('Invoice is already voided', 'ALREADY_VOIDED');
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 1. Restock returned items
      for (const line of invoice.lines) {
        await stockAdapter.restockReturn(tid, invoice.branchId, line.imei || line.barcode, line.qty, session);
      }

      // 2. Void reversal in double-entry ledger
      // Find original ledger entry referencing invoiceNumber
      await ledgerService.ensureDefaultAccounts(tid, session);
      const ledgerEntry = await mongoose.model('LedgerEntry').findOne({ referenceId: invoice.invoiceNumber }).session(session);
      if (ledgerEntry && !ledgerEntry.isVoided) {
        await ledgerService.postVoidReversal({
          tenantId: tid,
          originalEntryNumber: ledgerEntry.entryNumber,
          reason,
          createdBy: userId,
          session,
        });
      }

      // 3. Update invoice status
      invoice.status = 'voided';
      invoice.voidReason = String(reason).trim();
      invoice.voidedAt = new Date();
      invoice.voidedBy = userId;
      await invoice.save({ session });

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }

    // 4. Audit void record
    await auditAdapter.record({
      action: 'invoice.void',
      entity: 'Invoice',
      entityId: invoice._id,
      before: { status: 'completed' },
      after: { status: 'voided', reason },
      tenantId: tid,
      userId,
    });

    return invoice;
  });
}

/**
 * Holds a cart and reserves any IMEI lines for 15 minutes.
 */
export async function holdCart({ tenantId, branchId, cartName = 'Held Cart', customer, lines, discounts, heldBy }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  return await runWithContext({ tenantId: tid }, async () => {
    // Reserve IMEIs for 15 minutes
    if (Array.isArray(lines)) {
      for (const l of lines) {
        if (l.imei) {
          await stockAdapter.reserveImei(tid, branchId, l.imei, 15);
        }
      }
    }

    const held = new HeldCart({
      branchId,
      cartName,
      customer,
      lines,
      discounts,
      heldBy,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    });

    await held.save();
    return held;
  });
}

/**
 * Resumes and removes a held cart.
 */
export async function resumeCart({ tenantId, branchId, heldCartId }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  return await runWithContext({ tenantId: tid }, async () => {
    const held = await HeldCart.findById(heldCartId);
    if (!held) throw notFound('Held cart not found');

    const cartData = held.toObject();
    await HeldCart.deleteOne({ _id: heldCartId });
    return cartData;
  });
}

/**
 * Cleans up held carts older than 24 hours and releases their IMEI reservations.
 */
export async function cleanExpiredHeldCarts({ tenantId }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  return await runWithContext({ tenantId: tid }, async () => {
    const expiredCarts = await HeldCart.find({ expiresAt: { $lt: new Date() } });

    for (const cart of expiredCarts) {
      if (Array.isArray(cart.lines)) {
        for (const l of cart.lines) {
          if (l.imei) {
            await stockAdapter.releaseImei(tid, cart.branchId, l.imei);
          }
        }
      }
      await HeldCart.deleteOne({ _id: cart._id });
    }

    return { cleanedCount: expiredCarts.length };
  });
}

/**
 * Creates a quotation.
 */
export async function createQuotation({
  tenantId,
  branchId,
  customerId = null,
  lines = [],
  invoiceDiscountPercent = 0,
  taxRatePercent = 0,
  createdBy = null,
  validDays = 30,
}) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  return await runWithContext({ tenantId: tid }, async () => {
    let customerSnapshot = { name: 'Walk-in Customer' };
    if (customerId) {
      const cust = await Customer.findById(customerId).lean();
      if (cust) customerSnapshot = { name: cust.name, phone: cust.phone, email: cust.email };
    }

    const quoteNumber = await InvoiceSequence.getNextNumber(tid, branchId, 'QTE-');
    const totals = calculateCartTotals({ lines, invoiceDiscountPercent, taxRatePercent });

    const quote = new Quotation({
      branchId,
      quoteNumber,
      customerId,
      customerSnapshot,
      lines,
      subtotalCents: totals.subtotalCents,
      discountCents: totals.totalDiscountCents,
      taxCents: totals.taxCents,
      grandTotalCents: totals.grandTotalCents,
      status: 'active',
      createdBy,
      validUntil: new Date(Date.now() + validDays * 24 * 60 * 60 * 1000),
    });

    await quote.save();
    return quote;
  });
}

/**
 * Converts an active quotation into a completed invoice.
 */
export async function convertQuotationToInvoice({
  tenantId,
  branchId,
  quotationId,
  userId,
  userRole,
  payments = [],
}) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  return await runWithContext({ tenantId: tid }, async () => {
    const quote = await Quotation.findById(quotationId);
    if (!quote) throw notFound('Quotation not found');
    if (quote.status !== 'active') {
      throw badRequest(`Cannot convert quotation with status: ${quote.status}`, 'INVALID_QUOTE_STATUS');
    }

    const saleData = {
      customerId: quote.customerId,
      lines: quote.lines,
      payments,
      invoiceDiscountAmountCents: quote.discountCents,
      taxRatePercent: 0,
      notes: `Converted from Quotation ${quote.quoteNumber}`,
    };

    const invoice = await completeSale({
      tenantId: tid,
      branchId: quote.branchId || branchId,
      userId,
      userRole,
      data: saleData,
    });

    quote.status = 'converted';
    quote.convertedInvoiceId = invoice._id;
    await quote.save();

    return invoice;
  });
}

/**
 * Retrieves invoice with lines, payments, customer, branch and shop metadata for printing.
 */
export async function getInvoiceById({ tenantId, invoiceId, userRole }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const allowCostMargin = hasSpecial(userRole, 'view_cost_margin');

  return await runWithContext({ tenantId: tid }, async () => {
    const invoice = await Invoice.findById(invoiceId)
      .populate('salespersonId', 'name email')
      .populate('customerId', 'name phone email address')
      .lean();

    if (!invoice) throw notFound('Invoice not found');

    // Retrieve associated payments
    const payments = await Payment.find({ invoiceId }).sort({ createdAt: 1 }).lean();

    // Retrieve Branch details
    let branch = null;
    if (invoice.branchId) {
      branch = await Branch.findById(invoice.branchId).lean();
    }

    // Retrieve Tenant details
    const tenant = await Tenant.findById(tid)
      .select('name country currency timezone billingDetails')
      .lean();

    const result = {
      ...maskCostMargins(invoice, allowCostMargin),
      payments,
      branch: branch || {
        name: 'Main Branch',
        address: '',
        phone: '',
      },
      tenant: tenant || {
        name: 'Cellivo Shop',
        currency: 'LKR',
      },
    };

    return result;
  });
}

export default {
  posEvents,
  maskCostMargins,
  calculateCartTotals,
  completeSale,
  voidInvoice,
  holdCart,
  resumeCart,
  cleanExpiredHeldCarts,
  createQuotation,
  convertQuotationToInvoice,
  getInvoiceById,
};

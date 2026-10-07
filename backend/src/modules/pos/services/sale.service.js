import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import Invoice from '../models/Invoice.model.js';
import Payment from '../models/Payment.model.js';
import InvoiceSequence from '../models/InvoiceSequence.model.js';
import HeldCart from '../models/HeldCart.model.js';
import Quotation from '../models/Quotation.model.js';
import LedgerEntry from '../models/LedgerEntry.model.js';
import InstallmentPlan from '../models/InstallmentPlan.model.js';
import Customer from '../../customers/Customer.model.js';
import Branch from '../../branches/Branch.model.js';
import Tenant from '../../tenants/Tenant.model.js';
import { runWithContext, runAsPlatform } from '../../../core/tenantContext.js';
import { badRequest, notFound, forbidden, AppError } from '../../../core/errors.js';
import { hasSpecial } from '../../../core/permissions.js';
import * as money from '../money.js';
import * as ledgerService from './ledger.service.js';
import * as stockAdapter from '../adapters/stock.adapter.js';
import * as auditAdapter from '../adapters/audit.adapter.js';
import { verifyApprovalPin } from '../adapters/approvalPin.adapter.js';
import { isValidImei } from '../utils/imei.js';
import * as creditService from './credit.service.js';
import * as financeService from './finance.service.js';
import * as loyaltyService from './loyalty.service.js';

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
  discountLimitPercent = null,
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

    // A trade-in value must be backed by a real device (model, and IMEI for phones)
    if (money.round(tradeInValueCents) > 0) {
      const isPhone = (tradeIn?.category || 'phone') === 'phone';
      if (!tradeIn?.modelName || (isPhone && !String(tradeIn.imei || '').trim())) {
        throw badRequest('Trade-in value needs the traded device: model name, and IMEI for a phone', 'TRADE_IN_DEVICE_REQUIRED');
      }
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
    const priceChanges = [];
    let belowCost = false;

    for (const raw of lines) {
      const qty = Number(raw.qty || 1);

      // Price and cost always come from stock on the server, never from the request
      const stockItem =
        (raw.imei && (await stockAdapter.lookupImei(tid, bid, String(raw.imei).trim()))?.product) ||
        (raw.barcode && (await stockAdapter.lookupByBarcode(tid, bid, raw.barcode)));
      if (!stockItem) {
        throw badRequest(`${raw.name || raw.imei || raw.barcode || 'Item'} is not in stock at this branch`, 'V-05');
      }
      const resolvedName = raw.name || stockItem.name;
      const retailPriceCents = money.round(stockItem.sellingPriceCents || 0);
      const listPriceCents =
        isWholesaleCustomer && stockItem.wholesalePriceCents > 0 ? money.round(stockItem.wholesalePriceCents) : retailPriceCents;
      const requested = raw.unitPriceCents ?? raw.priceCents;
      // A wholesale customer gets the wholesale tier when the cart still shows the retail price
      const unitPriceCents =
        requested == null || (isWholesaleCustomer && money.round(requested) === retailPriceCents) ? listPriceCents : money.round(requested);
      const costPriceCents = money.round(stockItem.costPriceCents || 0);

      if (unitPriceCents !== listPriceCents) {
        priceChanges.push({ name: resolvedName, imei: raw.imei || null, barcode: raw.barcode || '', from: listPriceCents, to: unitPriceCents });
      }
      if (unitPriceCents < costPriceCents) belowCost = true;

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

      const lineDiscPercent = Number(raw.discountPercent || 0);
      const calculatedLine = money.calculateLine({
        unitPriceCents,
        qty,
        discountPercent: lineDiscPercent,
        discountAmountCents: money.round(raw.discountAmountCents || 0),
        taxRatePercent: Number(raw.taxRatePercent || taxRatePercent || 0),
      });

      processedLines.push({
        productId: raw.productId || null,
        name: resolvedName || 'Product',
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

    // 4. Calculate invoice totals
    const totals = calculateCartTotals({
      lines: processedLines,
      invoiceDiscountPercent,
      invoiceDiscountAmountCents,
      tradeInValueCents,
      taxRatePercent,
    });

    // Discount limit: every discount (percent or amount) is judged by its effective percent.
    // Compared in cents so a rounded percent discount is never flagged by half a cent.
    const userLimit = Number(discountLimitPercent ?? userRole?.discountLimitPercent ?? 0);
    const pct = (part, whole) => (whole > 0 ? Math.round((part * 10000) / whole) / 100 : 0);
    const netBeforeInvoiceDiscount = totals.subtotalCents - totals.totalLineDiscountsCents;
    const checks = [
      ...processedLines.map((l) => [l.discountCents, l.grossCents, 0]),
      [totals.invoiceDiscountCents, netBeforeInvoiceDiscount, 0],
      [totals.totalDiscountCents, totals.subtotalCents, processedLines.length], // stacked; allow 1 cent rounding per line
    ];
    const highestDiscountPercent = Math.max(...checks.map(([part, whole]) => pct(part, whole)));
    const requiresDiscountApproval = checks.some(([part, whole, slack]) => part > money.percentDiscount(whole, userLimit) + slack);

    const requiresPriceOverrideApproval = (priceChanges.length > 0 || belowCost) && !hasSpecial(userRole, 'override_price');

    // Trade-in limit: owner unlimited; others use role.tradeInLimitCents (not in the Role schema yet, so 0)
    const tradeInLimitCents = userRole?.key === 'owner' ? Infinity : money.round(userRole?.tradeInLimitCents ?? 0);
    const requiresTradeInApproval = totals.tradeInValueCents > tradeInLimitCents;

    // Verify Manager Approval PIN if required
    let approvedBy = null;
    if (requiresPriceOverrideApproval || requiresDiscountApproval || requiresTradeInApproval) {
      const pinVerify = await verifyApprovalPin(tid, managerPin);
      if (!pinVerify.approved) {
        if (requiresDiscountApproval) {
          throw new AppError(400, 'This discount is above your limit. Ask a manager to approve.', 'V-06');
        } else if (requiresPriceOverrideApproval) {
          throw forbidden('Changing the price or selling below cost requires manager approval', 'PRICE_OVERRIDE_REQUIRES_APPROVAL');
        } else {
          throw forbidden('This trade-in value is above your limit. Ask a manager to approve.', 'TRADE_IN_APPROVAL_REQUIRED');
        }
      }
      approvedBy = pinVerify.approver?._id || null;
    }

    // Written after the sale commits, against the invoice
    const audits = [];
    if (priceChanges.length > 0 || belowCost) {
      audits.push({
        action: 'pos.price_override',
        before: { lines: priceChanges.map((c) => ({ name: c.name, imei: c.imei, barcode: c.barcode, unitPriceCents: c.from })) },
        after: { lines: priceChanges.map((c) => ({ name: c.name, imei: c.imei, barcode: c.barcode, unitPriceCents: c.to })), belowCost, approvedBy },
      });
    }
    if (requiresDiscountApproval) {
      audits.push({ action: 'pos.discount_approved', before: { limit: userLimit }, after: { highestDiscountPercent, approvedBy } });
    }
    if (requiresTradeInApproval) {
      audits.push({
        action: 'pos.trade_in_approved',
        before: { limitCents: tradeInLimitCents },
        after: { tradeInValueCents: totals.tradeInValueCents, modelName: tradeIn.modelName, imei: tradeIn.imei || null, approvedBy },
      });
    }

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
              `${custDoc.name} would go over their credit limit by ${money.formatRupees(excess)}. Take a payment or ask a manager to approve.`,
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
      throw new AppError(400, `Payments are ${money.formatRupees(totals.grandTotalCents - totalPaidCents)} short of the total.`, 'V-08');
    }

    const changeDueCents = Math.max(0, money.subtract(totalPaidCents, totals.grandTotalCents));
    const cashTenderedCents = normalizedPayments.filter((p) => p.method === 'cash').reduce((sum, p) => sum + p.amountCents, 0);
    if (changeDueCents > cashTenderedCents) {
      throw badRequest('Change can only be given from cash. Reduce the non-cash payment to the amount due.', 'CHANGE_REQUIRES_CASH');
    }
    const cashOrCollectedPaidCents = normalizedPayments
      .filter((p) => p.method !== 'credit')
      .reduce((sum, p) => sum + p.amountCents, 0);

    let paymentStatus = 'paid';
    if (isCreditSale) {
      paymentStatus = cashOrCollectedPaidCents === 0 ? 'unpaid' : cashOrCollectedPaidCents >= totals.grandTotalCents ? 'paid' : 'partially_paid';
    }

    // Invoice numbers use the branch prefix so branches never clash within a tenant
    const branchDoc = bid ? await Branch.findById(bid).select('invoicePrefix').lean() : null;
    const invoicePrefix = branchDoc?.invoicePrefix || 'INV-';

    // 6. Execute atomic transaction (with retry for write conflicts under high parallel concurrency)
    let createdInvoice;
    let savedPayments = [];
    let attempts = 0;

    while (attempts < 5) {
      attempts++;
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Atomic sequential invoice number, taken inside the transaction (rolled back with it)
        const invoiceNumber = await InvoiceSequence.getNextNumber(tid, bid, invoicePrefix, session);

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

        // Process loyalty points redemption if tendered with loyalty_points
        const loyaltyPayment = normalizedPayments.find((p) => p.method === 'loyalty_points');
        if (loyaltyPayment && customerId) {
          const settings = await loyaltyService.calculateEarnedPoints(tid, 0); // trigger settings load
          const pointsToRedeem = Number(loyaltyPayment.reference || Math.round(loyaltyPayment.amountCents / 100));
          await loyaltyService.redeemPoints({
            tenantId: tid,
            branchId: bid,
            customerId,
            invoiceId: createdInvoice._id,
            pointsToRedeem,
            amountCents: loyaltyPayment.amountCents,
            session,
          });
        }

        // Accrue loyalty points on actual PAID amount (excluding unpaid credit and loyalty points redemption)
        const eligiblePaidCents = normalizedPayments
          .filter((p) => p.method !== 'credit' && p.method !== 'loyalty_points')
          .reduce((sum, p) => sum + p.amountCents, 0);

        if (customerId && eligiblePaidCents > 0) {
          await loyaltyService.accruePoints({
            tenantId: tid,
            branchId: bid,
            customerId,
            invoiceId: createdInvoice._id,
            paidAmountCents: eligiblePaidCents,
            type: 'earn',
            session,
          });
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

        // Post double-entry Ledger entry, built from the actual payments
        const totalCostCents = processedLines.reduce((acc, l) => acc + money.multiplyByQty(l.costPriceCents, l.qty), 0);
        await ledgerService.postSale({
          tenantId: tid,
          branchId: bid,
          saleId: invoiceNumber,
          totalCents: totals.grandTotalCents,
          payments: normalizedPayments,
          changeDueCents,
          receivableCents: Math.max(0, totals.grandTotalCents - totalPaidCents),
          tradeInValueCents: totals.tradeInValueCents,
          taxCents: totals.taxCents,
          costCents: totalCostCents,
          referenceType: isCreditSale ? 'credit_sale' : totals.tradeInValueCents > 0 ? 'trade_in' : 'sale',
          createdBy: userId,
          session,
        });

        // Drawer keeps the cash tendered minus the change handed back
        const cashKeptCents = cashTenderedCents - changeDueCents;
        if (cashKeptCents > 0) {
          await financeService.updateSessionCashSale({
            tenantId: tid,
            branchId: bid,
            amountCents: cashKeptCents,
            isRefund: false,
            session,
            userId,
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

    for (const a of audits) {
      await auditAdapter.record({ ...a, entity: 'Invoice', entityId: createdInvoice._id, tenantId: tid, userId });
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
    if (['returned', 'partially_returned'].includes(invoice.status)) {
      throw badRequest('This invoice has returns against it. Process a return instead of a void.', 'CANNOT_VOID_RETURNED');
    }
    const plan = invoice.installmentPlanId ? await InstallmentPlan.findById(invoice.installmentPlanId) : null;
    if (plan && plan.remainingBalanceCents < plan.financedAmountCents) {
      throw badRequest('Installments were already collected on this invoice. Process a return instead of a void.', 'CANNOT_VOID_COLLECTED');
    }
    const previousStatus = invoice.status;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 1. Restock sold items
      for (const line of invoice.lines) {
        await stockAdapter.restockReturn(tid, invoice.branchId, line.imei || line.barcode, line.qty, session);
      }

      // 2. Reverse every ledger entry posted for this invoice
      const entries = await LedgerEntry.find({ referenceId: invoice.invoiceNumber, isVoided: { $ne: true } }).session(session);
      for (const entry of entries) {
        await ledgerService.postVoidReversal({ tenantId: tid, originalEntryNumber: entry.entryNumber, reason, createdBy: userId, session });
      }

      // 3. Payments are kept for the record and marked voided
      const payments = await Payment.find({ invoiceId: invoice._id }).session(session).lean();
      await Payment.updateMany({ invoiceId: invoice._id }, { $set: { status: 'voided' } }, { session });

      // 4. Customer balance: the plan's financed amount, or the unpaid credit
      if (invoice.customerId) {
        const owed = plan
          ? plan.remainingBalanceCents
          : payments.some((p) => p.method === 'credit')
            ? Math.max(0, invoice.grandTotalCents - invoice.totalPaidCents)
            : 0;
        if (owed > 0) {
          await Customer.updateOne({ _id: invoice.customerId }, { $inc: { currentBalanceCents: -owed } }, { session });
        }
        await loyaltyService.reverseInvoicePoints({
          tenantId: tid,
          branchId: invoice.branchId,
          customerId: invoice.customerId,
          invoiceId: invoice._id,
          session,
        });
      }
      if (plan) {
        plan.status = 'cancelled';
        plan.remainingBalanceCents = 0;
        await plan.save({ session });
      }

      // 5. Cash kept in the drawer goes back out as a refund
      const cashKeptCents = payments.filter((p) => p.method === 'cash').reduce((sum, p) => sum + p.amountCents, 0) - invoice.changeDueCents;
      if (cashKeptCents > 0) {
        await financeService.updateSessionCashSale({ tenantId: tid, branchId: invoice.branchId, amountCents: cashKeptCents, isRefund: true, session, userId });
      }

      // 6. Update invoice status
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
      before: { status: previousStatus },
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
 * Background job: cleans expired held carts for every tenant that has any.
 */
export async function cleanAllExpiredHeldCarts() {
  const tenantIds = await runAsPlatform(async () => await HeldCart.distinct('tenantId', { expiresAt: { $lt: new Date() } }));
  let cleanedCount = 0;
  for (const tenantId of tenantIds) {
    cleanedCount += (await cleanExpiredHeldCarts({ tenantId })).cleanedCount;
  }
  return { cleanedCount };
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

    const branchDoc = branchId ? await Branch.findById(branchId).select('invoicePrefix').lean() : null;
    const quoteNumber = await InvoiceSequence.getNextNumber(tid, branchId, `QTE-${branchDoc?.invoicePrefix || 'INV-'}`);
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
  cleanAllExpiredHeldCarts,
  createQuotation,
  convertQuotationToInvoice,
  getInvoiceById,
};

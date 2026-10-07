import mongoose from 'mongoose';
import { formatRupees } from '../money.js';
import InstallmentPlan from '../models/InstallmentPlan.model.js';
import Customer from '../../customers/Customer.model.js';
import Invoice from '../models/Invoice.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound, AppError } from '../../../core/errors.js';
import { verifyApprovalPin } from '../adapters/approvalPin.adapter.js';
import * as ledgerService from './ledger.service.js';
import * as notificationsAdapter from '../adapters/notifications.adapter.js';
import * as auditAdapter from '../adapters/audit.adapter.js';
import * as loyaltyService from './loyalty.service.js';

/**
 * Generate unique plan sequence: IP-YYYYMMDD-XXXX
 */
function generatePlanNumber() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `IP-${dateStr}-${rand}`;
}

/**
 * Generates exact integer cent installment schedule.
 * Any remainder cents are added to the first installment.
 */
export function calculateSchedule({
  financedAmountCents,
  numberOfInstallments = 3,
  frequency = 'monthly',
  firstDueDate = null,
}) {
  const count = Number(numberOfInstallments);
  if (isNaN(count) || count < 1 || count > 36) {
    throw badRequest('Installments must be between 1 and 36', 'INVALID_INSTALLMENT_COUNT');
  }

  const financed = Math.round(Number(financedAmountCents));
  if (financed <= 0) {
    throw badRequest('Financed amount must be greater than zero', 'INVALID_FINANCED_AMOUNT');
  }

  const basePerInstallment = Math.floor(financed / count);
  const remainder = financed - basePerInstallment * count;

  const startDate = firstDueDate ? new Date(firstDueDate) : new Date();
  const schedule = [];

  for (let i = 0; i < count; i++) {
    const dueDate = new Date(startDate);
    if (frequency === 'weekly') {
      dueDate.setUTCDate(dueDate.getUTCDate() + i * 7);
    } else {
      // Monthly: increment calendar month in UTC
      dueDate.setUTCMonth(dueDate.getUTCMonth() + i);
    }

    const amountCents = i === 0 ? basePerInstallment + remainder : basePerInstallment;
    schedule.push({
      installmentNumber: i + 1,
      dueDate,
      amountCents,
      paidAmountCents: 0,
      status: 'pending',
      paidAt: null,
    });
  }

  return schedule;
}

/**
 * Checks customer credit limit and exposure.
 * Throws V-07 if exposure exceeds limit without valid manager approval PIN.
 */
export async function checkCreditEligibility({
  tenantId,
  customerId,
  requestedCreditCents = 0,
  managerPin = null,
  userId = null,
}) {
  if (!customerId) {
    throw badRequest('Credit sales and installments require a registered customer', 'CREDIT_REQUIRES_CUSTOMER');
  }

  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  return await runWithContext({ tenantId: tid }, async () => {
    const customer = await Customer.findById(customerId);
    if (!customer) throw notFound('Customer not found');

    const requested = Math.round(Number(requestedCreditCents || 0));
    const currentBalance = customer.currentBalanceCents || 0;
    const creditLimit = customer.creditLimitCents || 0;
    const totalExposure = currentBalance + requested;

    if (totalExposure > creditLimit) {
      const excess = totalExposure - creditLimit;

      // Check manager approval PIN
      const pinVerify = await verifyApprovalPin(tid, managerPin, userId);
      if (!pinVerify.approved) {
        throw new AppError(
          400,
          `${customer.name} would go over their credit limit by ${formatRupees(excess)}. Take a payment or ask a manager to approve.`,
          'V-07'
        );
      }

      return {
        eligible: true,
        approvedBy: pinVerify.approver?._id,
        customer,
        currentBalanceCents: currentBalance,
        creditLimitCents: creditLimit,
        totalExposureCents: totalExposure,
        overLimitByCents: excess,
      };
    }

    return {
      eligible: true,
      approvedBy: null,
      customer,
      currentBalanceCents: currentBalance,
      creditLimitCents: creditLimit,
      totalExposureCents: totalExposure,
      overLimitByCents: 0,
    };
  });
}

/**
 * Creates an InstallmentPlan for an invoice.
 */
export async function createInstallmentPlan({
  tenantId,
  branchId,
  invoiceId,
  invoiceNumber,
  customerId,
  customerSnapshot,
  totalAmountCents,
  downPaymentCents = 0,
  numberOfInstallments = 3,
  frequency = 'monthly',
  firstDueDate = null,
  userId = null,
  session = null,
}) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;

  const total = Math.round(Number(totalAmountCents));
  const down = Math.round(Number(downPaymentCents || 0));
  const financed = total - down;

  if (financed <= 0) {
    throw badRequest('Down payment covers entire amount; installment plan not required', 'NO_FINANCED_AMOUNT');
  }

  const schedule = calculateSchedule({
    financedAmountCents: financed,
    numberOfInstallments,
    frequency,
    firstDueDate,
  });

  const planNumber = generatePlanNumber();

  const plan = new InstallmentPlan({
    branchId: bid,
    planNumber,
    invoiceId,
    invoiceNumber,
    customerId,
    customerSnapshot: {
      name: customerSnapshot?.name || 'Customer',
      phone: customerSnapshot?.phone || '',
    },
    totalAmountCents: total,
    downPaymentCents: down,
    financedAmountCents: financed,
    remainingBalanceCents: financed,
    numberOfInstallments,
    frequency,
    schedule,
    status: 'active',
    createdBy: userId,
  });

  await plan.save({ session });

  // Update customer current balance
  const customer = await Customer.findById(customerId).session(session);
  if (customer) {
    customer.currentBalanceCents = (customer.currentBalanceCents || 0) + financed;
    await customer.save({ session });
  }

  return plan;
}

/**
 * Records customer collection payment applied oldest-due first across active installments.
 * Posts double-entry journal entry to ledger.
 */
export async function recordCustomerPayment({
  tenantId,
  branchId,
  customerId,
  amountCents,
  paymentMethod = 'cash',
  reference = '',
  receivedBy = null,
  session = null,
}) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;

  const paymentAmt = Math.round(Number(amountCents));
  if (isNaN(paymentAmt) || paymentAmt <= 0) {
    throw badRequest('Payment amount must be greater than zero', 'INVALID_PAYMENT_AMOUNT');
  }

  return await runWithContext({ tenantId: tid }, async () => {
    const customer = await Customer.findById(customerId);
    if (!customer) throw notFound('Customer not found');

    // Find all active installment plans for customer ordered by creation date
    const plans = await InstallmentPlan.find({
      customerId: customer._id,
      status: 'active',
    }).sort({ createdAt: 1 });

    let remainingToApply = paymentAmt;
    const updatedPlans = [];

    // Flatten all unpaid schedule items across plans with references
    const pendingInstallments = [];
    for (const plan of plans) {
      for (const item of plan.schedule) {
        if (item.status !== 'paid') {
          pendingInstallments.push({ plan, item });
        }
      }
    }

    // Sort by dueDate ascending (oldest-due first)
    pendingInstallments.sort((a, b) => new Date(a.item.dueDate) - new Date(b.item.dueDate));

    const modifiedPlansSet = new Set();

    for (const { plan, item } of pendingInstallments) {
      if (remainingToApply <= 0) break;

      const unpaidOnThis = item.amountCents - (item.paidAmountCents || 0);
      const apply = Math.min(remainingToApply, unpaidOnThis);

      item.paidAmountCents = (item.paidAmountCents || 0) + apply;
      if (item.paidAmountCents >= item.amountCents) {
        item.status = 'paid';
        item.paidAt = new Date();
      } else {
        item.status = 'partial';
      }

      plan.remainingBalanceCents = Math.max(0, plan.remainingBalanceCents - apply);
      remainingToApply -= apply;
      modifiedPlansSet.add(plan);
    }

    for (const plan of modifiedPlansSet) {
      const allPaid = plan.schedule.every((s) => s.status === 'paid');
      if (allPaid || plan.remainingBalanceCents === 0) {
        plan.status = 'completed';
      }
      await plan.save({ session });
      updatedPlans.push(plan);
    }

    // Update customer current balance
    const actualDeducted = paymentAmt - remainingToApply;
    customer.currentBalanceCents = Math.max(0, (customer.currentBalanceCents || 0) - actualDeducted);
    await customer.save({ session });

    // Post double-entry journal entry to ledger
    const paymentRef = reference || `COL-${Date.now()}`;
    await ledgerService.postInstallmentPayment({
      tenantId: tid,
      branchId: bid,
      paymentId: paymentRef,
      amountCents: actualDeducted,
      paymentMethod,
      createdBy: receivedBy,
      session,
    });

    // Accrue loyalty points for collected installment payment
    if (actualDeducted > 0) {
      await loyaltyService.accruePoints({
        tenantId: tid,
        branchId: bid,
        customerId: customer._id,
        paidAmountCents: actualDeducted,
        type: 'installment_earn',
        session,
      });
    }

    // Audit log
    await auditAdapter.record({
      action: 'pos.installment_payment',
      entity: 'InstallmentPlan',
      entityId: updatedPlans[0]?._id || customer._id,
      after: {
        customerId: customer._id,
        amountCents: actualDeducted,
        remainingToApply,
        paymentMethod,
        plansCount: updatedPlans.length,
      },
      tenantId: tid,
      userId: receivedBy,
    });

    return {
      success: true,
      amountPaidCents: actualDeducted,
      unallocatedCents: remainingToApply,
      customerBalanceCents: customer.currentBalanceCents,
      updatedPlansCount: updatedPlans.length,
    };
  });
}

/**
 * Calculates aging breakdown into Current, 1-30, 31-60, 61-90, 90+ days.
 */
export async function getCustomerAging({ tenantId, customerId }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  return await runWithContext({ tenantId: tid }, async () => {
    const customer = await Customer.findById(customerId).lean();
    if (!customer) throw notFound('Customer not found');

    const plans = await InstallmentPlan.find({
      customerId: customer._id,
      status: 'active',
    }).lean();

    const now = new Date();
    const buckets = {
      current: 0,
      '1-30': 0,
      '31-60': 0,
      '61-90': 0,
      '90+': 0,
      totalOutstandingCents: 0,
    };

    const overdueList = [];

    for (const plan of plans) {
      for (const item of plan.schedule) {
        if (item.status === 'paid') continue;

        const unpaid = item.amountCents - (item.paidAmountCents || 0);
        const due = new Date(item.dueDate);
        const diffMs = now - due;
        const daysOverdue = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        buckets.totalOutstandingCents += unpaid;

        if (daysOverdue <= 0) {
          buckets.current += unpaid;
        } else if (daysOverdue <= 30) {
          buckets['1-30'] += unpaid;
        } else if (daysOverdue <= 60) {
          buckets['31-60'] += unpaid;
        } else if (daysOverdue <= 90) {
          buckets['61-90'] += unpaid;
        } else {
          buckets['90+'] += unpaid;
        }

        if (daysOverdue > 0) {
          overdueList.push({
            planId: plan._id,
            planNumber: plan.planNumber,
            invoiceNumber: plan.invoiceNumber,
            installmentNumber: item.installmentNumber,
            dueDate: item.dueDate,
            daysOverdue,
            amountCents: item.amountCents,
            unpaidCents: unpaid,
          });
        }
      }
    }

    return {
      customer: {
        _id: customer._id,
        name: customer.name,
        phone: customer.phone,
        creditLimitCents: customer.creditLimitCents || 0,
        currentBalanceCents: customer.currentBalanceCents || 0,
      },
      buckets,
      overdueInstallments: overdueList.sort((a, b) => b.daysOverdue - a.daysOverdue),
    };
  });
}

/**
 * Returns all overdue installments across a branch/tenant.
 */
export async function getOverdueInstallments({ tenantId, branchId = null }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  return await runWithContext({ tenantId: tid }, async () => {
    const query = { status: 'active' };
    if (branchId) {
      query.branchId = branchId;
    }

    const plans = await InstallmentPlan.find(query).lean();
    const now = new Date();
    const list = [];

    for (const plan of plans) {
      for (const item of plan.schedule) {
        if (item.status === 'paid') continue;

        const due = new Date(item.dueDate);
        if (due < now) {
          const unpaid = item.amountCents - (item.paidAmountCents || 0);
          const daysOverdue = Math.floor((now - due) / (1000 * 60 * 60 * 24));

          list.push({
            planId: plan._id,
            planNumber: plan.planNumber,
            invoiceNumber: plan.invoiceNumber,
            customerId: plan.customerId,
            customerName: plan.customerSnapshot?.name || 'Customer',
            customerPhone: plan.customerSnapshot?.phone || '',
            installmentNumber: item.installmentNumber,
            dueDate: item.dueDate,
            daysOverdue,
            amountCents: item.amountCents,
            unpaidCents: unpaid,
          });
        }
      }
    }

    return list.sort((a, b) => b.daysOverdue - a.daysOverdue);
  });
}

/**
 * Dispatches an automated installment SMS reminder to a customer.
 */
export async function sendInstallmentReminder({ tenantId, installmentPlanId, installmentNumber }) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));

  return await runWithContext({ tenantId: tid }, async () => {
    const plan = await InstallmentPlan.findById(installmentPlanId);
    if (!plan) throw notFound('Installment plan not found');

    const item = plan.schedule.find((s) => s.installmentNumber === Number(installmentNumber));
    if (!item) throw notFound(`Installment #${installmentNumber} not found`);

    const customer = await Customer.findById(plan.customerId).lean();
    const phone = customer?.phone || plan.customerSnapshot?.phone;

    if (!phone) {
      throw badRequest('Customer phone number not available for SMS notification', 'NO_PHONE_NUMBER');
    }

    const unpaidCents = item.amountCents - (item.paidAmountCents || 0);
    const dateFormatted = new Date(item.dueDate).toISOString().slice(0, 10);

    const res = await notificationsAdapter.sendSms({
      to: phone,
      template: 'installment_reminder',
      data: {
        customerName: customer?.name || plan.customerSnapshot?.name,
        amountCents: unpaidCents,
        dueDate: dateFormatted,
        planNumber: plan.planNumber,
        installmentNumber: item.installmentNumber,
      },
    });

    return {
      success: true,
      messageId: res.messageId,
      sentTo: phone,
      amountCents: unpaidCents,
      dueDate: dateFormatted,
    };
  });
}

export default {
  calculateSchedule,
  checkCreditEligibility,
  createInstallmentPlan,
  recordCustomerPayment,
  getCustomerAging,
  getOverdueInstallments,
  sendInstallmentReminder,
};

// TEMP: needs Dev 3 approval
import * as ledgerService from '../../pos/services/ledger.service.js';
import { round, subtract, add } from '../../pos/money.js';
import { badRequest } from '../../../core/errors.js';

/**
 * Posts initial advance payment received at intake.
 * Dr Payment Account (1010/1020/1030)
 * Cr Store Credit Liability (2020)
 */
export async function postAdvanceDeposit({
  tenantId,
  branchId,
  ticketNo,
  amountCents,
  paymentMethod = 'cash',
  createdBy = null,
  session = null,
}) {
  const amt = round(amountCents);
  if (amt <= 0) return null;

  const methodAcc = ledgerService.accountForMethod(paymentMethod);
  const lines = [
    { accountCode: methodAcc, debit: amt, credit: 0, description: `Advance deposit via ${paymentMethod} for repair ${ticketNo}` },
    { accountCode: '2020', debit: 0, credit: amt, description: `Customer deposit liability for repair ${ticketNo}` },
  ];

  return await ledgerService.postJournal({
    tenantId,
    branchId,
    referenceType: 'manual',
    referenceId: ticketNo,
    description: `Repair advance deposit for ${ticketNo}`,
    lines,
    createdBy,
    session,
  });
}

/**
 * Posts repair invoice settlement.
 * Total = labour + sum(parts price).
 * Skips zero-value lines.
 *
 * Case A (due > 0):
 *   Dr Payment Account (total - advance)
 *   Dr Store Credit (advance)
 *   Cr Other Income (4020, total)
 *
 * Case B (due == 0, advance == total):
 *   Dr Store Credit (advance)
 *   Cr Other Income (4020, total)
 *
 * Case C (advance > total, excess refunded):
 *   Dr Store Credit (advance)
 *   Cr Other Income (4020, total)
 *   Cr Payment Account (advance - total, refund)
 */
export async function postRepairInvoice({
  tenantId,
  branchId,
  ticketNo,
  totalCents,
  advanceCents = 0,
  paymentMethod = 'cash',
  createdBy = null,
  session = null,
}) {
  const total = round(totalCents);
  const advance = round(advanceCents);
  if (total <= 0) {
    throw badRequest('Repair total must be greater than 0 to generate invoice');
  }

  const methodAcc = ledgerService.accountForMethod(paymentMethod);
  const lines = [];

  if (advance === 0) {
    // No advance: entire total paid via paymentMethod
    lines.push(
      { accountCode: methodAcc, debit: total, credit: 0, description: `Payment via ${paymentMethod} for repair ${ticketNo}` },
      { accountCode: '4020', debit: 0, credit: total, description: `Repair income for ${ticketNo}` }
    );
  } else if (advance < total) {
    // Case A: partial advance, balance paid now
    const balanceDue = subtract(total, advance);
    lines.push(
      { accountCode: methodAcc, debit: balanceDue, credit: 0, description: `Balance payment via ${paymentMethod} for repair ${ticketNo}` },
      { accountCode: '2020', debit: advance, credit: 0, description: `Deposit applied to repair ${ticketNo}` },
      { accountCode: '4020', debit: 0, credit: total, description: `Repair income for ${ticketNo}` }
    );
  } else if (advance === total) {
    // Case B: advance exactly covers total
    lines.push(
      { accountCode: '2020', debit: advance, credit: 0, description: `Deposit applied to repair ${ticketNo}` },
      { accountCode: '4020', debit: 0, credit: total, description: `Repair income for ${ticketNo}` }
    );
  } else {
    // Case C: advance exceeds total, excess refunded
    const refundExcess = subtract(advance, total);
    lines.push(
      { accountCode: '2020', debit: advance, credit: 0, description: `Deposit applied to repair ${ticketNo}` },
      { accountCode: '4020', debit: 0, credit: total, description: `Repair income for ${ticketNo}` },
      { accountCode: methodAcc, debit: 0, credit: refundExcess, description: `Excess deposit refund via ${paymentMethod} for repair ${ticketNo}` }
    );
  }

  return await ledgerService.postJournal({
    tenantId,
    branchId,
    referenceType: 'manual',
    referenceId: ticketNo,
    description: `Repair invoice for ${ticketNo}`,
    lines,
    createdBy,
    session,
  });
}

/**
 * Posts advance settlement upon ticket cancellation or unrepairable.
 *
 * Refund:
 *   Dr Store Credit (2020, advance)
 *   Cr Payment Account (advance)
 *
 * Keep fee:
 *   Dr Store Credit (2020, advance)
 *   Cr Other Income (4020, fee)
 *   Cr Payment Account (advance - fee, if any)
 */
export async function postAdvanceCancellation({
  tenantId,
  branchId,
  ticketNo,
  advanceCents,
  decision,
  feeCents = 0,
  paymentMethod = 'cash',
  createdBy = null,
  session = null,
}) {
  const advance = round(advanceCents);
  if (advance <= 0) return null;

  const methodAcc = ledgerService.accountForMethod(paymentMethod);
  const fee = round(feeCents || 0);

  if (fee > advance) {
    throw badRequest('Fee cannot exceed advance amount', 'FEE_EXCEEDS_ADVANCE');
  }

  const lines = [];

  if (decision === 'refund') {
    lines.push(
      { accountCode: '2020', debit: advance, credit: 0, description: `Deposit liability cleared for cancelled repair ${ticketNo}` },
      { accountCode: methodAcc, debit: 0, credit: advance, description: `Advance refund via ${paymentMethod} for cancelled repair ${ticketNo}` }
    );
  } else if (decision === 'keep_fee') {
    lines.push(
      { accountCode: '2020', debit: advance, credit: 0, description: `Deposit liability cleared for cancelled repair ${ticketNo}` }
    );
    if (fee > 0) {
      lines.push(
        { accountCode: '4020', debit: 0, credit: fee, description: `Inspection/cancellation fee retained for repair ${ticketNo}` }
      );
    }
    const refundRemaining = subtract(advance, fee);
    if (refundRemaining > 0) {
      lines.push(
        { accountCode: methodAcc, debit: 0, credit: refundRemaining, description: `Remaining deposit refund via ${paymentMethod} for repair ${ticketNo}` }
      );
    }
  } else {
    throw badRequest(`Unknown advance decision: ${decision}`);
  }

  return await ledgerService.postJournal({
    tenantId,
    branchId,
    referenceType: 'manual',
    referenceId: ticketNo,
    description: `Repair advance ${decision} for ${ticketNo}`,
    lines,
    createdBy,
    session,
  });
}

export default {
  postAdvanceDeposit,
  postRepairInvoice,
  postAdvanceCancellation,
};

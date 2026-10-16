// TEMP: needs Dev 3 approval
/**
 * Adapter to reassign customer references across Dev 3's POS collections during customer merge.
 * All updates run sequentially within the provided MongoDB session (MongoDB transactions require sequential operations on a single session).
 * Does NOT touch customerSnapshot on Invoice, does NOT touch LedgerEntry, and skips HeldCart.
 */
import Invoice from '../../pos/models/Invoice.model.js';
import CreditNote from '../../pos/models/CreditNote.model.js';
import InstallmentPlan from '../../pos/models/InstallmentPlan.model.js';
import LoyaltyTransaction from '../../pos/models/LoyaltyTransaction.model.js';
import Quotation from '../../pos/models/Quotation.model.js';
import Cheque from '../../pos/models/Cheque.model.js';

/**
 * Reassigns customerId from source customer to target customer across POS collections.
 *
 * @param {import('mongoose').Types.ObjectId|string} tenantId
 * @param {import('mongoose').Types.ObjectId|string} fromId Source customer ID
 * @param {import('mongoose').Types.ObjectId|string} toId Target customer ID
 * @param {import('mongoose').ClientSession} session MongoDB transaction session
 * @returns {Promise<{ invoicesMoved: number, creditNotesMoved: number, installmentPlansMoved: number, loyaltyMoved: number, quotationsMoved: number, chequesMoved: number }>}
 */
export async function reassignCustomerData(tenantId, fromId, toId, session) {
  // 1. Invoices (preserve customerSnapshot for historical fidelity)
  const inv = await Invoice.updateMany(
    { tenantId, customerId: fromId },
    { $set: { customerId: toId } },
    { session }
  );

  // 2. Credit notes / returns
  const cn = await CreditNote.updateMany(
    { tenantId, customerId: fromId },
    { $set: { customerId: toId } },
    { session }
  );

  // 3. Installment plans
  const ip = await InstallmentPlan.updateMany(
    { tenantId, customerId: fromId },
    { $set: { customerId: toId } },
    { session }
  );

  // 4. Loyalty transactions
  const lt = await LoyaltyTransaction.updateMany(
    { tenantId, customerId: fromId },
    { $set: { customerId: toId } },
    { session }
  );

  // 5. Quotations
  const quot = await Quotation.updateMany(
    { tenantId, customerId: fromId },
    { $set: { customerId: toId } },
    { session }
  );

  // 6. Cheques
  const chq = await Cheque.updateMany(
    { tenantId, customerId: fromId },
    { $set: { customerId: toId } },
    { session }
  );

  return {
    invoicesMoved: inv.modifiedCount || 0,
    creditNotesMoved: cn.modifiedCount || 0,
    installmentPlansMoved: ip.modifiedCount || 0,
    loyaltyMoved: lt.modifiedCount || 0,
    quotationsMoved: quot.modifiedCount || 0,
    chequesMoved: chq.modifiedCount || 0,
  };
}

export default { reassignCustomerData };

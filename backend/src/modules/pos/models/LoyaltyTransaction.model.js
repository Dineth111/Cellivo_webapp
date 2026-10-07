import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const loyaltyTransactionSchema = new mongoose.Schema(
  {
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PosInvoice',
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: ['earn', 'redeem', 'return_reversal', 'installment_earn', 'void_reversal'],
      required: true,
    },
    points: {
      type: Number,
      required: true,
    },
    amountCents: {
      type: Number,
      required: true,
      default: 0,
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    date: {
      type: Date,
      default: () => new Date(),
    },
  },
  { timestamps: true }
);

loyaltyTransactionSchema.plugin(tenantPlugin);
loyaltyTransactionSchema.index({ tenantId: 1, customerId: 1, date: -1 });

export default mongoose.models.LoyaltyTransaction || mongoose.model('LoyaltyTransaction', loyaltyTransactionSchema);

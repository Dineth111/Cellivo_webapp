import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const bankAccountSchema = new mongoose.Schema(
  {
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },
    accountName: {
      type: String,
      required: true,
      trim: true,
    },
    bankName: {
      type: String,
      required: true,
      trim: true,
    },
    accountNumber: {
      type: String,
      required: true,
      trim: true,
    },
    balanceCents: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

bankAccountSchema.plugin(tenantPlugin);
bankAccountSchema.index({ tenantId: 1, accountNumber: 1 }, { unique: true });

export default mongoose.models.BankAccount || mongoose.model('BankAccount', bankAccountSchema);

import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const ledgerAccountSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Account code is required'],
      trim: true,
    },
    name: {
      type: String,
      required: [true, 'Account name is required'],
      trim: true,
      maxlength: 100,
    },
    type: {
      type: String,
      enum: ['asset', 'liability', 'equity', 'revenue', 'expense'],
      required: [true, 'Account type is required'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

ledgerAccountSchema.plugin(tenantPlugin);
ledgerAccountSchema.index({ tenantId: 1, code: 1 }, { unique: true });

export default mongoose.models.LedgerAccount || mongoose.model('LedgerAccount', ledgerAccountSchema);

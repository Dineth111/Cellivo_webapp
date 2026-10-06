import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const ledgerLineSchema = new mongoose.Schema(
  {
    accountCode: { type: String, required: true, trim: true },
    accountName: { type: String, required: true, trim: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    description: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const ledgerEntrySchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    entryNumber: { type: String, required: true, trim: true },
    date: { type: Date, default: () => new Date(), required: true },
    referenceType: {
      type: String,
      enum: ['sale', 'payment', 'refund', 'credit_sale', 'installment', 'trade_in', 'void', 'manual'],
      required: true,
      index: true,
    },
    referenceId: { type: String, default: '', trim: true, index: true },
    description: { type: String, default: '', trim: true },
    lines: {
      type: [ledgerLineSchema],
      validate: [(v) => Array.isArray(v) && v.length >= 2, 'A ledger entry must have at least two lines'],
    },
    isVoided: { type: Boolean, default: false, index: true },
    voidReason: { type: String, default: null },
    voidedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

ledgerEntrySchema.plugin(tenantPlugin);
ledgerEntrySchema.index({ tenantId: 1, entryNumber: 1 }, { unique: true });
ledgerEntrySchema.index({ tenantId: 1, branchId: 1, date: -1 });

export default mongoose.models.LedgerEntry || mongoose.model('LedgerEntry', ledgerEntrySchema);

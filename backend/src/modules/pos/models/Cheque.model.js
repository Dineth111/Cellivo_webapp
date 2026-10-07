import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const chequeSchema = new mongoose.Schema(
  {
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },
    chequeNumber: {
      type: String,
      required: true,
      trim: true,
    },
    bankName: {
      type: String,
      required: true,
      trim: true,
    },
    amountCents: {
      type: Number,
      required: true,
      min: 1,
    },
    partyName: {
      type: String,
      required: true,
      trim: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
      index: true,
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PosInvoice',
      default: null,
      index: true,
    },
    maturityDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'deposited', 'cleared', 'bounced', 'cancelled'],
      default: 'pending',
      index: true,
    },
    bouncedReason: {
      type: String,
      default: null,
      trim: true,
    },
    clearedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

chequeSchema.plugin(tenantPlugin);
chequeSchema.index({ tenantId: 1, bankName: 1, chequeNumber: 1 }, { unique: true });
chequeSchema.index({ tenantId: 1, status: 1, maturityDate: 1 });

export default mongoose.models.Cheque || mongoose.model('Cheque', chequeSchema);

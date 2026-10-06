import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const expenseSchema = new mongoose.Schema(
  {
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
    },
    amountCents: {
      type: Number,
      required: true,
      min: 1,
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'bank'],
      default: 'cash',
    },
    bankAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BankAccount',
      default: null,
    },
    payee: {
      type: String,
      required: true,
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    receiptUrl: {
      type: String,
      default: null,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    date: {
      type: Date,
      default: () => new Date(),
    },
  },
  { timestamps: true }
);

expenseSchema.plugin(tenantPlugin);
expenseSchema.index({ tenantId: 1, branchId: 1, date: -1 });

export default mongoose.models.Expense || mongoose.model('Expense', expenseSchema);

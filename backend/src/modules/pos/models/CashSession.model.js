import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const cashMovementSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['cash_in', 'cash_out'],
      required: true,
    },
    amountCents: {
      type: Number,
      required: true,
      min: 1,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    time: {
      type: Date,
      default: () => new Date(),
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { _id: true }
);

const cashSessionSchema = new mongoose.Schema(
  {
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    terminalId: {
      type: String,
      default: 'terminal-1',
      trim: true,
    },
    status: {
      type: String,
      enum: ['open', 'closed', 'approved'],
      default: 'open',
      index: true,
    },
    openingFloatCents: {
      type: Number,
      required: true,
      min: 0,
    },
    openedAt: {
      type: Date,
      default: () => new Date(),
    },
    movements: {
      type: [cashMovementSchema],
      default: [],
    },
    cashSalesCents: {
      type: Number,
      default: 0,
      min: 0,
    },
    cashRefundsCents: {
      type: Number,
      default: 0,
      min: 0,
    },
    expectedCashCents: {
      type: Number,
      default: 0,
    },
    countedCashCents: {
      type: Number,
      default: null,
    },
    denominations: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    varianceCents: {
      type: Number,
      default: null,
    },
    requiresApproval: {
      type: Boolean,
      default: false,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    zReport: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

cashSessionSchema.plugin(tenantPlugin);
cashSessionSchema.index({ tenantId: 1, userId: 1, status: 1 });
cashSessionSchema.index({ tenantId: 1, branchId: 1, status: 1 });
cashSessionSchema.index({ tenantId: 1, openedAt: -1 });

export default mongoose.models.CashSession || mongoose.model('CashSession', cashSessionSchema);

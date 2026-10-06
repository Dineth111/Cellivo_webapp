import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const installmentItemSchema = new mongoose.Schema(
  {
    installmentNumber: { type: Number, required: true },
    dueDate: { type: Date, required: true },
    amountCents: { type: Number, required: true, min: 0 },
    paidAmountCents: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'partial', 'paid', 'overdue'],
      default: 'pending',
    },
    paidAt: { type: Date, default: null },
  },
  { _id: true }
);

const installmentPlanSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    planNumber: { type: String, required: true, trim: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'PosInvoice', required: true, index: true },
    invoiceNumber: { type: String, required: true, trim: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    customerSnapshot: {
      name: { type: String, default: 'Customer', trim: true },
      phone: { type: String, default: '', trim: true },
    },
    totalAmountCents: { type: Number, required: true, min: 0 },
    downPaymentCents: { type: Number, default: 0, min: 0 },
    financedAmountCents: { type: Number, required: true, min: 0 },
    remainingBalanceCents: { type: Number, required: true, min: 0 },
    numberOfInstallments: { type: Number, required: true, min: 1, max: 36 },
    frequency: {
      type: String,
      enum: ['weekly', 'monthly'],
      default: 'monthly',
    },
    schedule: {
      type: [installmentItemSchema],
      validate: [(v) => Array.isArray(v) && v.length > 0, 'Plan must contain at least one installment'],
    },
    status: {
      type: String,
      enum: ['active', 'completed', 'defaulted'],
      default: 'active',
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

installmentPlanSchema.plugin(tenantPlugin);
installmentPlanSchema.index({ tenantId: 1, planNumber: 1 }, { unique: true });
installmentPlanSchema.index({ tenantId: 1, customerId: 1, status: 1 });
installmentPlanSchema.index({ tenantId: 1, branchId: 1, 'schedule.dueDate': 1 });

export default mongoose.models.InstallmentPlan || mongoose.model('InstallmentPlan', installmentPlanSchema);

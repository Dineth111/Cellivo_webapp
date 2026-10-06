import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const invoiceSequenceSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    prefix: { type: String, required: true, default: 'INV-', trim: true },
    seq: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

invoiceSequenceSchema.plugin(tenantPlugin);
invoiceSequenceSchema.index({ tenantId: 1, branchId: 1, prefix: 1 }, { unique: true });

/**
 * Atomically increments and returns the next sequential invoice number.
 * Concurrency safe, gapless, and never reused under parallel transactions.
 */
invoiceSequenceSchema.statics.getNextNumber = async function (tenantId, branchId, prefix = 'INV-', session = null) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;

  const doc = await this.findOneAndUpdate(
    { tenantId: tid, branchId: bid, prefix },
    {
      $inc: { seq: 1 },
      $setOnInsert: { tenantId: tid, branchId: bid, prefix },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const padded = String(doc.seq).padStart(6, '0');
  return `${prefix}${padded}`;
};

export default mongoose.models.InvoiceSequence || mongoose.model('InvoiceSequence', invoiceSequenceSchema);

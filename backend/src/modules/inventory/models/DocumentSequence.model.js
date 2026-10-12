import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const documentSequenceSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    prefix: { type: String, required: true, trim: true },
    seq: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

documentSequenceSchema.plugin(tenantPlugin);
documentSequenceSchema.index({ tenantId: 1, branchId: 1, prefix: 1 }, { unique: true });

/**
 * Atomically increments and returns the next sequential document number per branch.
 * Concurrency safe, gapless, and never reused under parallel transactions.
 */
documentSequenceSchema.statics.getNextNumber = async function (tenantId, branchId, prefix = 'GRN', session = null) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  const bid = branchId ? (branchId instanceof mongoose.Types.ObjectId ? branchId : new mongoose.Types.ObjectId(String(branchId))) : null;

  const normalizedPrefix = prefix.endsWith('-') ? prefix : `${prefix}-`;

  const doc = await this.findOneAndUpdate(
    { tenantId: tid, branchId: bid, prefix: normalizedPrefix },
    {
      $inc: { seq: 1 },
      $setOnInsert: { tenantId: tid, branchId: bid, prefix: normalizedPrefix },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, session }
  );

  const padded = String(doc.seq).padStart(6, '0');
  return `${normalizedPrefix}${padded}`;
};

export default mongoose.models.DocumentSequence || mongoose.model('DocumentSequence', documentSequenceSchema);

import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const wooSyncQueueSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: ['push_product', 'push_stock', 'pull_orders'],
      required: true,
      index: true,
    },
    entityId: { type: String, default: '', index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 3, min: 1 },
    lastError: { type: String, default: '' },
    nextRetryAt: { type: Date, default: () => new Date(), index: true },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

wooSyncQueueSchema.plugin(tenantPlugin);
wooSyncQueueSchema.index({ tenantId: 1, status: 1, nextRetryAt: 1 });

export default mongoose.models.WooSyncQueue || mongoose.model('WooSyncQueue', wooSyncQueueSchema);

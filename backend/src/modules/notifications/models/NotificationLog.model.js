import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

export const NOTIFICATION_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'failed'];

const notificationLogSchema = new mongoose.Schema(
  {
    channel: { type: String, required: true, enum: ['sms', 'email', 'in_app'] },
    recipient: { type: String, required: true }, // masked for lists and logs
    payload: { type: mongoose.Schema.Types.Mixed, default: {}, select: false },
    template: { type: String, required: true },
    event: { type: String, default: '' },
    subject: { type: String, default: '' },
    body: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: NOTIFICATION_STATUSES, default: 'queued', index: true },
    lockedAt: { type: Date, default: null },
    creditsDeducted: { type: Number, default: 0 },
    partsCount: { type: Number, default: 1 },
    providerMessageId: { type: String, default: '' },
    errorReason: { type: String, default: '' },
    retryCount: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 3 },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    sentAt: { type: Date, default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  },
  { timestamps: true }
);

notificationLogSchema.plugin(tenantPlugin);
notificationLogSchema.index({ tenantId: 1, createdAt: -1 });
notificationLogSchema.index({ tenantId: 1, status: 1 });

export default mongoose.models.NotificationLog || mongoose.model('NotificationLog', notificationLogSchema);

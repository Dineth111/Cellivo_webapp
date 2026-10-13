import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const inAppNotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    level: { type: String, enum: ['info', 'warning', 'danger', 'success'], default: 'info' },
    link: { type: String, default: '' },
    readAt: { type: Date, default: null, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

inAppNotificationSchema.plugin(tenantPlugin);
inAppNotificationSchema.index({ tenantId: 1, userId: 1, readAt: 1, createdAt: -1 });

export default mongoose.models.InAppNotification || mongoose.model('InAppNotification', inAppNotificationSchema);

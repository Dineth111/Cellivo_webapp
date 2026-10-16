import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const notificationTemplateSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, trim: true },
    channel: { type: String, required: true, enum: ['sms', 'email', 'in_app'] },
    language: { type: String, default: 'en', enum: ['en', 'si', 'ta'] },
    subject: { type: String, trim: true, default: '' },
    body: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

notificationTemplateSchema.plugin(tenantPlugin);
notificationTemplateSchema.index({ tenantId: 1, event: 1, channel: 1, language: 1 }, { unique: true });

export default mongoose.models.NotificationTemplate || mongoose.model('NotificationTemplate', notificationTemplateSchema);

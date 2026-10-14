import mongoose from 'mongoose';
import tenantPlugin from '../../../core/tenantPlugin.js';

const wooSettingsSchema = new mongoose.Schema(
  {
    storeUrl: { type: String, trim: true, default: '' },
    consumerKey: { type: String, trim: true, default: '' },
    consumerSecret: { type: String, trim: true, default: '' },
    syncBranchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    autoSyncStock: { type: Boolean, default: true },
    autoPullOrders: { type: Boolean, default: true },
    isActive: { type: Boolean, default: false },
    lastSyncAt: { type: Date, default: null },
  },
  { timestamps: true }
);

wooSettingsSchema.plugin(tenantPlugin);

export default mongoose.models.WooSettings || mongoose.model('WooSettings', wooSettingsSchema);

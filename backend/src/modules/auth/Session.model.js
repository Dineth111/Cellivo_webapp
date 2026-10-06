import mongoose from 'mongoose';
import tenantPlugin from '../../core/tenantPlugin.js';

// SEC-08: server-side session; the access token only carries this session's id.
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    device: { type: String, default: '' },
    ip: { type: String, default: '' },
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    refreshTokenHash: { type: String, select: false, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
sessionSchema.plugin(tenantPlugin);

export default mongoose.models.Session || mongoose.model('Session', sessionSchema);

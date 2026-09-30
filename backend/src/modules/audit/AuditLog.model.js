import mongoose from 'mongoose';
import tenantPlugin from '../../core/tenantPlugin.js';

const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    action: { type: String, required: true, index: true }, // e.g. auth.login, user.create
    entity: { type: String, default: '' },
    entityId: { type: String, default: '' },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: '' },
    device: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// SEC-09: audit entries can never be edited or deleted through the model.
const block = () => {
  throw new Error('Audit log is append-only');
};
schema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'findOneAndDelete', 'deleteMany', 'bulkWrite'],
  block
);
schema.pre('updateOne', { document: true, query: false }, block);
schema.pre('deleteOne', block);
schema.pre('deleteOne', { document: true, query: false }, block);
schema.pre('save', function () {
  if (!this.isNew) block();
});

schema.plugin(tenantPlugin);
schema.index({ tenantId: 1, createdAt: -1 });
schema.index({ tenantId: 1, userId: 1, createdAt: -1 });

export default mongoose.models.AuditLog || mongoose.model('AuditLog', schema);

import mongoose from 'mongoose';

// Platform-level records managed from the admin dashboard (A-07 to A-16). Not tenant-scoped.
const { Schema } = mongoose;
const oid = (ref) => ({ type: Schema.Types.ObjectId, ref });
const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);
const T = { timestamps: true };

export const LEAD_STATUSES = ['new', 'contacted', 'demo_scheduled', 'demo_done', 'converted', 'lost'];

// WEB-05 / WEB-06 / A-09
export const Lead = model('Lead', new Schema({
  kind: { type: String, enum: ['contact', 'demo'], required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  shopName: { type: String, trim: true, maxlength: 100, default: '' },
  phone: { type: String, trim: true, maxlength: 30, default: '' },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 120 },
  message: { type: String, trim: true, maxlength: 2000, default: '' },
  preferredAt: { type: Date, default: null }, // demo bookings
  status: { type: String, enum: LEAD_STATUSES, default: 'new', index: true },
  assignee: { type: String, default: '' },
  followUpAt: { type: Date, default: null },
  notes: { type: String, default: '', maxlength: 4000 },
  tenantId: oid('Tenant'), // set when converted (A-09)
}, T));

// A-10
export const Affiliate = model('Affiliate', new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 30 },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, lowercase: true, trim: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  commissionPercent: { type: Number, default: 10, min: 0, max: 100 },
}, T));

export const Payout = model('Payout', new Schema({
  affiliateId: { ...oid('Affiliate'), required: true, index: true },
  amount: { type: Number, required: true, min: 0 }, // minor units
  currency: { type: String, enum: ['USD', 'LKR'], default: 'LKR' },
  note: { type: String, default: '' },
  paidAt: { type: Date, default: Date.now },
}, T));

// A-12. SLA: paid plans get a faster first response (priority support, SRS 2.3)
export const SupportTicket = model('SupportTicket', new Schema({
  tenantId: { ...oid('Tenant'), index: true },
  subject: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, default: '', maxlength: 5000 },
  source: { type: String, enum: ['support_centre', 'email', 'in_app'], default: 'in_app' },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  status: { type: String, enum: ['open', 'pending', 'resolved', 'closed'], default: 'open', index: true },
  assignee: { type: String, default: '' },
  slaDueAt: { type: Date, default: null },
  notes: [{ text: String, by: String, at: { type: Date, default: Date.now }, _id: false }],
}, T));

// A-13
export const Announcement = model('Announcement', new Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  body: { type: String, default: '', maxlength: 2000 },
  startsAt: { type: Date, default: Date.now },
  endsAt: { type: Date, default: null },
  plans: { type: [String], default: [] }, // empty = all plans
  countries: { type: [String], default: [] }, // empty = all countries
}, T));

// ADM-25: welcome, verification, trial ending, payment failed, receipt, suspension
export const EmailTemplate = model('EmailTemplate', new Schema({
  key: { type: String, required: true, unique: true },
  subject: { type: String, required: true, maxlength: 200 },
  body: { type: String, required: true, maxlength: 10000 },
}, T));

// A-11 CMS: blog posts, logos, testimonials, FAQs, legal pages (versioned), SEO meta, redirects
export const CMS_TYPES = ['blog', 'logo', 'testimonial', 'faq', 'legal', 'seo', 'redirect'];
export const CmsEntry = model('CmsEntry', new Schema({
  type: { type: String, enum: CMS_TYPES, required: true, index: true },
  slug: { type: String, trim: true, lowercase: true, maxlength: 120, default: '' },
  title: { type: String, trim: true, maxlength: 200, default: '' },
  body: { type: String, default: '', maxlength: 50000 },
  data: { type: Schema.Types.Mixed, default: {} }, // category, image url, rating, seo fields, redirect target ...
  status: { type: String, enum: ['draft', 'scheduled', 'published'], default: 'draft' },
  publishAt: { type: Date, default: null },
  versions: [{ title: String, body: String, at: { type: Date, default: Date.now }, _id: false }], // legal pages keep history (ADM-22)
}, T));

// A-16: shared phone brand/model catalogue tenants can import from
export const PhoneModel = model('PhoneModel', new Schema({
  brand: { type: String, required: true, trim: true, maxlength: 60 },
  name: { type: String, required: true, trim: true, maxlength: 100 }, // model name, e.g. "iPhone 15 Pro"
  variants: { type: [String], default: [] },
}, T));

// A-15: feature flags (global or per tenant) and maintenance windows
export const FeatureFlag = model('FeatureFlag', new Schema({
  key: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 60 },
  description: { type: String, default: '' },
  enabled: { type: Boolean, default: false }, // global
  tenantIds: [oid('Tenant')], // enabled for these shops even when the global switch is off (beta)
}, T));

export const Maintenance = model('Maintenance', new Schema({
  title: { type: String, required: true, maxlength: 120 },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  notice: { type: String, default: '', maxlength: 500 },
}, T));

// A-08: SMS credit packages
export const SmsPackage = model('SmsPackage', new Schema({
  name: { type: String, required: true, maxlength: 60 },
  credits: { type: Number, required: true, min: 1 },
  price: { USD: { type: Number, default: 0 }, LKR: { type: Number, default: 0 } },
  active: { type: Boolean, default: true },
}, T));

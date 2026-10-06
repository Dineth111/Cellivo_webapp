import express from 'express';
import rateLimit from 'express-rate-limit';
import { Lead, CmsEntry, Announcement } from '../growth/growth.models.js';
import { listPlans } from '../plans/plans.service.js';
import { protect } from '../../core/auth.js';
import { wrap, badRequest } from '../../core/errors.js';
import { str } from '../../core/validate.js';
import { config } from '../../core/config.js';

/** Public website hooks (WEB-03 to WEB-06, WEB-07, WEB-10) and tenant-facing announcements. */
const router = express.Router();
const limit = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.env === 'test' ? 1000 : 20, standardHeaders: true, legacyHeaders: false });

// GET /api/public/plans: pricing page. Prices come from the database, so a price change needs no deploy (A-05).
router.get('/plans', wrap(async (req, res) => {
  const plans = await listPlans({ visibleOnly: true });
  res.json({ success: true, data: plans.map(({ code, name, rank, prices, branchLimit, userLimit, features, trialDays }) => ({ code, name, rank, prices, branchLimit, userLimit, features, trialDays })) });
}));

const emailOk = (e) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e);

async function createLead(kind, b = {}) {
  const email = str(b.email)?.toLowerCase();
  if (!str(b.name) || !email || !emailOk(email)) throw badRequest('Name and a valid email are required');
  if (str(b.website)) return null; // honeypot field: real visitors never fill it
  let preferredAt = null;
  if (kind === 'demo') {
    preferredAt = b.preferredAt ? new Date(b.preferredAt) : null;
    if (!preferredAt || Number.isNaN(preferredAt.getTime()) || preferredAt < new Date()) throw badRequest('Choose a preferred date and time in the future');
  }
  const lead = await Lead.create({ kind, name: str(b.name), shopName: str(b.shopName) || '', phone: str(b.phone) || '', email, message: str(b.message) || '', preferredAt });
  // TODO(Dev 5): acknowledgement email to the visitor and "new lead" email to the sales team (FRS appendix A)
  if (config.env !== 'production') console.log(`[dev] new ${kind} lead: ${email}`);
  return lead;
}

// POST /api/public/contact { name, shopName?, phone?, email, message }   (WEB-05)
router.post('/contact', limit, wrap(async (req, res) => {
  await createLead('contact', req.body);
  res.status(201).json({ success: true, message: 'Thanks! We will get back to you shortly.' });
}));

// POST /api/public/demo { name, shopName?, phone?, email, preferredAt, message? }   (WEB-06)
router.post('/demo', limit, wrap(async (req, res) => {
  await createLead('demo', req.body);
  res.status(201).json({ success: true, message: 'Your demo request is booked. We will confirm the time by email.' });
}));

// GET /api/public/cms/:type: published website content (A-11, WEB-07, WEB-10)
router.get('/cms/:type', wrap(async (req, res) => {
  const now = new Date();
  const rows = await CmsEntry.find({ type: str(req.params.type), $or: [{ status: 'published' }, { status: 'scheduled', publishAt: { $lte: now } }] }).sort({ updatedAt: -1 }).limit(200).lean();
  res.json({ success: true, count: rows.length, data: rows.map(({ versions, ...r }) => r) });
}));

// GET /api/public/announcements (logged in): active announcements for this shop's plan and country (A-13)
router.get('/announcements', protect, wrap(async (req, res) => {
  const now = new Date();
  const rows = await Announcement.find({ startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }).sort({ startsAt: -1 }).lean();
  const data = rows.filter((a) => (!a.plans.length || a.plans.includes(req.tenant.planCode)) && (!a.countries.length || a.countries.includes(req.tenant.country)));
  res.json({ success: true, data });
}));

export default router;

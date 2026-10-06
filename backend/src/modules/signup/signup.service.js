import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Tenant from '../tenants/Tenant.model.js';
import User from '../users/User.model.js';
import { Coupon } from '../billing/billing.models.js';
import { Affiliate } from '../growth/growth.models.js';
import { provisionTenant } from '../tenants/provisioning.service.js';
import { createSession } from '../auth/session.service.js';
import { describeUser } from '../auth/auth.service.js';
import { getPlan } from '../plans/plans.service.js';
import { runAsPlatform, runWithContext } from '../../core/tenantContext.js';
import { hashPassword, passwordError, hashToken } from '../../core/password.js';
import { badRequest, conflict, AppError } from '../../core/errors.js';
import { config } from '../../core/config.js';
import audit from '../../core/audit.js';

/**
 * F-01 Registration and free trial (ACC-01 to ACC-04). No payment details are ever asked.
 *   start:  validate, check uniqueness, send a 6-digit code (valid 15 minutes)
 *   verify: check the code, then call provisionTenant() (Dev 1) and open the trial
 * The tenant, branch, roles and owner are created ONLY by provisionTenant().
 */
export const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;

const pendingSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true }, // validated sign-up fields incl. passwordHash
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL: mongo deletes the row after expiry
  },
  { timestamps: true }
);
export const PendingSignup = mongoose.models.PendingSignup || mongoose.model('PendingSignup', pendingSchema);

// Country decides default currency and time zone (FRS F-01). Add rows as markets open.
const COUNTRIES = {
  LK: { currency: 'LKR', timezone: 'Asia/Colombo' }, IN: { currency: 'USD', timezone: 'Asia/Kolkata' },
  AE: { currency: 'USD', timezone: 'Asia/Dubai' }, NG: { currency: 'USD', timezone: 'Africa/Lagos' },
  PK: { currency: 'USD', timezone: 'Asia/Karachi' }, BD: { currency: 'USD', timezone: 'Asia/Dhaka' },
  US: { currency: 'USD', timezone: 'America/New_York' }, GB: { currency: 'USD', timezone: 'Europe/London' },
};
export const SIGNUP_COUNTRIES = Object.keys(COUNTRIES);

const codeHash = (email, code) => hashToken(`${email}:${code}`);

/** A coupon or an affiliate code; must exist and be active (FRS F-01 field table). */
export async function resolveCode(raw) {
  const code = String(raw).trim().toUpperCase();
  const now = new Date();
  const coupon = await Coupon.findOne({ code, active: true });
  if (coupon && (!coupon.validFrom || coupon.validFrom <= now) && (!coupon.validTo || coupon.validTo >= now)) return { kind: 'coupon', code };
  const affiliate = await Affiliate.findOne({ code, status: 'approved' });
  if (affiliate) return { kind: 'affiliate', code };
  throw badRequest('This affiliate or coupon code is not valid', 'CODE_INVALID');
}

const emailOk = (e) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120;

export async function start(b = {}) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const name = s(b.name), shopName = s(b.shopName), email = s(b.email).toLowerCase(), phone = s(b.phone).replace(/[\s-]/g, '');
  const country = s(b.country).toUpperCase() || 'LK';
  if (name.length < 2 || name.length > 80) throw badRequest('Full name must be 2 to 80 characters', 'V-01');
  if (shopName.length < 2 || shopName.length > 100) throw badRequest('Shop name must be 2 to 100 characters', 'V-01');
  if (!emailOk(email)) throw badRequest('Enter a valid email address', 'V-01');
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw badRequest('Enter the mobile number with the country code, for example +94771234567', 'V-01');
  if (!COUNTRIES[country]) throw badRequest('Choose your country', 'V-01');
  const pw = passwordError(b.password);
  if (pw) throw badRequest(pw, 'V-01');
  if (b.acceptTerms !== true) throw badRequest('You must accept the Terms of Service and Privacy Policy', 'V-01');

  const plan = await getPlan(s(b.planCode) || 'starter'); // default Starter / monthly
  const term = s(b.term) || 'monthly';
  if (plan.contactSales) throw badRequest('The Unlimited plan is arranged with our sales team. Please contact sales.', 'CONTACT_SALES');
  if (!['monthly', 'yearly', 'lifetime'].includes(term)) throw badRequest('Choose monthly, yearly or lifetime billing');
  const promo = s(b.code) ? await resolveCode(b.code) : null;

  // one trial per email and phone number (FRS F-01 business rules)
  const [emailTaken, phoneTaken] = await Promise.all([
    runAsPlatform(async () => await User.exists({ email })),
    Tenant.exists({ phone }),
  ]);
  if (emailTaken) throw conflict('An account with this email already exists. Log in or reset your password.', 'EMAIL_TAKEN');
  if (phoneTaken) throw conflict('A free trial was already used with this mobile number. Log in, or contact support.', 'PHONE_TAKEN');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const data = {
    name, shopName, email, phone, country, passwordHash: await hashPassword(b.password),
    planCode: plan.code, term, code: promo, trialDays: plan.trialDays,
  };
  await PendingSignup.findOneAndUpdate(
    { email },
    { email, data, codeHash: codeHash(email, code), attempts: 0, expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) },
    { upsert: true }
  );
  // TODO(Dev 5): send the code by email through the notification service (template "verification", ADM-25).
  if (config.env !== 'production') console.log(`[dev] sign-up code for ${email}: ${code}`);
  return { email, expiresInMinutes: CODE_MINUTES, ...(config.env === 'test' && { devCode: code }) };
}

/** New code for a pending sign-up; the form data is kept. */
export async function resend(emailRaw) {
  const email = String(emailRaw || '').trim().toLowerCase();
  const pending = await PendingSignup.findOne({ email });
  if (!pending) throw badRequest('This sign-up has expired. Please start again.', 'SIGNUP_EXPIRED');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  pending.codeHash = codeHash(email, code);
  pending.attempts = 0;
  pending.expiresAt = new Date(Date.now() + CODE_MINUTES * 60_000);
  await pending.save();
  if (config.env !== 'production') console.log(`[dev] sign-up code for ${email}: ${code}`);
  return { email, expiresInMinutes: CODE_MINUTES, ...(config.env === 'test' && { devCode: code }) };
}

export async function verify(emailRaw, codeRaw, meta = {}) {
  const email = String(emailRaw || '').trim().toLowerCase();
  const pending = await PendingSignup.findOne({ email });
  if (!pending || pending.expiresAt < new Date()) throw badRequest('This code has expired. Request a new one.', 'CODE_EXPIRED');
  if (pending.attempts >= MAX_ATTEMPTS) throw new AppError(429, 'Too many wrong codes. Request a new one.', 'CODE_LOCKED');
  if (pending.codeHash !== codeHash(email, String(codeRaw || '').trim())) {
    await PendingSignup.updateOne({ _id: pending._id }, { $inc: { attempts: 1 } });
    throw badRequest('That code is not correct', 'CODE_WRONG');
  }
  // atomic: two parallel verifies cannot both create a shop
  const claimed = await PendingSignup.findOneAndDelete({ _id: pending._id });
  if (!claimed) throw badRequest('This code has already been used', 'CODE_USED');

  const d = pending.data;
  const plan = await getPlan(d.planCode);
  const geo = COUNTRIES[d.country];
  const { tenant, user } = await provisionTenant({
    ownerName: d.name, shopName: d.shopName, email: d.email, phone: d.phone, passwordHash: d.passwordHash, country: d.country,
    tenantExtra: {
      planCode: plan.code, billingTerm: d.term, billingCurrency: geo.currency, currency: geo.currency, timezone: geo.timezone,
      trialEndsAt: new Date(Date.now() + plan.trialDays * 864e5), // set by the platform admin per plan (ACC-04)
      phone: d.phone, ownerEmail: d.email, ownerName: d.name,
      ...(d.code?.kind === 'affiliate' && { affiliateCode: d.code.code }),
      ...(d.code?.kind === 'coupon' && { couponCode: d.code.code }),
    },
  });
  return runWithContext({ tenantId: tenant._id, userId: user._id, ip: meta.ip, device: meta.device }, async () => {
    const s = await createSession(user, meta);
    await audit.record({ action: 'tenant.signup', entity: 'Tenant', entityId: tenant._id, after: { plan: plan.code, term: d.term } });
    return { token: s.token, refreshToken: s.refreshToken, user: await describeUser(user) };
  });
}

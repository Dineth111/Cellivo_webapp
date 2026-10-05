import express from 'express';
import rateLimit from 'express-rate-limit';
import * as signup from './signup.service.js';
import { wrap, badRequest } from '../../core/errors.js';
import { config } from '../../core/config.js';

// Public routes: F-01 sign-up. Strictly rate limited because they send mail and hash passwords.
const router = express.Router();
router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: config.env === 'test' ? 1000 : 30, standardHeaders: true, legacyHeaders: false }));

const meta = (req) => ({ ip: req.ip, device: req.get('user-agent') || '' });

// POST /api/signup/start { name, shopName, email, phone, country, password, planCode?, term?, code?, acceptTerms }
router.post('/start', wrap(async (req, res) => {
  const out = await signup.start(req.body);
  res.status(202).json({ success: true, message: 'We sent a 6-digit code to your email. It is valid for 15 minutes.', data: out });
}));

// POST /api/signup/resend { email }
router.post('/resend', wrap(async (req, res) => {
  res.json({ success: true, message: 'A new code was sent.', data: await signup.resend(req.body?.email) });
}));

// POST /api/signup/verify { email, code } -> creates the shop, starts the trial, logs the owner in
router.post('/verify', wrap(async (req, res) => {
  if (!req.body?.email || !req.body?.code) throw badRequest('Enter the 6-digit code');
  const out = await signup.verify(req.body.email, req.body.code, meta(req));
  res.status(201).json({ success: true, message: 'Your account is ready. Your free trial has started.', ...out });
}));

// POST /api/signup/check-code { code }: live check of the optional affiliate or coupon field
router.post('/check-code', wrap(async (req, res) => {
  res.json({ success: true, data: await signup.resolveCode(req.body?.code || '') });
}));

export default router;

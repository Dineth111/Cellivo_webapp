import mongoose from 'mongoose';
import RepairTicket from './models/RepairTicket.model.js';
import Customer from '../customers/Customer.model.js';
import Tenant from '../tenants/Tenant.model.js';
import { runAsPlatform } from '../../core/tenantContext.js';
import { checkRateLimit, safeCompare, hashString } from './utils/rateLimiter.js';
import { config } from '../../core/config.js';

/**
 * Public repair status check endpoint.
 * GET/POST /api/public/repairs/status
 * Supports tracking via:
 * 1. Unguessable token (>= 128-bit crypto random)
 * 2. Ticket number + last 4 digits of customer phone
 */
export async function getPublicRepairStatus(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const isTest = config.env === 'test';
  const rateLimitMax = req.headers['x-test-rate-limit']
    ? parseInt(req.headers['x-test-rate-limit'], 10)
    : (isTest ? 1000 : 10);
  const rateLimitWindowMs = 15 * 60 * 1000;

  // 1. IP-level rate limiting
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
  const ipKey = `ip:${clientIp}`;
  const ipCheck = await checkRateLimit(ipKey, rateLimitMax, rateLimitWindowMs);
  if (!ipCheck.allowed) {
    res.setHeader('Retry-After', '900');
    return res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests from this IP. Please try again later.',
    });
  }

  // Extract query or body params
  const params = req.method === 'POST' ? req.body || {} : req.query || {};
  const { token, ticketNo, phoneLast4 } = params;

  let matchedTicket = null;

  if (token && typeof token === 'string' && token.trim()) {
    const rawToken = token.trim();
    // Rate limit per token hash (never log or store token in plaintext)
    const tokenRateKey = `token:${hashString(rawToken)}`;
    const tokenCheck = await checkRateLimit(tokenRateKey, rateLimitMax, rateLimitWindowMs);
    if (!tokenCheck.allowed) {
      res.setHeader('Retry-After', '900');
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      });
    }

    const ticket = await runAsPlatform(async () =>
      RepairTicket.findOne({ trackingToken: rawToken })
    );

    if (!ticket) {
      // Constant-time dummy comparison for missing ticket
      safeCompare(rawToken, 'cellivo_constant_time_dummy_salt_2026');
      return res.status(404).json({
        error: 'TICKET_NOT_FOUND',
        message: 'Ticket not found or details do not match',
      });
    }

    const isMatch = safeCompare(rawToken, ticket.trackingToken);
    if (!isMatch) {
      return res.status(404).json({
        error: 'TICKET_NOT_FOUND',
        message: 'Ticket not found or details do not match',
      });
    }

    matchedTicket = ticket;
  } else if (ticketNo && phoneLast4 !== undefined) {
    const cleanTicketNo = String(ticketNo || '').trim().toUpperCase();
    const cleanDigits = String(phoneLast4 || '').replace(/\D/g, '');

    if (!cleanTicketNo || cleanDigits.length < 4) {
      return res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'Ticket number and last 4 digits of customer phone are required',
      });
    }

    // Rate limit per ticket number
    const ticketRateKey = `ticket:${cleanTicketNo}`;
    const ticketCheck = await checkRateLimit(ticketRateKey, rateLimitMax, rateLimitWindowMs);
    if (!ticketCheck.allowed) {
      res.setHeader('Retry-After', '900');
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests for this ticket. Please try again later.',
      });
    }

    const tickets = await runAsPlatform(async () =>
      RepairTicket.find({ ticketNo: cleanTicketNo }).populate('customerId')
    );

    if (!tickets || tickets.length === 0) {
      // Dummy DB lookup and timing-safe compare to ensure uniform response timing
      await runAsPlatform(async () => Customer.findOne({ _id: new mongoose.Types.ObjectId() }));
      safeCompare(cleanDigits.slice(-4), '9999');
      return res.status(404).json({
        error: 'TICKET_NOT_FOUND',
        message: 'Ticket not found or details do not match',
      });
    }

    for (const t of tickets) {
      const custDigits = String(t.customerId?.phone || '').replace(/\D/g, '');
      const custLast4 = custDigits.slice(-4);
      if (custLast4 && safeCompare(cleanDigits.slice(-4), custLast4)) {
        matchedTicket = t;
        break;
      }
    }

    if (!matchedTicket) {
      // Wrong phone suffix: perform dummy comparison and return exact same 404 response
      safeCompare(cleanDigits.slice(-4), '9999');
      return res.status(404).json({
        error: 'TICKET_NOT_FOUND',
        message: 'Ticket not found or details do not match',
      });
    }
  } else {
    return res.status(400).json({
      error: 'INVALID_INPUT',
      message: 'Please provide either a tracking token or ticket number with last 4 digits of phone',
    });
  }

  // Resolve tenant and verify active status
  const tenant = await runAsPlatform(async () => Tenant.findById(matchedTicket.tenantId));
  if (!tenant) {
    return res.status(404).json({
      error: 'TICKET_NOT_FOUND',
      message: 'Ticket not found or details do not match',
    });
  }

  if (['cancelled', 'archived'].includes(tenant.status)) {
    return res.status(403).json({
      error: 'SHOP_INACTIVE',
      message: 'This repair shop is currently inactive',
    });
  }

  // Calculate financials for ready / delivered states
  const partsTotalCents = (matchedTicket.parts || []).reduce(
    (sum, p) => sum + (p.qty || 1) * (p.unitPriceCents || 0),
    0
  );
  const calculatedTotal = (matchedTicket.labourCents || 0) + partsTotalCents;
  const totalCents = matchedTicket.isInvoiceSettled
    ? (matchedTicket.invoiceTotalCents || 0)
    : (calculatedTotal > 0 ? calculatedTotal : (matchedTicket.estimateCents || 0));
  const balanceCents = Math.max(0, totalCents - (matchedTicket.advanceCents || 0));

  const isReadyOrDelivered = ['Ready', 'Delivered'].includes(matchedTicket.stage);

  const timeline = (matchedTicket.history && matchedTicket.history.length > 0)
    ? matchedTicket.history.map((h) => ({ stage: h.to, date: h.at }))
    : [{ stage: matchedTicket.stage || 'Received', date: matchedTicket.createdAt }];

  // Return strictly whitelisted fields
  return res.json({
    data: {
      shopName: tenant.name,
      ticketNo: matchedTicket.ticketNo,
      device: {
        brand: matchedTicket.device?.brand || '',
        model: matchedTicket.device?.model || '',
      },
      stage: matchedTicket.stage,
      timeline,
      estimatedCompletion: matchedTicket.promisedDate || null,
      amountDue: isReadyOrDelivered
        ? {
            totalCents,
            balanceCents,
          }
        : null,
    },
  });
}

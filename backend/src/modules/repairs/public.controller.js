import mongoose from 'mongoose';
import RepairTicket from './models/RepairTicket.model.js';
import Customer from '../customers/Customer.model.js';
import Tenant from '../tenants/Tenant.model.js';
import { runAsPlatform, runWithContext } from '../../core/tenantContext.js';
import {
  checkRateLimit,
  isRateLimited,
  recordFailedAttempt,
  safeCompare,
  getRateLimits,
} from './utils/rateLimiter.js';
import { escapeRegex } from '../../core/validate.js';

/**
 * Public repair status check endpoint.
 * GET/POST /api/public/repairs/status
 * Supports tracking via:
 * 1. Unguessable token (>= 128-bit crypto random)
 * 2. Public tracking code (short random unique) + last 4 digits of phone
 * 3. Ticket number + shop code + last 4 digits of phone
 */
export async function getPublicRepairStatus(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const limits = getRateLimits();

  // 1. Per-IP rate limiting: 60 per 15 min for all requests
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
  const ipKey = `ip:${clientIp}`;
  const ipCheck = await checkRateLimit(ipKey, limits.ipLimit, limits.windowMs);
  if (!ipCheck.allowed) {
    res.setHeader('Retry-After', '900');
    return res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests from this IP. Please try again later.',
    });
  }

  // Extract query or body params
  const params = req.method === 'POST' ? req.body || {} : req.query || {};
  const { token, ticketNo, publicCode, code, phoneLast4, shopCode, shop } = params;

  let matchedTicket = null;

  // Track by 192-bit token (no per-token rate limiter)
  if (token && typeof token === 'string' && token.trim()) {
    const rawToken = token.trim();

    const ticket = await runAsPlatform(async () =>
      RepairTicket.findOne({ trackingToken: rawToken })
    );

    if (!ticket) {
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
  } else if ((ticketNo || publicCode || code) && phoneLast4 !== undefined) {
    const rawCode = String(publicCode || code || ticketNo || '').trim().toUpperCase();
    const cleanDigits = String(phoneLast4 || '').replace(/\D/g, '');
    const cleanShopCode = String(shopCode || shop || '').trim();

    if (!rawCode || cleanDigits.length < 4) {
      return res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'Ticket number or tracking code and last 4 digits of customer phone are required',
      });
    }

    // Determine candidate ticket
    let candidateTicket = null;
    let failedKey = null;

    // Check if rawCode matches an unambiguous publicCode
    const codeMatch = await runAsPlatform(async () =>
      RepairTicket.findOne({ publicCode: rawCode }).populate('customerId')
    );

    if (codeMatch) {
      candidateTicket = codeMatch;
      failedKey = `failed:${codeMatch.tenantId}:${codeMatch.publicCode}`;
    } else if (cleanShopCode) {
      // Resolve tenant first by shop code/name
      const tenant = await runAsPlatform(async () =>
        Tenant.findOne({ name: new RegExp('^' + escapeRegex(cleanShopCode) + '$', 'i') })
      );

      if (tenant) {
        failedKey = `failed:${tenant._id}:${rawCode}`;
        candidateTicket = await runWithContext({ tenantId: tenant._id }, async () =>
          RepairTicket.findOne({ ticketNo: rawCode }).populate('customerId')
        );
      } else {
        failedKey = `failed:unknown_shop:${rawCode}`;
      }
    } else {
      // If only ticketNo is passed without shopCode or matching publicCode, resolve unique ticket if unambiguous
      const tickets = await runAsPlatform(async () =>
        RepairTicket.find({ ticketNo: rawCode }).populate('customerId')
      );
      if (tickets.length === 1) {
        candidateTicket = tickets[0];
        failedKey = `failed:${candidateTicket.tenantId}:${rawCode}`;
      } else if (tickets.length > 1) {
        return res.status(400).json({
          error: 'SHOP_CODE_REQUIRED',
          message: 'Multiple shops have this ticket number. Please specify your shop name or use your unique tracking code.',
        });
      } else {
        failedKey = `failed:unknown:${rawCode}`;
      }
    }

    // Check if this tenant + ticket has already reached 10 failed attempts
    if (failedKey) {
      const isLocked = await isRateLimited(failedKey, limits.failedAttemptLimit);
      if (isLocked) {
        res.setHeader('Retry-After', '900');
        return res.status(429).json({
          error: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many failed lookup attempts for this ticket. Please try again later.',
        });
      }
    }

    if (!candidateTicket) {
      // Unknown ticket: record failed attempt, run dummy compare, return uniform 404
      if (failedKey) {
        const failRecord = await recordFailedAttempt(failedKey, limits.failedAttemptLimit, limits.windowMs);
        if (!failRecord.allowed) {
          res.setHeader('Retry-After', '900');
          return res.status(429).json({
            error: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many failed lookup attempts for this ticket. Please try again later.',
          });
        }
      }
      await runAsPlatform(async () => Customer.findOne({ _id: new mongoose.Types.ObjectId() }));
      safeCompare(cleanDigits.slice(-4), '9999');
      return res.status(404).json({
        error: 'TICKET_NOT_FOUND',
        message: 'Ticket not found or details do not match',
      });
    }

    // Verify customer phone last 4 digits
    const custDigits = String(candidateTicket.customerId?.phone || '').replace(/\D/g, '');
    const custLast4 = custDigits.slice(-4);
    const isPhoneMatch = custLast4 && safeCompare(cleanDigits.slice(-4), custLast4);

    if (!isPhoneMatch) {
      // Wrong digits: record failed attempt, run dummy compare, return uniform 404
      if (failedKey) {
        const failRecord = await recordFailedAttempt(failedKey, limits.failedAttemptLimit, limits.windowMs);
        if (!failRecord.allowed) {
          res.setHeader('Retry-After', '900');
          return res.status(429).json({
            error: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many failed lookup attempts for this ticket. Please try again later.',
          });
        }
      }
      safeCompare(cleanDigits.slice(-4), '9999');
      return res.status(404).json({
        error: 'TICKET_NOT_FOUND',
        message: 'Ticket not found or details do not match',
      });
    }

    // Successful manual lookup: do NOT increment failed attempts!
    matchedTicket = candidateTicket;
  } else {
    return res.status(400).json({
      error: 'INVALID_INPUT',
      message: 'Please provide either a tracking token or tracking code / ticket number with last 4 digits of phone',
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

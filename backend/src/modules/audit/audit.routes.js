import express from 'express';
import AuditLog from './AuditLog.model.js';
import { protect } from '../../core/auth.js';
import { requireOwner } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';
import { subscriptionGuard } from '../plans/planLimits.js';
import { str, isId, pageParams } from '../../core/validate.js';

const router = express.Router();
router.use(protect, subscriptionGuard, requireOwner);

// GET /api/audit?user=&action=&from=&to=&page=&limit=
router.get(
  '/',
  wrap(async (req, res) => {
    const filter = {};
    if (isId(req.query.user)) filter.userId = req.query.user;
    if (str(req.query.action)) filter.action = str(req.query.action);
    const from = new Date(req.query.from);
    const to = new Date(req.query.to);
    if (!isNaN(from) || !isNaN(to)) filter.createdAt = { ...(!isNaN(from) && { $gte: from }), ...(!isNaN(to) && { $lte: to }) };
    const { page, limit, skip } = pageParams(req.query);
    const [data, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      AuditLog.countDocuments(filter),
    ]);
    res.json({ success: true, page, limit, total, data });
  })
);

export default router;

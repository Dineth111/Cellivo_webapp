import express from 'express';
import rateLimit from 'express-rate-limit';
import * as c from './users.controller.js';
import { protect } from '../../core/auth.js';
import { requirePermission } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';
import { subscriptionGuard } from '../plans/planLimits.js';
import { config } from '../../core/config.js';

const router = express.Router();
router.use(protect, subscriptionGuard);

// any signed-in user may ask for approval; rate limited like /api/auth
const pinLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.authRateLimitMax, standardHeaders: true, legacyHeaders: false });
router.post('/verify-pin', pinLimit, wrap(c.verifyPin));

router.get('/', requirePermission('staff.view'), wrap(c.list));
router.post('/', requirePermission('staff.create'), wrap(c.create));
router.get('/:id', requirePermission('staff.view'), wrap(c.get));
router.put('/:id', requirePermission('staff.edit'), wrap(c.update));
router.post('/:id/deactivate', requirePermission('staff.edit'), wrap(c.deactivate));
router.post('/:id/activate', requirePermission('staff.edit'), wrap(c.activate));

export default router;

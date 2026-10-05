import express from 'express';
import * as c from './roles.controller.js';
import { protect } from '../../core/auth.js';
import { requireOwner } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';
import { subscriptionGuard } from '../plans/planLimits.js';

const router = express.Router();
router.use(protect, subscriptionGuard, requireOwner); // roles are owner-only (FRS F-04)

router.route('/').get(wrap(c.list)).post(wrap(c.create));
router.route('/:id').get(wrap(c.get)).put(wrap(c.update)).delete(wrap(c.remove));

export default router;

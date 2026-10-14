import express from 'express';
import * as c from './repairs.controller.js';
import { protect } from '../../core/auth.js';
import { requirePermission } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';
import { subscriptionGuard, requireFeature } from '../plans/planLimits.js';

const router = express.Router();

// All repairs routes require authentication, subscription guard, and the 'repairs' plan feature
router.use(protect, subscriptionGuard, requireFeature('repairs'));

// 1. Static/collection sub-routes (declared before /:id)
router.get('/config', requirePermission('repairs.view'), wrap(c.config));
router.get('/board', requirePermission('repairs.view'), wrap(c.board));
router.get('/overdue', requirePermission('repairs.view'), wrap(c.overdue));
router.get('/technicians/workload', requirePermission('repairs.view'), wrap(c.techniciansWorkload));
router.get('/parts/search', requirePermission('repairs.edit'), wrap(c.searchParts));

// 2. Ticket ID routes
router.get('/:id/jobcard', requirePermission('repairs.view'), wrap(c.jobCard));
router.post('/:id/stage', requirePermission('repairs.edit'), wrap(c.stage));
router.post('/:id/assign', requirePermission('repairs.edit'), wrap(c.assign));
router.post('/:id/approval', requirePermission('repairs.edit'), wrap(c.approval));
router.post('/:id/parts', requirePermission('repairs.edit'), wrap(c.addPart));
router.delete('/:id/parts/:partId', requirePermission('repairs.edit'), wrap(c.removePart));
router.post('/:id/invoice', requirePermission('repairs.approve'), wrap(c.invoice));
router.post('/:id/warranty', requirePermission('repairs.edit'), wrap(c.warranty));
router.get('/:id', requirePermission('repairs.view'), wrap(c.getOne));
router.put('/:id', requirePermission('repairs.edit'), wrap(c.update));

// 3. Collection root routes
router.get('/', requirePermission('repairs.view'), wrap(c.list));
router.post('/', requirePermission('repairs.create'), wrap(c.create));

export default router;

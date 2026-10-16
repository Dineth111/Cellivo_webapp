import express from 'express';
import { protect } from '../../core/auth.js';
import { requirePermission } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';
import { subscriptionGuard } from '../plans/planLimits.js';
import * as ctrl from './notifications.controller.js';

const router = express.Router();

router.use(protect);
router.use(subscriptionGuard);

// In-app notifications for authenticated user
router.get('/in-app', wrap(ctrl.getInAppList));
router.patch('/in-app/:id/read', wrap(ctrl.markInAppRead));
router.post('/in-app/read-all', wrap(ctrl.markAllInAppRead));

// Templates management (under settings)
router.get('/templates', requirePermission('settings.view'), wrap(ctrl.listTemplates));
router.put('/templates/:event/:channel', requirePermission('settings.edit'), wrap(ctrl.saveTemplate));

// Delivery logs and resend
router.get('/logs', requirePermission('settings.view'), wrap(ctrl.listLogs));
router.post('/logs/:id/resend', requirePermission('settings.edit'), wrap(ctrl.resendLog));

export default router;

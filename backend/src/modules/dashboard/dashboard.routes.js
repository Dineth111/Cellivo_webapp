import express from 'express';
import { wrap } from '../../core/errors.js';
import { protect } from '../../core/auth.js';
import { requirePermission } from '../../core/permissions.js';
import { getDashboard } from './dashboard.controller.js';

const router = express.Router();

router.use(protect);
router.get('/', requirePermission('dashboard.view'), wrap(getDashboard));

export default router;

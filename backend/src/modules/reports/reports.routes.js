import express from 'express';
import { protect } from '../../core/auth.js';
import { requirePermission, requireSpecial } from '../../core/permissions.js';
import * as controller from './reports.controller.js';

const router = express.Router();

router.use(protect);
router.use(requirePermission('reports.view'));

// JSON report endpoints
router.get('/sales', controller.getSalesReport);
router.get('/inventory', controller.getInventoryReport);
router.get('/repairs', controller.getRepairsReport);
router.get('/receivables', controller.getReceivablesReport);

// CSV export endpoints (requires export_reports special permission)
router.get('/:type/export', requireSpecial('export_reports'), controller.exportReportCsv);

export default router;

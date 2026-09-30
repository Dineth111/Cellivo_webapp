import express from 'express';
import * as c from './users.controller.js';
import { protect } from '../../core/auth.js';
import { requirePermission } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';

const router = express.Router();
router.use(protect);

router.get('/', requirePermission('staff.view'), wrap(c.list));
router.post('/', requirePermission('staff.create'), wrap(c.create));
router.get('/:id', requirePermission('staff.view'), wrap(c.get));
router.put('/:id', requirePermission('staff.edit'), wrap(c.update));
router.post('/:id/deactivate', requirePermission('staff.edit'), wrap(c.deactivate));
router.post('/:id/activate', requirePermission('staff.edit'), wrap(c.activate));

export default router;

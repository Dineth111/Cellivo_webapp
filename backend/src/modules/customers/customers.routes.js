import express from 'express';
import * as c from './customers.controller.js';
import { protect } from '../../core/auth.js';
import { requirePermission } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';
import { subscriptionGuard } from '../plans/planLimits.js';

const router = express.Router();
router.use(protect, subscriptionGuard);

router.get('/', requirePermission('customers.view'), wrap(c.getCustomers));
router.post('/', requirePermission('customers.create'), wrap(c.createCustomer));
router.get('/:id', requirePermission('customers.view'), wrap(c.getCustomerById));
router.put('/:id', requirePermission('customers.edit'), wrap(c.updateCustomer));
router.delete('/:id', requirePermission('customers.delete'), wrap(c.deleteCustomer));

export default router;

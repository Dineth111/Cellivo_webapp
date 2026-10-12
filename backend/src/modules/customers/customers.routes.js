import express from 'express';
import * as c from './customers.controller.js';
import { protect } from '../../core/auth.js';
import { requirePermission, requireOwner } from '../../core/permissions.js';
import { wrap } from '../../core/errors.js';
import { subscriptionGuard } from '../plans/planLimits.js';

const router = express.Router();
router.use(protect, subscriptionGuard);

// 1. Specific collection-level routes (MUST be declared before /:id)
router.get('/loyalty-settings', requirePermission('customers.view'), wrap(c.getLoyaltySettingsController));
router.put('/loyalty-settings', requirePermission('customers.edit'), wrap(c.updateLoyaltySettingsController));
router.get('/duplicates', requirePermission('customers.view'), wrap(c.getDuplicates));
router.post(
  '/import',
  requirePermission('customers.create'),
  express.text({ type: 'text/csv', limit: '2mb' }),
  wrap(c.importCustomers)
);

// 2. Customer ID routes
router.post('/:id/merge', requireOwner, wrap(c.mergeCustomers));
router.get('/:id/history', requirePermission('customers.view'), wrap(c.getCustomerHistory));
router.get('/:id', requirePermission('customers.view'), wrap(c.getCustomerById));
router.put('/:id', requirePermission('customers.edit'), wrap(c.updateCustomer));
router.delete('/:id', requirePermission('customers.delete'), wrap(c.deleteCustomer));

// 3. Collection root routes
router.get('/', requirePermission('customers.view'), wrap(c.getCustomers));
router.post('/', requirePermission('customers.create'), wrap(c.createCustomer));

export default router;

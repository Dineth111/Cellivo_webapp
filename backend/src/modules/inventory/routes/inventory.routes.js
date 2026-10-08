import express from 'express';
import { protect } from '../../../core/auth.js';
import { subscriptionGuard } from '../../plans/planLimits.js';
import { requirePermission } from '../../../core/permissions.js';
import { wrap } from '../../../core/errors.js';
import * as ctrl from '../controllers/inventory.controller.js';

const router = express.Router();

// All inventory routes require auth & active subscription
router.use(protect, subscriptionGuard);

// Categories
router.get('/categories', requirePermission('inventory.view'), wrap(ctrl.listCategories));
router.post('/categories', requirePermission('inventory.create'), wrap(ctrl.createCategory));
router.get('/categories/:id', requirePermission('inventory.view'), wrap(ctrl.getCategory));
router.put('/categories/:id', requirePermission('inventory.edit'), wrap(ctrl.updateCategory));
router.delete('/categories/:id', requirePermission('inventory.delete'), wrap(ctrl.archiveCategory));

// Brands
router.get('/brands', requirePermission('inventory.view'), wrap(ctrl.listBrands));
router.post('/brands', requirePermission('inventory.create'), wrap(ctrl.createBrand));
router.get('/brands/:id', requirePermission('inventory.view'), wrap(ctrl.getBrand));
router.put('/brands/:id', requirePermission('inventory.edit'), wrap(ctrl.updateBrand));
router.delete('/brands/:id', requirePermission('inventory.delete'), wrap(ctrl.archiveBrand));

// Models
router.get('/models', requirePermission('inventory.view'), wrap(ctrl.listModels));
router.post('/models', requirePermission('inventory.create'), wrap(ctrl.createModel));
router.get('/models/:id', requirePermission('inventory.view'), wrap(ctrl.getModel));
router.put('/models/:id', requirePermission('inventory.edit'), wrap(ctrl.updateModel));
router.delete('/models/:id', requirePermission('inventory.delete'), wrap(ctrl.archiveModel));

// Products
router.get('/products', requirePermission('inventory.view'), wrap(ctrl.listProducts));
router.post('/products', requirePermission('inventory.create'), wrap(ctrl.createProduct));
router.get('/products/:id', requirePermission('inventory.view'), wrap(ctrl.getProduct));
router.put('/products/:id', requirePermission('inventory.edit'), wrap(ctrl.updateProduct));
router.delete('/products/:id', requirePermission('inventory.delete'), wrap(ctrl.archiveProduct));

// Stock levels and movements
router.get('/stock-levels', requirePermission('inventory.view'), wrap(ctrl.listStockLevels));
router.get('/movements', requirePermission('inventory.view'), wrap(ctrl.listMovements));

export default router;

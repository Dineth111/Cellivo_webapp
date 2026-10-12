import express from 'express';
import { protect } from '../../../core/auth.js';
import { subscriptionGuard } from '../../plans/planLimits.js';
import { requirePermission } from '../../../core/permissions.js';
import { wrap } from '../../../core/errors.js';
import * as ctrl from '../controllers/inventory.controller.js';
import * as imeiCtrl from '../controllers/imei.controller.js';
import * as adjCtrl from '../controllers/adjustments.controller.js';
import * as barcodeCtrl from '../controllers/barcode.controller.js';
import * as purCtrl from '../controllers/purchasing.controller.js';
import * as transferCtrl from '../controllers/transfer.controller.js';
import * as wooCtrl from '../controllers/woocommerce.controller.js';
import { requireFeature } from '../../plans/planLimits.js';
import { requireSpecial } from '../../../core/permissions.js';

const router = express.Router();

// All inventory routes require auth & active subscription
router.use(protect, subscriptionGuard);

// Barcode Generation & Label Printing
router.post('/products/generate-barcode', requirePermission('inventory.create'), wrap(barcodeCtrl.generateBarcode));
router.post('/products/:id/assign-barcode', requirePermission('inventory.edit'), wrap(barcodeCtrl.assignBarcodeToProduct));
router.get('/labels/presets', requirePermission('inventory.view'), wrap(barcodeCtrl.getLabelPresets));
router.post('/labels/preview', requirePermission('inventory.view'), wrap(barcodeCtrl.previewLabels));

// Low stock items
router.get('/low-stock', requirePermission('inventory.view'), wrap(adjCtrl.getLowStockItems));

// CSV Import
router.post('/products/import-csv', requirePermission('inventory.create'), wrap(adjCtrl.importProductsCsv));

// Stock adjustments (Creation requires special 'adjust_stock' permission)
router.get('/adjustments', requirePermission('inventory.view'), wrap(adjCtrl.listAdjustments));
router.post('/adjustments', requireSpecial('adjust_stock'), wrap(adjCtrl.createAdjustment));

// Stock counts (Approval requires special 'adjust_stock' permission)
router.get('/counts', requirePermission('inventory.view'), wrap(adjCtrl.listStockCounts));
router.post('/counts', requirePermission('inventory.create'), wrap(adjCtrl.createStockCount));
router.get('/counts/:id', requirePermission('inventory.view'), wrap(adjCtrl.getStockCount));
router.put('/counts/:id', requirePermission('inventory.edit'), wrap(adjCtrl.updateStockCount));
router.post('/counts/:id/approve', requireSpecial('adjust_stock'), wrap(adjCtrl.approveStockCount));

// IMEI Tracking (Gated by 'imei' plan feature)
router.get('/imei/search', requireFeature('imei'), requirePermission('inventory.view'), wrap(imeiCtrl.searchImei));
router.get('/imei/:imei/timeline', requireFeature('imei'), requirePermission('inventory.view'), wrap(imeiCtrl.getImeiTimeline));
router.post('/imei/:imei/reserve', requireFeature('imei'), requirePermission('inventory.view'), wrap(imeiCtrl.reserveImei));
router.post('/imei/:imei/release', requireFeature('imei'), requirePermission('inventory.view'), wrap(imeiCtrl.releaseImei));
router.post('/imei/:imei/status', requireFeature('imei'), requirePermission('inventory.edit'), wrap(imeiCtrl.updateImeiStatus));

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

// Suppliers
router.get('/suppliers', requirePermission('purchases.view'), wrap(purCtrl.listSuppliers));
router.post('/suppliers', requirePermission('purchases.create'), wrap(purCtrl.createSupplier));
router.get('/suppliers/:id', requirePermission('purchases.view'), wrap(purCtrl.getSupplier));
router.put('/suppliers/:id', requirePermission('purchases.edit'), wrap(purCtrl.updateSupplier));
router.delete('/suppliers/:id', requirePermission('purchases.delete'), wrap(purCtrl.archiveSupplier));

// Purchase Orders
router.get('/purchase-orders', requirePermission('purchases.view'), wrap(purCtrl.listPurchaseOrders));
router.post('/purchase-orders', requirePermission('purchases.create'), wrap(purCtrl.createPurchaseOrder));
router.get('/purchase-orders/:id', requirePermission('purchases.view'), wrap(purCtrl.getPurchaseOrder));
router.patch('/purchase-orders/:id/status', requirePermission('purchases.edit'), wrap(purCtrl.updatePoStatus));

// Goods Received Notes (GRN)
router.get('/grns', requirePermission('purchases.view'), wrap(purCtrl.listGrns));
router.post('/grns', requirePermission('purchases.create'), wrap(purCtrl.createGrn));
router.get('/grns/:id', requirePermission('purchases.view'), wrap(purCtrl.getGrn));

// Supplier Bills & Ageing
router.get('/bills', requirePermission('purchases.view'), wrap(purCtrl.listBills));
router.get('/bills/ageing', requirePermission('purchases.view'), wrap(purCtrl.getBillsAgeing));
router.post('/bills/reminders', requirePermission('purchases.view'), wrap(purCtrl.triggerPaymentReminders));

// Supplier Payments
router.get('/payments', requirePermission('purchases.view'), wrap(purCtrl.listPayments));
router.post('/payments', requirePermission('purchases.create'), wrap(purCtrl.createPayment));

// Purchase Returns
router.get('/purchase-returns', requirePermission('purchases.view'), wrap(purCtrl.listPurchaseReturns));
router.post('/purchase-returns', requirePermission('purchases.create'), wrap(purCtrl.createPurchaseReturn));

// Stock Transfers (F-16 / BR-02)
router.get('/transfers', requirePermission('inventory.view'), wrap(transferCtrl.listTransfers));
router.post('/transfers', requirePermission('inventory.create'), wrap(transferCtrl.requestTransfer));
router.get('/transfers/:id', requirePermission('inventory.view'), wrap(transferCtrl.getTransfer));
router.post('/transfers/:id/approve', requirePermission('inventory.approve'), wrap(transferCtrl.approveTransfer));
router.post('/transfers/:id/dispatch', requirePermission('inventory.edit'), wrap(transferCtrl.dispatchTransfer));
router.post('/transfers/:id/receive', requirePermission('inventory.edit'), wrap(transferCtrl.receiveTransfer));
router.post('/transfers/:id/cancel', requirePermission('inventory.edit'), wrap(transferCtrl.cancelTransfer));

// WooCommerce Integration (INT-01 - gated by 'woocommerce' plan feature)
router.get('/woocommerce/settings', requireFeature('woocommerce'), requirePermission('inventory.view'), wrap(wooCtrl.getSettings));
router.post('/woocommerce/settings', requireFeature('woocommerce'), requirePermission('settings.edit'), wrap(wooCtrl.updateSettings));
router.post('/woocommerce/sync-products', requireFeature('woocommerce'), requirePermission('inventory.edit'), wrap(wooCtrl.syncProduct));
router.post('/woocommerce/sync-stock', requireFeature('woocommerce'), requirePermission('inventory.edit'), wrap(wooCtrl.syncStock));
router.post('/woocommerce/pull-orders', requireFeature('woocommerce'), requirePermission('inventory.edit'), wrap(wooCtrl.pullOrders));
router.get('/woocommerce/queue', requireFeature('woocommerce'), requirePermission('inventory.view'), wrap(wooCtrl.listQueue));
router.post('/woocommerce/queue/process', requireFeature('woocommerce'), requirePermission('inventory.edit'), wrap(wooCtrl.processQueue));

export default router;

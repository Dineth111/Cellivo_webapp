import * as barcodeService from '../services/barcode.service.js';
import Product from '../models/Product.model.js';
import { requireId, str } from '../../../core/validate.js';
import { badRequest, notFound } from '../../../core/errors.js';
import { record as recordAudit } from '../../../core/audit.js';

export async function generateBarcode(req, res) {
  const barcode = await barcodeService.generateUniqueBarcode(req.auth.tenantId);
  res.json({ success: true, barcode });
}

export async function assignBarcodeToProduct(req, res) {
  const id = requireId(req.params.id);
  const product = await Product.findOne({ _id: id, isArchived: false });
  if (!product) throw notFound('Product not found');

  if (product.barcode) {
    return res.json({ success: true, barcode: product.barcode, message: 'Product already has a barcode' });
  }

  const barcode = await barcodeService.generateUniqueBarcode(req.auth.tenantId);
  product.barcode = barcode;
  await product.save();

  await recordAudit({
    action: 'inventory.barcode_generated',
    entity: 'Product',
    entityId: product._id,
    after: { barcode },
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ success: true, barcode, product });
}

export async function getLabelPresets(req, res) {
  res.json({ success: true, presets: barcodeService.LABEL_PRESETS });
}

export async function previewLabels(req, res) {
  const items = req.body.items || [];
  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest('items array is required');
  }

  const labelSize = str(req.body.labelSize) || '50x25';
  const showPrice = req.body.showPrice !== false;
  const showName = req.body.showName !== false;

  const result = barcodeService.formatLabels({
    items,
    labelSize,
    showPrice,
    showName,
  });

  res.json({ success: true, data: result });
}

export default {
  generateBarcode,
  assignBarcodeToProduct,
  getLabelPresets,
  previewLabels,
};

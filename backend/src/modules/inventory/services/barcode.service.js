import Product from '../models/Product.model.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest } from '../../../core/errors.js';
import { formatRupees } from '../../pos/money.js';

/**
 * Calculates EAN/UPC check digit for a given digit string.
 */
function calculateCheckDigit(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = parseInt(digits.charAt(i), 10);
    // Alternate weight 3 and 1 from right to left
    const weight = (digits.length - i) % 2 === 1 ? 3 : 1;
    sum += digit * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Generates a unique 12 or 13 digit barcode for a tenant product.
 */
export async function generateUniqueBarcode(tenantId) {
  return await runWithContext({ tenantId }, async () => {
    let attempts = 0;
    while (attempts < 20) {
      attempts++;
      // Prefix 20 (in-store internal range) + 9 random digits + 1 check digit = 12 digits
      const randomPart = Math.floor(100000000 + Math.random() * 900000000).toString();
      const prefix = `20${randomPart}`;
      const checkDigit = calculateCheckDigit(prefix);
      const barcode = `${prefix}${checkDigit}`;

      const exists = await Product.findOne({ barcode, isArchived: false }).lean();
      if (!exists) {
        return barcode;
      }
    }
    throw badRequest('Failed to generate a unique barcode. Please try again.');
  });
}

/**
 * Common supported label sheet configurations.
 */
export const LABEL_PRESETS = {
  '50x25': {
    name: '50mm x 25mm (Single Roll)',
    widthMm: 50,
    heightMm: 25,
    columns: 1,
    rows: 1,
  },
  '38x25': {
    name: '38mm x 25mm (Small Roll)',
    widthMm: 38,
    heightMm: 25,
    columns: 1,
    rows: 1,
  },
  '100x50': {
    name: '100mm x 50mm (Box / Shipping)',
    widthMm: 100,
    heightMm: 50,
    columns: 1,
    rows: 1,
  },
  'a4_24': {
    name: 'A4 Sheet (24 labels: 3x8, 63.5mm x 38.1mm)',
    widthMm: 210,
    heightMm: 297,
    columns: 3,
    rows: 8,
    labelWidthMm: 63.5,
    labelHeightMm: 38.1,
  },
};

/**
 * Format label payload for print rendering.
 */
export function formatLabels({ items = [], labelSize = '50x25', showPrice = true, showName = true, currency = 'Rs.' }) {
  const preset = LABEL_PRESETS[labelSize] || LABEL_PRESETS['50x25'];
  const labels = [];

  for (const item of items) {
    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    const labelItem = {
      productId: item.productId || null,
      name: showName ? (item.name || 'Product') : '',
      barcode: item.barcode || '',
      price: showPrice && item.sellingPriceCents != null ? formatRupees(item.sellingPriceCents) : '',
      sellingPriceCents: item.sellingPriceCents,
    };

    for (let i = 0; i < qty; i++) {
      labels.push({ ...labelItem, labelIndex: labels.length + 1 });
    }
  }

  return {
    preset,
    labelSize,
    totalLabels: labels.length,
    labels,
  };
}

export default {
  generateUniqueBarcode,
  formatLabels,
  LABEL_PRESETS,
};

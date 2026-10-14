import { hasSpecial } from '../../../core/permissions.js';

/**
 * Remove cost fields from object if user does not have view_cost_margin permission.
 */
export function maskCost(data, role) {
  if (hasSpecial(role, 'view_cost_margin')) {
    return data;
  }
  if (!data) return data;

  if (Array.isArray(data)) {
    return data.map((item) => maskCost(item, role));
  }

  if (typeof data === 'object') {
    const plain = data.toObject ? data.toObject() : { ...data };
    delete plain.costPriceCents;
    delete plain.averageCostCents;
    delete plain.unitCostCents;
    delete plain.totalCostCents;

    if (plain.stockLevels && Array.isArray(plain.stockLevels)) {
      plain.stockLevels = plain.stockLevels.map((sl) => {
        const copy = sl.toObject ? sl.toObject() : { ...sl };
        delete copy.averageCostCents;
        return copy;
      });
    }

    return plain;
  }

  return data;
}

export default maskCost;

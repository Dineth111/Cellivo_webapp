// TEMP: replace with Dev 4's stock service
import { badRequest } from '../../../core/errors.js';

/**
 * Validates part data. Does not touch inventory or FakeStock models.
 * Records parts directly on the repair ticket.
 */
export async function reservePart({ name, sku = null, qty = 1, unitCostCents = 0, unitPriceCents = 0, serial = null, addedBy = null }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw badRequest('Part name is required');
  }
  const quantity = Math.max(1, parseInt(qty, 10) || 1);
  const cost = Math.max(0, Math.round(unitCostCents || 0));
  const price = Math.max(0, Math.round(unitPriceCents || 0));

  return {
    name: name.trim(),
    sku: sku ? String(sku).trim() : null,
    qty: quantity,
    unitCostCents: cost,
    unitPriceCents: price,
    serial: serial ? String(serial).trim() : null,
    addedAt: new Date(),
    addedBy,
  };
}

/**
 * Consumes a part (reserved for future Dev 4 stock integration).
 */
export async function consumePart({ ticket, partId }) {
  const part = ticket.parts.id(partId);
  if (!part) throw badRequest('Part not found on ticket');
  return { success: true, part };
}

/**
 * Releases a part from the ticket (reserved for future Dev 4 stock integration).
 */
export async function releasePart({ ticket, partId }) {
  const part = ticket.parts.id(partId);
  if (!part) throw badRequest('Part not found on ticket');
  part.deleteOne();
  return { success: true };
}

export default {
  reservePart,
  consumePart,
  releasePart,
};

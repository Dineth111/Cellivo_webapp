/**
 * Normalises phone numbers to E.164.
 * Default country is Sri Lanka (+94).
 * Accepts:
 *   - 0771234567, 077 123 4567, 077-123-4567 -> +94771234567
 *   - 94771234567 -> +94771234567
 *   - +94771234567 -> +94771234567
 *   - Other international +14155552671 -> +14155552671
 */
export function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const cleaned = raw.trim().replace(/[\s\-\(\)\.]/g, '');
  if (!cleaned) return '';

  // Starts with + (international format)
  if (cleaned.startsWith('+')) {
    return cleaned;
  }

  // Starts with 0 (Sri Lanka local: 07x..., 01x...)
  if (cleaned.startsWith('0') && cleaned.length === 10 && /^\d+$/.test(cleaned)) {
    return `+94${cleaned.slice(1)}`;
  }

  // Starts with 94 followed by 9 digits
  if (cleaned.startsWith('94') && cleaned.length === 11 && /^\d+$/.test(cleaned)) {
    return `+${cleaned}`;
  }

  // 9 digits without leading 0 (e.g. 771234567)
  if (cleaned.length === 9 && /^[1-9]\d{8}$/.test(cleaned)) {
    return `+94${cleaned}`;
  }

  // Fallback: if all digits (e.g. 10 to 15 digits), add +
  if (/^\d{10,15}$/.test(cleaned)) {
    return `+${cleaned}`;
  }

  return cleaned;
}

/**
 * Generates search/duplicate check variants for a phone number
 * so legacy unnormalised phones in the DB are matched.
 */
export function phoneVariants(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  const normalized = normalizePhone(trimmed);
  const variants = new Set([trimmed, normalized]);

  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly) variants.add(digitsOnly);

  if (normalized.startsWith('+94') && normalized.length === 12) {
    const localNine = normalized.slice(3); // 771234567
    variants.add(`0${localNine}`);         // 0771234567
    variants.add(localNine);               // 771234567
    variants.add(`94${localNine}`);        // 94771234567
    variants.add(normalized);              // +94771234567
  }

  return Array.from(variants).filter(Boolean);
}

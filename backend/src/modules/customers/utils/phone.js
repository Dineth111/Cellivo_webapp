export const E164_REGEX = /^\+[1-9]\d{7,14}$/;

/**
 * Normalises phone numbers to E.164.
 * Default country is Sri Lanka (+94).
 * Rejects anything not matching /^\+[1-9]\d{7,14}$/ (returns '' for invalid).
 * Treats leading "00" as "+".
 * Accepts:
 *   - 0771234567, 077 123 4567, 077-123-4567 -> +94771234567
 *   - 0094771234567 -> +94771234567
 *   - 94771234567 -> +94771234567
 *   - +94771234567 -> +94771234567
 *   - Other international +14155552671 -> +14155552671
 */
export function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw.trim().replace(/[\s\-\(\)\.]/g, '');
  if (!cleaned) return '';

  // Leading 00 is international prefix equivalent to +
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }

  let candidate = '';

  // Starts with + (international format)
  if (cleaned.startsWith('+')) {
    candidate = cleaned;
  }
  // Starts with 0 (Sri Lanka local: 07x..., 01x... 10 digits total)
  else if (cleaned.startsWith('0') && cleaned.length === 10 && /^\d+$/.test(cleaned)) {
    candidate = `+94${cleaned.slice(1)}`;
  }
  // Starts with 94 followed by 9 digits
  else if (cleaned.startsWith('94') && cleaned.length === 11 && /^\d+$/.test(cleaned)) {
    candidate = `+${cleaned}`;
  }
  // 9 digits without leading 0 (e.g. 771234567)
  else if (cleaned.length === 9 && /^[1-9]\d{8}$/.test(cleaned)) {
    candidate = `+94${cleaned}`;
  }
  // Fallback if all digits (8 to 15 digits)
  else if (/^\d{8,15}$/.test(cleaned)) {
    candidate = `+${cleaned}`;
  }

  // Reject anything not matching /^\+[1-9]\d{7,14}$/
  if (candidate && E164_REGEX.test(candidate)) {
    return candidate;
  }

  return '';
}

/**
 * Generates search/duplicate check variants for a phone number
 * so legacy unnormalised phones in the DB are matched.
 */
export function phoneVariants(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  const normalized = normalizePhone(trimmed);
  const variants = new Set();
  if (trimmed) variants.add(trimmed);
  if (normalized) variants.add(normalized);

  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly) variants.add(digitsOnly);

  if (trimmed.startsWith('0') && trimmed.length >= 2) {
    const rest = trimmed.slice(1);
    variants.add(rest);
    variants.add(`+94${rest}`);
    variants.add(`94${rest}`);
  }

  if (normalized && normalized.startsWith('+94') && normalized.length === 12) {
    const localNine = normalized.slice(3); // 771234567
    variants.add(`0${localNine}`);         // 0771234567
    variants.add(localNine);               // 771234567
    variants.add(`94${localNine}`);        // 94771234567
    variants.add(`0094${localNine}`);      // 0094771234567
    variants.add(normalized);              // +94771234567
  }

  return Array.from(variants).filter(Boolean);
}

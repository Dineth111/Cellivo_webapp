/**
 * Validates IMEI number using Luhn checksum algorithm (Mod 10).
 * IMEIs are typically 15 digits (14 digits + 1 check digit) or 16 digits (IMEISV, 14 digits + 2 software version digits).
 * For 15-digit IMEIs, standard Luhn applies.
 */
export function validateImei(imei) {
  if (!imei) return false;
  const cleaned = String(imei).trim().replace(/[\s\-]/g, '');
  if (!/^\d{14,16}$/.test(cleaned)) return false;

  // For 15-digit IMEIs, verify Luhn checksum
  if (cleaned.length === 15) {
    let sum = 0;
    for (let i = 0; i < 15; i++) {
      let digit = parseInt(cleaned[i], 10);
      // Double every 2nd digit starting from 2nd digit (0-indexed odd positions: 1, 3, 5, 7, 9, 11, 13)
      if (i % 2 === 1) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }
    return sum % 10 === 0;
  }

  // 14 or 16 digit IMEIs
  return true;
}

export default { validateImei };

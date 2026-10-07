/**
 * Validates IMEI checksum using the standard Luhn algorithm.
 */
export function isValidImei(imei) {
  if (!imei) return false;
  const cleaned = String(imei).trim();
  if (!/^\d{14,16}$/.test(cleaned)) return false;

  let sum = 0;
  for (let i = 0; i < cleaned.length; i++) {
    let digit = parseInt(cleaned.charAt(i), 10);
    const posFromRight = cleaned.length - i;
    if (posFromRight % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export default { isValidImei };

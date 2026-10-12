/**
 * Masks a phone number for list responses (e.g. +94771234567 -> +947*****567, 0771234567 -> 077*****567).
 */
export function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const str = phone.trim();
  if (str.length <= 5) return '*****';
  const prefix = str.slice(0, 4);
  const suffix = str.slice(-3);
  return `${prefix}${'*'.repeat(Math.max(3, str.length - 7))}${suffix}`;
}

/**
 * Masks an NIC number (e.g. 199512345678 -> 199*****678, 951234567V -> 95*****67V).
 */
export function maskNic(nic) {
  if (!nic || typeof nic !== 'string') return '';
  const str = nic.trim();
  if (str.length <= 4) return '****';
  const prefix = str.slice(0, 3);
  const suffix = str.slice(-3);
  return `${prefix}${'*'.repeat(Math.max(3, str.length - 6))}${suffix}`;
}

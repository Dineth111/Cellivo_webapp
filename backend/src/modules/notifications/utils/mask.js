/**
 * Masking utilities for sensitive recipient information (phone numbers and emails).
 */

export function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const clean = phone.trim();
  if (clean.length <= 4) return '****';
  const keepStart = Math.min(4, Math.floor(clean.length / 3));
  const keepEnd = Math.min(3, Math.floor(clean.length / 3));
  const maskLen = clean.length - keepStart - keepEnd;
  return clean.slice(0, keepStart) + '*'.repeat(Math.max(3, maskLen)) + clean.slice(-keepEnd);
}

export function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2) return '****';
  const [local, domain] = parts;
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  const maskedLocal = local[0] + '*'.repeat(Math.max(3, local.length - 2)) + local.slice(-1);
  return `${maskedLocal}@${domain}`;
}

export function maskRecipient(to, channel = 'sms') {
  if (channel === 'email' || (typeof to === 'string' && to.includes('@'))) {
    return maskEmail(to);
  }
  return maskPhone(to);
}

export default { maskPhone, maskEmail, maskRecipient };

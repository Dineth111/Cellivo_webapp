/**
 * WhatsApp helper: builds a wa.me link with prefilled text (no API integration).
 *
 * @param {string} phone
 * @param {string} text
 * @returns {string} wa.me URL
 */
export function buildWhatsAppLink(phone, text = '') {
  if (!phone) return '';
  const cleanPhone = String(phone).replace(/[^\d]/g, '');
  const encodedText = encodeURIComponent(text);
  return `https://wa.me/${cleanPhone}${encodedText ? `?text=${encodedText}` : ''}`;
}

export default { buildWhatsAppLink };

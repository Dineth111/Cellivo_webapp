/**
 * Calculates SMS character length and multi-part message count.
 * Rules:
 * - 160 characters per part for GSM text (single part).
 * - 153 characters per part for GSM text when multi-part.
 * - 70 characters per part for Unicode text (single part).
 * - 67 characters per part for Unicode text when multi-part.
 */

export function isUnicodeText(text) {
  if (!text) return false;
  // Characters outside standard printable ASCII, newline, and carriage return count as Unicode
  return /[^\u0020-\u007E\r\n]/.test(text);
}

export function calculateSmsParts(text) {
  if (!text) return 1;
  const isUnicode = isUnicodeText(text);
  const length = Array.from(text).length; // Handle multi-byte/surrogate characters accurately

  if (isUnicode) {
    if (length <= 70) return 1;
    return Math.ceil(length / 67);
  } else {
    if (length <= 160) return 1;
    return Math.ceil(length / 153);
  }
}

export default { isUnicodeText, calculateSmsParts };

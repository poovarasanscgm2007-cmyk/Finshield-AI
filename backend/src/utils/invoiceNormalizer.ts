const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * Normalizes invoice numbers by uppercasing and removing spaces, dashes, and underscores.
 * Example: "INV-123", "INV 123", "inv_123" -> "INV123"
 */
export function normalizeInvoiceNumber(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().toUpperCase().replace(/[\s\-_]+/g, '');
  return normalized.length > 0 ? normalized : null;
}

export function isValidGstinFormat(gstin: string | null | undefined): boolean {
  if (!gstin) return false;
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
}

export function isValidGstinChecksum(gstin: string | null | undefined): boolean {
  if (!gstin) return false;
  const normalized = gstin.trim().toUpperCase();
  if (!GSTIN_REGEX.test(normalized)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const codePoint = GSTIN_CHARSET.indexOf(normalized[i]);
    if (codePoint < 0) return false;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = codePoint * factor;
    const digit = Math.floor(product / 36) + (product % 36);
    sum += digit;
  }
  const remainder = sum % 36;
  const checkIndex = (36 - remainder) % 36;
  return GSTIN_CHARSET[checkIndex] === normalized[14];
}

export function isValidIsoDate(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) return false;
  const parsed = new Date(`${dateStr.trim()}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateStr.trim();
}

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export interface GstinValidationResult {
  gstin: string;
  formatValid: boolean;
  checksumValid: boolean;
  expectedChecksumChar: string | null;
  stateCode: string | null;
  pan: string | null;
  reason: string | null;
}

/**
 * Computes Indian GSTIN Mod-36 check digit over the first 14 characters.
 */
export function computeGstinChecksumChar(first14: string): string | null {
  const upper = first14.trim().toUpperCase();
  if (upper.length !== 14) return null;

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const codePoint = GSTIN_CHARSET.indexOf(upper[i]);
    if (codePoint === -1) return null;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = codePoint * factor;
    const quotient = Math.floor(product / 36);
    const remainder = product % 36;
    sum += quotient + remainder;
  }

  const checkCodePoint = (36 - (sum % 36)) % 36;
  return GSTIN_CHARSET[checkCodePoint] ?? null;
}

export function validateGstin(rawGstin: string | null | undefined): GstinValidationResult {
  const gstin = (rawGstin || '').trim().toUpperCase();
  if (!gstin) {
    return {
      gstin: '',
      formatValid: false,
      checksumValid: false,
      expectedChecksumChar: null,
      stateCode: null,
      pan: null,
      reason: 'Supplier GSTIN is missing',
    };
  }

  const formatValid = GSTIN_REGEX.test(gstin);
  if (!formatValid) {
    return {
      gstin,
      formatValid: false,
      checksumValid: false,
      expectedChecksumChar: null,
      stateCode: gstin.length >= 2 ? gstin.slice(0, 2) : null,
      pan: gstin.length >= 12 ? gstin.slice(2, 12) : null,
      reason: `GSTIN "${gstin}" fails 15-character structure validation`,
    };
  }

  const expectedChar = computeGstinChecksumChar(gstin.slice(0, 14));
  const checksumValid = expectedChar !== null && gstin[14] === expectedChar;

  return {
    gstin,
    formatValid: true,
    checksumValid,
    expectedChecksumChar: expectedChar,
    stateCode: gstin.slice(0, 2),
    pan: gstin.slice(2, 12),
    reason: checksumValid
      ? null
      : `GSTIN "${gstin}" failed Mod-36 checksum (expected check character "${expectedChar}", found "${gstin[14]}")`,
  };
}

export interface GstTaxTypeValidationResult {
  valid: boolean;
  isIntraState: boolean | null;
  reason: string | null;
}

export function validateGstTaxType(input: {
  supplierStateCode: string | null | undefined;
  buyerStateCode: string | null | undefined;
  cgst: number;
  sgst: number;
  igst: number;
  tolerance?: number;
}): GstTaxTypeValidationResult {
  const supState = (input.supplierStateCode || '').trim();
  const buyState = (input.buyerStateCode || '').trim();
  if (!supState || !buyState) {
    return { valid: true, isIntraState: null, reason: null };
  }

  const tol = Number.isFinite(input.tolerance) ? Number(input.tolerance) : 0.01;
  const isIntraState = supState === buyState;
  const cgst = Number(input.cgst || 0);
  const sgst = Number(input.sgst || 0);
  const igst = Number(input.igst || 0);

  if (isIntraState) {
    if (igst > tol) {
      return {
        valid: false,
        isIntraState: true,
        reason: `Intra-state supply (state ${supState} -> ${buyState}) charged IGST Rs ${igst.toFixed(2)} instead of CGST + SGST`,
      };
    }
    if (Math.abs(cgst - sgst) > Math.max(tol, 1)) {
      return {
        valid: false,
        isIntraState: true,
        reason: `Intra-state CGST (Rs ${cgst.toFixed(2)}) and SGST (Rs ${sgst.toFixed(2)}) must be equal`,
      };
    }
  } else {
    if (cgst > tol || sgst > tol) {
      return {
        valid: false,
        isIntraState: false,
        reason: `Inter-state supply (state ${supState} -> ${buyState}) charged CGST/SGST instead of IGST`,
      };
    }
  }

  return { valid: true, isIntraState, reason: null };
}

export interface ExtractedLineItemRaw {
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  confidence: number;
}

export interface ExtractedInvoiceRaw {
  supplierName: { value: string | null; confidence: number };
  supplierGstin: { value: string | null; confidence: number };
  invoiceNumber: { value: string | null; confidence: number };
  invoiceDate: { value: string | null; confidence: number };
  poReference: { value: string | null; confidence: number };
  irn: { value: string | null; confidence: number };
  bankIdentifier: { value: string | null; confidence: number };
  subtotal: { value: number | null; confidence: number };
  cgst: { value: number | null; confidence: number };
  sgst: { value: number | null; confidence: number };
  igst: { value: number | null; confidence: number };
  totalAmount: { value: number | null; confidence: number };
  lineItems: ExtractedLineItemRaw[];
}

function parseNumeric(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '').trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseDateIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const dmy = trimmed.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  }
  return null;
}

/**
 * Regex-based fallback extractor for Indian GST invoices.
 * Never invents missing fields: returns null with confidence 0 when not found.
 */
export function extractInvoiceWithRegex(rawText: string): ExtractedInvoiceRaw {
  const text = rawText || '';

  const textWithoutBuyerGstin = text
    .replace(/Buyer\s*GSTIN\s*[:\-]?\s*[A-Z0-9]+/gi, '')
    .replace(/Bill\s*To\s*:[^\n]*/gi, '');
  const gstinMatch =
    textWithoutBuyerGstin.match(
      /(?:Supplier\s*)?GSTIN\s*[:\-]?\s*([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/i
    ) ||
    textWithoutBuyerGstin.match(/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/);
  const invNumMatch = text.match(/\bInvoice\s*(?:Number|No\.?|#)\s*[:\-]?\s*([A-Z0-9\-\/_]+)/i);
  const dateMatch = text.match(/\bInvoice\s*Date\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}|\d{2}[\/\-]\d{2}[\/\-]\d{4})/i);
  const poMatch = text.match(/\b(?:PO\s*(?:Reference|Ref\.?|Number|No\.?)|Purchase\s*Order)\s*[:\-]?\s*([A-Z0-9\-\/_]+)/i);
  const irnMatch = text.match(/\bIRN\s*[:\-]?\s*([A-Z0-9\-]{8,})/i);
  const bankMatch = text.match(/\bBank\s*(?:Identifier|ID|Account)\s*[:\-]?\s*([A-Z0-9\-_]+)/i);

  let supplierName: string | null = null;
  const supplierExplicit = text.match(/\b(?:Supplier|Vendor|From)\s*[:\-]\s*([^\n]+)/i);
  if (supplierExplicit) {
    supplierName = supplierExplicit[1].trim();
  } else {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const taxInvIdx = lines.findIndex((l) => /TAX\s+INVOICE/i.test(l));
    if (taxInvIdx >= 0 && lines[taxInvIdx + 1] && !/GSTIN/i.test(lines[taxInvIdx + 1])) {
      supplierName = lines[taxInvIdx + 1];
    }
  }

  const subtotalMatch = text.match(/\bSubtotal\s*[:\-]?\s*(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const cgstMatch = text.match(/\bCGST(?:\s*\(\d+%?\))?\s*[:\-]?\s*(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const sgstMatch = text.match(/\bSGST(?:\s*\(\d+%?\))?\s*[:\-]?\s*(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const igstMatch = text.match(/\bIGST(?:\s*\(\d+%?\))?\s*[:\-]?\s*(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const totalMatch = text.match(/\b(?:Grand\s+)?Total\s*(?:Amount|Payable)?\s*[:\-]\s*(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i);

  const lineItems: ExtractedLineItemRaw[] = [];
  const lineRegex =
    /^\s*\d+\.\s*([^|\n]+?)\s*(?:\|\s*HSN\s*:\s*\d+\s*)?\|\s*(?:Qty\s*:\s*)?([\d.]+)\s*([a-zA-Z]+)\s*\|\s*(?:Rate\s*:\s*)?(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)\s*\|\s*(?:Amount\s*:\s*)?(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/gim;

  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(text)) !== null) {
    lineItems.push({
      description: m[1].trim(),
      quantity: parseNumeric(m[2]),
      unit: m[3].trim(),
      unitPrice: parseNumeric(m[4]),
      lineTotal: parseNumeric(m[5]),
      confidence: 0.84,
    });
  }

  const subtotal = parseNumeric(subtotalMatch?.[1]);
  const cgst = parseNumeric(cgstMatch?.[1]);
  const sgst = parseNumeric(sgstMatch?.[1]);
  const igst = parseNumeric(igstMatch?.[1]);
  const totalAmount = parseNumeric(totalMatch?.[1]);
  const parsedDate = parseDateIso(dateMatch?.[1]);

  return {
    supplierName: {
      value: supplierName,
      confidence: supplierName ? 0.85 : 0,
    },
    supplierGstin: {
      value: gstinMatch ? gstinMatch[1].toUpperCase() : null,
      confidence: gstinMatch ? 0.88 : 0,
    },
    invoiceNumber: {
      value: invNumMatch ? invNumMatch[1].trim() : null,
      confidence: invNumMatch ? 0.88 : 0,
    },
    invoiceDate: {
      value: parsedDate,
      confidence: parsedDate ? 0.86 : 0,
    },
    poReference: {
      value: poMatch ? poMatch[1].trim() : null,
      confidence: poMatch ? 0.85 : 0,
    },
    irn: {
      value: irnMatch ? irnMatch[1].trim() : null,
      confidence: irnMatch ? 0.85 : 0,
    },
    bankIdentifier: {
      value: bankMatch ? bankMatch[1].trim() : null,
      confidence: bankMatch ? 0.85 : 0,
    },
    subtotal: {
      value: subtotal,
      confidence: subtotal !== null ? 0.86 : 0,
    },
    cgst: {
      value: cgst,
      confidence: cgst !== null ? 0.86 : 0,
    },
    sgst: {
      value: sgst,
      confidence: sgst !== null ? 0.86 : 0,
    },
    igst: {
      value: igst,
      confidence: igst !== null ? 0.86 : 0,
    },
    totalAmount: {
      value: totalAmount,
      confidence: totalAmount !== null ? 0.86 : 0,
    },
    lineItems,
  };
}

import { GoogleGenAI, Type } from '@google/genai';
import { env } from '../config/env.ts';
import {
  isValidGstinFormat,
  isValidIsoDate,
  normalizeInvoiceNumber,
} from '../utils/invoiceNormalizer.ts';
import { TextExtractionResult, WordConfidence } from './ocrTextExtractor.ts';
import { ExtractedInvoiceRaw, extractInvoiceWithRegex } from './regexInvoiceExtractor.ts';

export interface FieldConfidenceDetail {
  value: unknown;
  confidence: number;
  missing: boolean;
  lowConfidence: boolean;
  optional?: boolean;
  status: 'OK' | 'LOW_CONFIDENCE' | 'MISSING';
}

export interface StructuredInvoiceExtraction {
  extractionSource: 'LLM' | 'FALLBACK';
  extractionMethod: 'PDF_TEXT' | 'TESSERACT_OCR';
  ocrConfidence: number;
  threshold: number;
  status: 'EXTRACTED' | 'NEEDS_VERIFICATION';
  rawText: string;
  fields: {
    supplier_name: string | null;
    supplier_gstin: string | null;
    invoice_number: string | null;
    normalized_invoice_number: string | null;
    invoice_date: string | null;
    po_reference: string | null;
    irn: string | null;
    bank_identifier: string | null;
    subtotal: number | null;
    cgst: number | null;
    sgst: number | null;
    igst: number | null;
    total: number | null;
  };
  lineItems: Array<{
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    lineTotal: number;
    confidence: number;
  }>;
  extractionConfidence: {
    threshold: number;
    ocrConfidence: number;
    extractionMethod: 'PDF_TEXT' | 'TESSERACT_OCR';
    extractionSource: 'LLM' | 'FALLBACK';
    fields: Record<string, FieldConfidenceDetail>;
    missingFields: string[];
    lowConfidenceFields: string[];
  };
}

function isUsableApiKey(key: string): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  return (
    trimmed.length > 10 &&
    !trimmed.startsWith('MY_') &&
    !trimmed.includes('YOUR_API_KEY')
  );
}

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Number(Math.max(0, Math.min(1, val)).toFixed(2));
}

function matchTokenOcrConfidence(
  value: unknown,
  wordConfidences: WordConfidence[],
  fallbackOcrConf: number
): number {
  if (wordConfidences.length === 0 || value === null || value === undefined) {
    return fallbackOcrConf;
  }
  const str = String(value).trim();
  if (!str) return fallbackOcrConf;

  const tokens = str
    .split(/[\s,|:]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);

  if (tokens.length === 0) return fallbackOcrConf;

  const matched: number[] = [];
  for (const tok of tokens) {
    const found = wordConfidences.find((w) => w.text.toLowerCase().includes(tok) || tok.includes(w.text.toLowerCase()));
    if (found) {
      matched.push(found.confidence);
    }
  }

  if (matched.length === 0) {
    return Math.min(fallbackOcrConf, 0.72);
  }
  const avg = matched.reduce((s, c) => s + c, 0) / matched.length;
  return clamp01(avg);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callGeminiExtractor(rawText: string): Promise<ExtractedInvoiceRaw> {
  const apiKey = env.LLM_API_KEY;
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 10000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const fieldStringSchema = {
    type: Type.OBJECT,
    properties: {
      value: { type: Type.STRING, nullable: true },
      confidence: { type: Type.NUMBER },
    },
    required: ['value', 'confidence'],
  };

  const fieldNumberSchema = {
    type: Type.OBJECT,
    properties: {
      value: { type: Type.NUMBER, nullable: true },
      confidence: { type: Type.NUMBER },
    },
    required: ['value', 'confidence'],
  };

  const prompt = `Extract structured invoice fields from the OCR/PDF text below.
CRITICAL RULES:
1. Extract ONLY values explicitly present in the text. NEVER invent, guess, or infer missing values.
2. If a field is absent or unreadable, set value to null and confidence to 0.
3. Format invoiceDate strictly as YYYY-MM-DD when present.
4. Provide a confidence score from 0.0 to 1.0 for every field based on text clarity and certainty.

INVOICE TEXT:
"""
${rawText.slice(0, 16000)}
"""`;

  const response = await withTimeout(
    ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction:
          'You are a strict Indian GST invoice parser. Return valid JSON matching the schema. Never fabricate missing values.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            supplierName: fieldStringSchema,
            supplierGstin: fieldStringSchema,
            invoiceNumber: fieldStringSchema,
            invoiceDate: fieldStringSchema,
            poReference: fieldStringSchema,
            irn: fieldStringSchema,
            bankIdentifier: fieldStringSchema,
            subtotal: fieldNumberSchema,
            cgst: fieldNumberSchema,
            sgst: fieldNumberSchema,
            igst: fieldNumberSchema,
            totalAmount: fieldNumberSchema,
            lineItems: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  description: { type: Type.STRING, nullable: true },
                  quantity: { type: Type.NUMBER, nullable: true },
                  unit: { type: Type.STRING, nullable: true },
                  unitPrice: { type: Type.NUMBER, nullable: true },
                  lineTotal: { type: Type.NUMBER, nullable: true },
                  confidence: { type: Type.NUMBER },
                },
                required: ['description', 'quantity', 'unit', 'unitPrice', 'lineTotal', 'confidence'],
              },
            },
          },
          required: [
            'supplierName',
            'supplierGstin',
            'invoiceNumber',
            'invoiceDate',
            'poReference',
            'irn',
            'bankIdentifier',
            'subtotal',
            'cgst',
            'sgst',
            'igst',
            'totalAmount',
            'lineItems',
          ],
        },
      },
    }),
    12000,
    'Gemini invoice extraction'
  );

  const text = (response.text || '').trim();
  if (!text) {
    throw new Error('Gemini returned empty response');
  }

  return JSON.parse(text) as ExtractedInvoiceRaw;
}

export async function extractStructuredInvoice(
  textResult: TextExtractionResult
): Promise<StructuredInvoiceExtraction> {
  const threshold = Number.isFinite(env.EXTRACTION_CONFIDENCE_THRESHOLD)
    ? env.EXTRACTION_CONFIDENCE_THRESHOLD
    : 0.8;

  let rawExtraction: ExtractedInvoiceRaw;
  let extractionSource: 'LLM' | 'FALLBACK' = 'FALLBACK';

  if (isUsableApiKey(env.LLM_API_KEY) && textResult.text.trim().length > 0) {
    try {
      rawExtraction = await callGeminiExtractor(textResult.text);
      extractionSource = 'LLM';
    } catch (err) {
      console.warn(
        'LLM extraction failed, falling back to regex extractor:',
        err instanceof Error ? err.message : err
      );
      rawExtraction = extractInvoiceWithRegex(textResult.text);
      extractionSource = 'FALLBACK';
    }
  } else {
    rawExtraction = extractInvoiceWithRegex(textResult.text);
    extractionSource = 'FALLBACK';
  }

  const calibrateField = (
    key: string,
    rawField: { value: unknown; confidence?: number } | undefined,
    opts: { optional?: boolean; validator?: (v: unknown) => boolean } = {}
  ): FieldConfidenceDetail => {
    const val = rawField?.value ?? null;
    const isMissing =
      val === null ||
      val === undefined ||
      (typeof val === 'string' && val.trim() === '');

    if (isMissing) {
      return {
        value: null,
        confidence: 0,
        missing: true,
        lowConfidence: !opts.optional,
        optional: opts.optional,
        status: 'MISSING',
      };
    }

    const baseConf =
      typeof rawField?.confidence === 'number' && rawField.confidence > 0
        ? rawField.confidence
        : extractionSource === 'LLM'
        ? 0.9
        : 0.86;

    const tokenOcrConf = matchTokenOcrConfidence(
      val,
      textResult.wordConfidences,
      textResult.ocrConfidence
    );

    let score =
      textResult.method === 'TESSERACT_OCR'
        ? Math.min(baseConf, tokenOcrConf)
        : Math.min(baseConf, textResult.ocrConfidence);

    if (opts.validator && !opts.validator(val)) {
      score = Math.min(score, 0.55);
    }

    score = clamp01(score);
    const lowConfidence = score < threshold;

    return {
      value: typeof val === 'string' ? val.trim() : val,
      confidence: score,
      missing: false,
      lowConfidence,
      optional: opts.optional,
      status: lowConfidence ? 'LOW_CONFIDENCE' : 'OK',
    };
  };

  const supplierName = calibrateField('supplier_name', rawExtraction.supplierName);
  const supplierGstin = calibrateField('supplier_gstin', rawExtraction.supplierGstin, {
    validator: (v) => typeof v === 'string' && isValidGstinFormat(v),
  });
  const invoiceNumber = calibrateField('invoice_number', rawExtraction.invoiceNumber);
  const invoiceDate = calibrateField('invoice_date', rawExtraction.invoiceDate, {
    validator: (v) => typeof v === 'string' && isValidIsoDate(v),
  });
  const poReference = calibrateField('po_reference', rawExtraction.poReference);
  const irn = calibrateField('irn', rawExtraction.irn, { optional: true });
  const bankIdentifier = calibrateField('bank_identifier', rawExtraction.bankIdentifier, {
    optional: true,
  });

  const subtotal = calibrateField('subtotal', rawExtraction.subtotal, {
    validator: (v) => typeof v === 'number' && v >= 0,
  });
  const cgst = calibrateField('cgst', rawExtraction.cgst, {
    optional: true,
    validator: (v) => typeof v === 'number' && v >= 0,
  });
  const sgst = calibrateField('sgst', rawExtraction.sgst, {
    optional: true,
    validator: (v) => typeof v === 'number' && v >= 0,
  });
  const igst = calibrateField('igst', rawExtraction.igst, {
    optional: true,
    validator: (v) => typeof v === 'number' && v >= 0,
  });

  const arithmeticOk = (() => {
    const sub = typeof subtotal.value === 'number' ? subtotal.value : null;
    const tot = typeof rawExtraction.totalAmount?.value === 'number' ? rawExtraction.totalAmount.value : null;
    if (sub === null || tot === null) return false;
    const taxSum =
      (typeof cgst.value === 'number' ? cgst.value : 0) +
      (typeof sgst.value === 'number' ? sgst.value : 0) +
      (typeof igst.value === 'number' ? igst.value : 0);
    return Math.abs(sub + taxSum - tot) <= 2;
  })();

  const totalAmount = calibrateField('total', rawExtraction.totalAmount, {
    validator: (v) => typeof v === 'number' && v > 0 && arithmeticOk,
  });

  const lineItems = (Array.isArray(rawExtraction.lineItems) ? rawExtraction.lineItems : [])
    .filter((li) => li && li.description)
    .map((li) => {
      const qty = typeof li.quantity === 'number' ? li.quantity : 0;
      const unitPrice = typeof li.unitPrice === 'number' ? li.unitPrice : 0;
      const lineTotal =
        typeof li.lineTotal === 'number' ? li.lineTotal : Number((qty * unitPrice).toFixed(2));
      const baseLiConf = typeof li.confidence === 'number' && li.confidence > 0 ? li.confidence : 0.85;
      const tokenConf = matchTokenOcrConfidence(
        li.description,
        textResult.wordConfidences,
        textResult.ocrConfidence
      );
      const conf = clamp01(
        textResult.method === 'TESSERACT_OCR'
          ? Math.min(baseLiConf, tokenConf)
          : Math.min(baseLiConf, textResult.ocrConfidence)
      );
      return {
        description: String(li.description).trim(),
        quantity: qty,
        unit: li.unit ? String(li.unit).trim() : 'kg',
        unitPrice,
        lineTotal,
        confidence: conf,
      };
    });

  const lineItemsDetail: FieldConfidenceDetail =
    lineItems.length > 0
      ? {
          value: lineItems,
          confidence: clamp01(
            lineItems.reduce((min, l) => Math.min(min, l.confidence), 1)
          ),
          missing: false,
          lowConfidence: lineItems.some((l) => l.confidence < threshold),
          status: lineItems.some((l) => l.confidence < threshold)
            ? 'LOW_CONFIDENCE'
            : 'OK',
        }
      : {
          value: [],
          confidence: 0,
          missing: true,
          lowConfidence: true,
          status: 'MISSING',
        };

  const fieldsMap: Record<string, FieldConfidenceDetail> = {
    supplier_name: supplierName,
    supplier_gstin: supplierGstin,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    po_reference: poReference,
    irn,
    bank_identifier: bankIdentifier,
    subtotal,
    cgst,
    sgst,
    igst,
    total: totalAmount,
    line_items: lineItemsDetail,
  };

  const missingFields = Object.entries(fieldsMap)
    .filter(([, detail]) => detail.missing && !detail.optional)
    .map(([key]) => key);

  const lowConfidenceFields = Object.entries(fieldsMap)
    .filter(([, detail]) => !detail.missing && detail.lowConfidence)
    .map(([key]) => key);

  const needsVerification =
    missingFields.length > 0 || lowConfidenceFields.length > 0;

  return {
    extractionSource,
    extractionMethod: textResult.method,
    ocrConfidence: textResult.ocrConfidence,
    threshold,
    status: needsVerification ? 'NEEDS_VERIFICATION' : 'EXTRACTED',
    rawText: textResult.text,
    fields: {
      supplier_name: (supplierName.value as string | null) ?? null,
      supplier_gstin:
        typeof supplierGstin.value === 'string'
          ? supplierGstin.value.toUpperCase()
          : null,
      invoice_number: (invoiceNumber.value as string | null) ?? null,
      normalized_invoice_number: normalizeInvoiceNumber(
        invoiceNumber.value as string | null
      ),
      invoice_date:
        typeof invoiceDate.value === 'string' && isValidIsoDate(invoiceDate.value)
          ? invoiceDate.value
          : null,
      po_reference: (poReference.value as string | null) ?? null,
      irn: (irn.value as string | null) ?? null,
      bank_identifier: (bankIdentifier.value as string | null) ?? null,
      subtotal: typeof subtotal.value === 'number' ? subtotal.value : null,
      cgst: typeof cgst.value === 'number' ? cgst.value : null,
      sgst: typeof sgst.value === 'number' ? sgst.value : null,
      igst: typeof igst.value === 'number' ? igst.value : null,
      total: typeof totalAmount.value === 'number' ? totalAmount.value : null,
    },
    lineItems,
    extractionConfidence: {
      threshold,
      ocrConfidence: textResult.ocrConfidence,
      extractionMethod: textResult.method,
      extractionSource,
      fields: fieldsMap,
      missingFields,
      lowConfidenceFields,
    },
  };
}

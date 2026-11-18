import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { extractStructuredInvoice } from '../src/services/llmInvoiceExtractor.ts';
import { extractTextFromDocument } from '../src/services/ocrTextExtractor.ts';
import { extractInvoiceWithRegex } from '../src/services/regexInvoiceExtractor.ts';
import {
  isValidGstinFormat,
  isValidIsoDate,
  normalizeInvoiceNumber,
} from '../src/utils/invoiceNormalizer.ts';

describe('Phase 3 Unit Tests (Normalization, Regex Fallback, PDF Text & Scanned OCR)', () => {
  test('normalizeInvoiceNumber strips spaces, dashes, underscores and uppercases', () => {
    assert.equal(normalizeInvoiceNumber('INV-123'), 'INV123');
    assert.equal(normalizeInvoiceNumber('inv 123'), 'INV123');
    assert.equal(normalizeInvoiceNumber('INV_123'), 'INV123');
    assert.equal(normalizeInvoiceNumber('  inv - _ 101 '), 'INV101');
    assert.equal(normalizeInvoiceNumber(''), null);
    assert.equal(normalizeInvoiceNumber(null), null);
  });

  test('isValidGstinFormat and isValidIsoDate validate standard formats', () => {
    assert.equal(isValidGstinFormat('27AABCS5678C1Z9'), true);
    assert.equal(isValidGstinFormat('BADGSTIN'), false);
    assert.equal(isValidIsoDate('2026-11-18'), true);
    assert.equal(isValidIsoDate('2026-02-30'), false);
  });

  test('extractInvoiceWithRegex extracts fields and never invents missing values', () => {
    const partialText = `
      TAX INVOICE
      Supplier: Test Timber Co
      Invoice Number: INV-777
      Subtotal: Rs 1000.00
    `;
    const parsed = extractInvoiceWithRegex(partialText);
    assert.equal(parsed.supplierName.value, 'Test Timber Co');
    assert.equal(parsed.invoiceNumber.value, 'INV-777');
    assert.equal(parsed.subtotal.value, 1000);
    // Missing fields must remain null with 0 confidence
    assert.equal(parsed.supplierGstin.value, null);
    assert.equal(parsed.supplierGstin.confidence, 0);
    assert.equal(parsed.poReference.value, null);
    assert.equal(parsed.poReference.confidence, 0);
    assert.equal(parsed.totalAmount.value, null);
    assert.equal(parsed.totalAmount.confidence, 0);
    assert.equal(parsed.irn.value, null);
    assert.equal(parsed.irn.confidence, 0);
  });

  test('extractStructuredInvoice flags missing fields as NEEDS_VERIFICATION with MISSING status', async () => {
    const result = await extractStructuredInvoice({
      text: 'Invoice Number: INV-999\nSubtotal: Rs 500.00',
      method: 'PDF_TEXT',
      ocrConfidence: 0.98,
      wordConfidences: [],
    });

    assert.equal(result.status, 'NEEDS_VERIFICATION');
    assert.equal(result.fields.normalized_invoice_number, 'INV999');
    assert.equal(result.fields.supplier_gstin, null);
    assert.equal(result.extractionConfidence.fields.supplier_gstin.status, 'MISSING');
    assert.equal(result.extractionConfidence.fields.supplier_gstin.confidence, 0);
    assert.ok(result.extractionConfidence.missingFields.includes('supplier_gstin'));
  });

  test('sample INV-101-sample.pdf uses direct PDF_TEXT extraction', async () => {
    const pdfPath = path.resolve(process.cwd(), 'sample-data/invoices/INV-101-sample.pdf');
    const buffer = fs.readFileSync(pdfPath);
    const textResult = await extractTextFromDocument(buffer, 'application/pdf');

    assert.equal(textResult.method, 'PDF_TEXT');
    assert.match(textResult.text, /INV-101/);
    assert.match(textResult.text, /PO-101/);
    assert.match(textResult.text, /27AABCS5678C1Z9/);

    const regexParsed = extractInvoiceWithRegex(textResult.text);
    assert.equal(regexParsed.invoiceNumber.value, 'INV-101');
    assert.equal(regexParsed.poReference.value, 'PO-101');
    assert.equal(regexParsed.supplierGstin.value, '27AABCS5678C1Z9');
    assert.equal(regexParsed.subtotal.value, 50000);
    assert.equal(regexParsed.totalAmount.value, 59000);
    assert.equal(regexParsed.lineItems.length, 1);
    assert.equal(regexParsed.lineItems[0].quantity, 100);
    assert.equal(regexParsed.lineItems[0].unitPrice, 500);
  });

  test('sample INV-099-scanned-sample.pdf falls back to TESSERACT_OCR', async () => {
    const pdfPath = path.resolve(process.cwd(), 'sample-data/invoices/INV-099-scanned-sample.pdf');
    const buffer = fs.readFileSync(pdfPath);
    const textResult = await extractTextFromDocument(buffer, 'application/pdf');

    assert.equal(textResult.method, 'TESSERACT_OCR');
    assert.ok(textResult.text.length > 30);
    assert.ok(textResult.ocrConfidence > 0 && textResult.ocrConfidence <= 1);
  });
});

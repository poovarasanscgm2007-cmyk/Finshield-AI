import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { env } from '../src/config/env.ts';
import { getPool } from '../src/db/pool.ts';
import {
  DuplicateCandidateInput,
  detectDuplicatesForInvoice,
  scoreDuplicateCandidate,
} from '../src/services/duplicateService.ts';
import { evaluateThreeWayMatch, matchInvoice } from '../src/services/matchingService.ts';
import { normalizeInvoiceNumber } from '../src/utils/invoiceNormalizer.ts';

describe('Phase 4 Unit Tests — 3-Way Matching & Duplicate Detection', () => {
  test('Demo scenario: PO-101 100 kg (approved Rs 500 despite unapproved Rs 700), GRN-101 80 kg, INV-101 100 kg => MISMATCH with qty excess reason', () => {
    const result = evaluateThreeWayMatch({
      poNumber: 'PO-101',
      poStatus: 'PARTIALLY_RECEIVED',
      poLines: [
        {
          id: 1,
          description: 'Commercial Timber Wood Logs (Sample)',
          hsnSac: '4403',
          orderedQuantity: 100,
          unit: 'kg',
          approvedUnitPrice: 500,
          currentUnitPrice: 700,
          hasUnapprovedPriceChange: true,
          gstRate: 18,
        },
      ],
      grns: [
        {
          grnId: 1,
          grnNumber: 'GRN-101',
          receivedAt: '2026-11-12T10:00:00Z',
          poLineId: 1,
          description: 'Commercial Timber Wood Logs (Sample)',
          quantityReceived: 80,
          unit: 'kg',
        },
      ],
      invoiceNumber: 'INV-101',
      invoiceSubtotal: 50000,
      invoiceCgst: 4500,
      invoiceSgst: 4500,
      invoiceIgst: 0,
      invoiceTotal: 59000,
      invoiceLines: [
        {
          id: 1,
          description: 'Commercial Timber Wood Logs (Sample)',
          hsnSac: '4403',
          quantity: 100,
          unit: 'kg',
          unitPrice: 500,
          taxRate: 18,
          lineTotal: 50000,
        },
      ],
      qtyTolerancePercent: 2,
      priceTolerancePercent: 2,
    });

    assert.equal(result.status, 'MISMATCH');
    assert.ok(
      result.reasons.includes('Invoice qty 100 exceeds received qty 80 by 20'),
      `Expected excess qty reason, got: ${JSON.stringify(result.reasons)}`
    );
    assert.ok(result.reasons.includes('Pending delivery: 20 not yet received'));
    assert.equal(result.comparedValues.poApprovedUnitPrice, 500);
    assert.equal(result.comparedValues.poUnapprovedPriceChange, true);
    assert.ok(result.comparedValues.mismatchedFields.includes('quantity'));
    assert.equal(result.comparedValues.mismatchedFields.includes('unit_price'), false);
  });

  test('Partial and multiple deliveries: GRN 60 + 40 on different dates vs PO 100 and Invoice 100 => MATCHED', () => {
    const result = evaluateThreeWayMatch({
      poNumber: 'PO-202',
      poStatus: 'FULLY_RECEIVED',
      poLines: [
        {
          id: 2,
          description: 'Industrial Steel Plates',
          hsnSac: '7208',
          orderedQuantity: 100,
          unit: 'kg',
          approvedUnitPrice: 500,
          currentUnitPrice: 500,
          hasUnapprovedPriceChange: false,
          gstRate: 18,
        },
      ],
      grns: [
        {
          grnId: 10,
          grnNumber: 'GRN-202A',
          receivedAt: '2026-11-05T09:00:00Z',
          poLineId: 2,
          description: 'Industrial Steel Plates',
          quantityReceived: 60,
          unit: 'kg',
        },
        {
          grnId: 11,
          grnNumber: 'GRN-202B',
          receivedAt: '2026-11-10T14:30:00Z',
          poLineId: 2,
          description: 'Industrial Steel Plates',
          quantityReceived: 40,
          unit: 'kg',
        },
      ],
      invoiceNumber: 'INV-202',
      invoiceSubtotal: 50000,
      invoiceCgst: 4500,
      invoiceSgst: 4500,
      invoiceIgst: 0,
      invoiceTotal: 59000,
      invoiceLines: [
        {
          id: 20,
          description: 'Industrial Steel Plates',
          hsnSac: '7208',
          quantity: 100,
          unit: 'kg',
          unitPrice: 500,
          taxRate: 18,
          lineTotal: 50000,
        },
      ],
    });

    assert.equal(result.status, 'MATCHED');
    assert.equal(result.comparedValues.grnCount, 2);
    assert.equal(result.comparedValues.grnReceivedQty, 100);
    assert.equal(result.comparedValues.mismatchedFields.length, 0);
  });

  test('Unit price mismatch: Invoice unit price 700 vs approved PO price 500 => MISMATCH with exact reason', () => {
    const result = evaluateThreeWayMatch({
      poNumber: 'PO-101',
      poStatus: 'PARTIALLY_RECEIVED',
      poLines: [
        {
          id: 1,
          description: 'Commercial Timber Wood Logs',
          hsnSac: '4403',
          orderedQuantity: 100,
          unit: 'kg',
          approvedUnitPrice: 500,
          currentUnitPrice: 700,
          hasUnapprovedPriceChange: true,
          gstRate: 18,
        },
      ],
      grns: [
        {
          grnId: 1,
          grnNumber: 'GRN-101',
          receivedAt: '2026-11-12T10:00:00Z',
          poLineId: 1,
          description: 'Commercial Timber Wood Logs',
          quantityReceived: 100,
          unit: 'kg',
        },
      ],
      invoiceNumber: 'INV-700',
      invoiceSubtotal: 70000,
      invoiceCgst: 6300,
      invoiceSgst: 6300,
      invoiceIgst: 0,
      invoiceTotal: 82600,
      invoiceLines: [
        {
          id: 2,
          description: 'Commercial Timber Wood Logs',
          hsnSac: '4403',
          quantity: 100,
          unit: 'kg',
          unitPrice: 700,
          taxRate: 18,
          lineTotal: 70000,
        },
      ],
    });

    assert.equal(result.status, 'MISMATCH');
    assert.ok(result.reasons.includes('Invoice unit price 700 differs from PO price 500'));
    assert.ok(result.comparedValues.mismatchedFields.includes('unit_price'));
  });

  test('Pending delivery HOLD when invoice matches received qty 80 but PO ordered 100', () => {
    const result = evaluateThreeWayMatch({
      poNumber: 'PO-303',
      poStatus: 'PARTIALLY_RECEIVED',
      poLines: [
        {
          id: 3,
          description: 'Copper Wire Spools',
          hsnSac: '7408',
          orderedQuantity: 100,
          unit: 'kg',
          approvedUnitPrice: 500,
          currentUnitPrice: 500,
          hasUnapprovedPriceChange: false,
          gstRate: 18,
        },
      ],
      grns: [
        {
          grnId: 30,
          grnNumber: 'GRN-303',
          receivedAt: '2026-11-14T11:00:00Z',
          poLineId: 3,
          description: 'Copper Wire Spools',
          quantityReceived: 80,
          unit: 'kg',
        },
      ],
      invoiceNumber: 'INV-303',
      invoiceSubtotal: 40000,
      invoiceCgst: 3600,
      invoiceSgst: 3600,
      invoiceIgst: 0,
      invoiceTotal: 47200,
      invoiceLines: [
        {
          id: 30,
          description: 'Copper Wire Spools',
          hsnSac: '7408',
          quantity: 80,
          unit: 'kg',
          unitPrice: 500,
          taxRate: 18,
          lineTotal: 40000,
        },
      ],
    });

    assert.equal(result.status, 'HOLD');
    assert.ok(result.reasons.includes('Pending delivery: 20 not yet received'));
  });

  test('Duplicate detection: INV-123, INV 123, INV_123 from same supplier are flagged as POSSIBLE DUPLICATE', () => {
    const baseInvoice: DuplicateCandidateInput = {
      id: 1,
      invoiceNumber: 'INV-123',
      normalizedInvoiceNumber: normalizeInvoiceNumber('INV-123'),
      irn: null,
      supplierId: 10,
      supplierGstin: '27AABCS5678C1Z9',
      supplierName: 'Supplier A - Timber & Wood Traders',
      invoiceDate: '2026-11-14',
      subtotal: 50000,
      total: 59000,
      status: 'ON_HOLD',
      isHistorical: false,
      lineItems: [{ description: 'Timber Wood Logs', quantity: 100, unitPrice: 500 }],
    };

    const spaceVariant: DuplicateCandidateInput = {
      ...baseInvoice,
      id: 2,
      invoiceNumber: 'INV 123',
      normalizedInvoiceNumber: normalizeInvoiceNumber('INV 123'),
    };

    const underscoreVariant: DuplicateCandidateInput = {
      ...baseInvoice,
      id: 3,
      invoiceNumber: 'INV_123',
      normalizedInvoiceNumber: normalizeInvoiceNumber('INV_123'),
    };

    const resSpace = scoreDuplicateCandidate(baseInvoice, spaceVariant, 0.65);
    const resUnderscore = scoreDuplicateCandidate(baseInvoice, underscoreVariant, 0.65);

    assert.equal(resSpace.isPossibleDuplicate, true);
    assert.ok(resSpace.similarityScore >= 0.65);
    assert.equal(resUnderscore.isPossibleDuplicate, true);
    assert.ok(resUnderscore.similarityScore >= 0.65);
    assert.ok(resUnderscore.reasons.some((r) => r.includes('INV123')));
  });

  test('Duplicate detection: different supplier and different amount with same invoice number is NOT flagged', () => {
    const supplierAInvoice: DuplicateCandidateInput = {
      id: 1,
      invoiceNumber: 'INV-123',
      normalizedInvoiceNumber: 'INV123',
      irn: null,
      supplierId: 10,
      supplierGstin: '27AABCS5678C1Z9',
      supplierName: 'Supplier A - Timber & Wood Traders',
      invoiceDate: '2026-11-14',
      subtotal: 50000,
      total: 59000,
      status: 'VERIFIED',
      isHistorical: false,
      lineItems: [{ description: 'Timber Wood Logs', quantity: 100, unitPrice: 500 }],
    };

    const supplierBInvoice: DuplicateCandidateInput = {
      id: 2,
      invoiceNumber: 'INV-123',
      normalizedInvoiceNumber: 'INV123',
      irn: null,
      supplierId: 20,
      supplierGstin: '27XYZAB9988D1Z2',
      supplierName: 'Supplier B - Packaging Corp',
      invoiceDate: '2026-11-14',
      subtotal: 12000,
      total: 14160,
      status: 'VERIFIED',
      isHistorical: false,
      lineItems: [{ description: 'Corrugated Boxes', quantity: 40, unitPrice: 300 }],
    };

    const scored = scoreDuplicateCandidate(supplierAInvoice, supplierBInvoice, 0.65);
    assert.equal(scored.isPossibleDuplicate, false);
    assert.ok(
      scored.similarityScore < 0.65,
      `Expected score below 0.65 for different supplier & amount, got ${scored.similarityScore}`
    );
  });

  test(
    'Database integration: seeded INV-101 yields MISMATCH/ON_HOLD and detects duplicate INV_101',
    { skip: !env.DATABASE_URL },
    async () => {
      const pool = getPool();
      const invRes = await pool.query<{ id: number }>(
        "SELECT id FROM invoices WHERE invoice_number = 'INV-101' ORDER BY id ASC LIMIT 1"
      );
      assert.ok(invRes.rows[0], 'Seeded INV-101 must exist');
      const invId = invRes.rows[0].id;

      const matchOutcome = await matchInvoice(invId, null);
      assert.equal(matchOutcome.matchResult.status, 'MISMATCH');
      assert.equal(matchOutcome.invoiceStatus, 'ON_HOLD');
      assert.ok(
        matchOutcome.matchResult.reasons.includes('Invoice qty 100 exceeds received qty 80 by 20')
      );

      const dupOutcome = await detectDuplicatesForInvoice(invId);
      assert.equal(dupOutcome.hasPossibleDuplicates, true);
      assert.ok(
        dupOutcome.possibleDuplicates.some((d) => d.candidateInvoiceNumber === 'INV_101')
      );
    }
  );
});

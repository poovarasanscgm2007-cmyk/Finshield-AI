import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { runMigrations } from '../../database/migrate.ts';
import { seedDatabase } from '../../database/seed.ts';
import { env } from '../src/config/env.ts';
import { getPool } from '../src/db/pool.ts';
import { approve } from '../src/services/approvalService.ts';
import { verifyAuditChain } from '../src/services/auditService.ts';
import {
  getAllSupplierScorecards,
  getSupplierRelationshipGraph,
  getSupplierScorecardById,
  maskBankIdentifier,
  requestSupplierBankChange,
} from '../src/services/supplierService.ts';

describe('Phase 6 Unit & Integration Tests — Supplier Graph, Scorecards & Bank Verification', () => {
  test('maskBankIdentifier masks sensitive account digits leaving only last 4 characters', () => {
    assert.equal(maskBankIdentifier('HDFC0001234-8877-SAMPLE'), 'XXXX8877');
    assert.equal(maskBankIdentifier('ICIC0009911-4455'), 'XXXX4455');
    assert.equal(maskBankIdentifier(''), 'XXXX0000');
    assert.equal(maskBankIdentifier(null), 'XXXX0000');
  });

  test(
    'Database integration: Supplier graph SHARED_BANK, non-duplication, scorecards, and bank-change maker-checker',
    { skip: !env.DATABASE_URL },
    async () => {
      const pool = getPool();
      await runMigrations(pool);
      await seedDatabase(pool);

      try {
        // 1. Relationship graph detects SHARED_BANK between SUP-A and SUP-B with verification wording
        const graph1 = await getSupplierRelationshipGraph();
        assert.equal(graph1.isSampleData, true);
        assert.match(graph1.disclaimer, /Relationship requires verification/i);
        assert.ok(graph1.nodes.length >= 2);

        const sharedBankEdge = graph1.edges.find((e) => e.type === 'SHARED_BANK');
        assert.ok(sharedBankEdge, 'Expected SHARED_BANK edge between Supplier A and Supplier B');
        assert.equal(sharedBankEdge.sharedValue, 'XXXX8877');
        assert.match(sharedBankEdge.reason, /Relationship requires verification/i);
        assert.ok(
          sharedBankEdge.linkedInvestigations.some(
            (i) => i.issueType === 'SUPPLIER_RISK' && i.department === 'FINANCE & COMPLIANCE'
          ),
          'Expected linked FINANCE & COMPLIANCE investigation on SHARED_BANK edge'
        );

        // Calling graph twice must NOT duplicate SHARED_BANK risk flags or investigations
        const graph2 = await getSupplierRelationshipGraph();
        const sharedCountBefore = await pool.query<{ cnt: string }>(
          `
          SELECT COUNT(*)::text AS cnt
          FROM investigations
          WHERE issue_type = 'SUPPLIER_RISK'
            AND evidence->>'edgeType' = 'SHARED_BANK';
          `
        );
        assert.equal(Number(sharedCountBefore.rows[0].cnt), 1);
        assert.equal(graph2.edges.filter((e) => e.type === 'SHARED_BANK').length, 1);

        // 2. Supplier scorecards use real PostgreSQL metrics and transparent formulas
        const scorecardsRes = await getAllSupplierScorecards();
        assert.equal(scorecardsRes.isSampleData, true);
        assert.match(scorecardsRes.disclaimer, /performance score/i);
        assert.ok(scorecardsRes.scorecards.length >= 2);

        const supA = scorecardsRes.scorecards.find((s) => s.supplierCode === 'SUP-A');
        assert.ok(supA, 'Expected SUP-A scorecard');
        assert.equal(supA.metrics.length, 6);
        const weightSum = supA.metrics.reduce((acc, m) => acc + m.weight, 0);
        assert.ok(Math.abs(weightSum - 1) < 0.001, 'Metric weights must sum to 1.0');
        assert.ok(supA.overallScore >= 0 && supA.overallScore <= 100);
        assert.match(supA.disclaimer, /not a fraud verdict/i);

        const supADetail = await getSupplierScorecardById(supA.supplierId);
        assert.equal(supADetail.supplierCode, 'SUP-A');
        assert.ok(supADetail.linkedInvoices.length >= 1);

        // 3. Bank change verification enforces maker-checker before updating suppliers.bank_identifier
        const apRes = await pool.query<{ id: number }>(
          "SELECT id FROM users WHERE role = 'AP_EMPLOYEE' LIMIT 1"
        );
        const fmRes = await pool.query<{ id: number }>(
          "SELECT id FROM users WHERE role = 'FINANCE_MANAGER' LIMIT 1"
        );
        const apId = apRes.rows[0].id;
        const fmId = fmRes.rows[0].id;

        const bankReq = await requestSupplierBankChange({
          supplierId: supA.supplierId,
          newBankIdentifier: 'HDFC0009911-4455',
          reason: 'Unit test verified bank change',
          actorId: apId,
          actorRole: 'AP_EMPLOYEE',
        });

        // Bank must remain unchanged until approved
        const unchangedRow = await pool.query<{ bank_identifier: string }>(
          'SELECT bank_identifier FROM suppliers WHERE id = $1',
          [supA.supplierId]
        );
        assert.equal(unchangedRow.rows[0].bank_identifier, 'HDFC0001234-8877-SAMPLE');

        // Self-approval blocked with 403 Maker-checker violation
        await assert.rejects(
          () => approve(Number(bankReq.approval.id), apId, 'AP_EMPLOYEE', 'Self attempt'),
          (err: unknown) => {
            assert.match(String((err as Error).message), /Maker-checker violation/i);
            return true;
          }
        );

        // Different Finance Manager approves -> updates supplier bank identifier
        const approved = await approve(
          Number(bankReq.approval.id),
          fmId,
          'FINANCE_MANAGER',
          'Verified cancelled cheque'
        );
        assert.equal(approved.status, 'APPROVED');

        const updatedRow = await pool.query<{ bank_identifier: string }>(
          'SELECT bank_identifier FROM suppliers WHERE id = $1',
          [supA.supplierId]
        );
        assert.equal(updatedRow.rows[0].bank_identifier, 'HDFC0009911-4455');

        // Audit chain remains valid
        const chain = await verifyAuditChain();
        assert.equal(chain.valid, true);
      } finally {
        await seedDatabase(pool);
      }
    }
  );
});

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { env } from '../src/config/env.ts';
import { getPool } from '../src/db/pool.ts';
import { askCopilot } from '../src/services/copilotService.ts';
import { validateGstin, validateGstTaxType } from '../src/services/gstValidation.ts';
import { createOrCorrectGrn } from '../src/services/grnService.ts';
import {
  approveInvoicePayment,
  canUserMutateInvestigation,
  getDepartmentRuleForIssue,
  listInvestigations,
  syncAndEvaluateInvoice,
  transitionInvestigationStatus,
} from '../src/services/investigationService.ts';

describe('Phase 5 Unit Tests — GST Validation, Department Routing, RBAC & Investigation Rules', () => {
  test('GSTIN validator accepts valid Mod-36 checksum GSTINs and rejects malformed or bad checksum', () => {
    const supA = validateGstin('27AABCS5678C1Z9');
    assert.equal(supA.formatValid, true);
    assert.equal(supA.checksumValid, true);
    assert.equal(supA.stateCode, '27');

    const supB = validateGstin('29AABCB9012D1Z0');
    assert.equal(supB.formatValid, true);
    assert.equal(supB.checksumValid, true);
    assert.equal(supB.stateCode, '29');

    const badChecksum = validateGstin('27AABCS5678C1Z0');
    assert.equal(badChecksum.formatValid, true);
    assert.equal(badChecksum.checksumValid, false);

    const badFormat = validateGstin('INVALID-GST');
    assert.equal(badFormat.formatValid, false);
    assert.equal(badFormat.checksumValid, false);
  });

  test('GST tax head validator enforces intra-state CGST+SGST vs inter-state IGST', () => {
    const intraOk = validateGstTaxType({
      supplierStateCode: '27',
      buyerStateCode: '27',
      cgst: 4500,
      sgst: 4500,
      igst: 0,
    });
    assert.equal(intraOk.valid, true);

    const intraBadIgst = validateGstTaxType({
      supplierStateCode: '27',
      buyerStateCode: '27',
      cgst: 0,
      sgst: 0,
      igst: 9000,
    });
    assert.equal(intraBadIgst.valid, false);
    assert.match(String(intraBadIgst.reason), /Intra-state/i);

    const interOk = validateGstTaxType({
      supplierStateCode: '29',
      buyerStateCode: '27',
      cgst: 0,
      sgst: 0,
      igst: 9000,
    });
    assert.equal(interOk.valid, true);

    const interBadCgst = validateGstTaxType({
      supplierStateCode: '29',
      buyerStateCode: '27',
      cgst: 4500,
      sgst: 4500,
      igst: 0,
    });
    assert.equal(interBadCgst.valid, false);
    assert.match(String(interBadCgst.reason), /Inter-state/i);
  });

  test('Department routing assigns issue types to the exact required departments and roles', () => {
    assert.equal(getDepartmentRuleForIssue('QUANTITY_MISMATCH').department, 'WAREHOUSE');
    assert.deepEqual(getDepartmentRuleForIssue('QUANTITY_MISMATCH').roles, ['WAREHOUSE_EMPLOYEE']);

    assert.equal(getDepartmentRuleForIssue('PRICE_MISMATCH').department, 'PROCUREMENT & FINANCE');
    assert.equal(getDepartmentRuleForIssue('UNAPPROVED_PO_CHANGE').department, 'PROCUREMENT & FINANCE');

    assert.equal(getDepartmentRuleForIssue('POSSIBLE_DUPLICATE').department, 'AP & FINANCE');
    assert.equal(getDepartmentRuleForIssue('REPEATED_OVERBILLING').department, 'AP & FINANCE');

    assert.equal(getDepartmentRuleForIssue('GST_ITC_RISK').department, 'FINANCE & COMPLIANCE');
    assert.deepEqual(getDepartmentRuleForIssue('GST_ITC_RISK').roles, ['FINANCE_MANAGER']);
    assert.equal(getDepartmentRuleForIssue('SUPPLIER_RISK').department, 'FINANCE & COMPLIANCE');
  });

  test('RBAC department guard permits Warehouse on Warehouse cases and denies Finance-only or Admin mutations', () => {
    const whAllowed = canUserMutateInvestigation(3, 'WAREHOUSE_EMPLOYEE', {
      allowed_departments: ['WAREHOUSE'],
      department: 'WAREHOUSE',
      assigned_to: 3,
    });
    assert.equal(whAllowed, true);

    const whDeniedOnFinance = canUserMutateInvestigation(3, 'WAREHOUSE_EMPLOYEE', {
      allowed_departments: ['FINANCE', 'COMPLIANCE'],
      department: 'FINANCE & COMPLIANCE',
      assigned_to: 4,
    });
    assert.equal(whDeniedOnFinance, false);

    const adminDenied = canUserMutateInvestigation(5, 'ADMIN', {
      allowed_departments: ['FINANCE', 'COMPLIANCE'],
      department: 'FINANCE & COMPLIANCE',
      assigned_to: 5,
    });
    assert.equal(adminDenied, false);
  });

  test(
    'Database integration: INV-101 pipeline, RBAC 403, GRN revalidation, payment gate & Copilot grounding',
    { skip: !env.DATABASE_URL },
    async () => {
      const pool = getPool();
      const invRes = await pool.query<{ id: number }>(
        "SELECT id FROM invoices WHERE invoice_number = 'INV-101' AND is_historical = FALSE ORDER BY id ASC LIMIT 1"
      );
      assert.ok(invRes.rows[0], 'Seeded INV-101 must exist');
      const invId = invRes.rows[0].id;

      const usersRes = await pool.query<{ id: number; role: string }>(
        'SELECT id, role FROM users ORDER BY id ASC'
      );
      const userByRole = new Map<string, number>();
      for (const u of usersRes.rows) {
        if (!userByRole.has(u.role)) userByRole.set(u.role, u.id);
      }

      const whId = userByRole.get('WAREHOUSE_EMPLOYEE')!;
      const fmId = userByRole.get('FINANCE_MANAGER')!;

      // Run pipeline idempotently twice and confirm no duplicate investigations
      await syncAndEvaluateInvoice(invId, fmId);
      await syncAndEvaluateInvoice(invId, fmId);

      const invs = await listInvestigations({ invoiceId: invId });
      const issueTypes = invs.map((i) => i.issue_type);
      assert.equal(new Set(issueTypes).size, issueTypes.length, 'No duplicate investigations per invoice+issue');
      assert.ok(issueTypes.includes('QUANTITY_MISMATCH'));
      assert.ok(issueTypes.includes('GST_ITC_RISK'));
      assert.ok(issueTypes.includes('UNAPPROVED_PO_CHANGE'));

      // Warehouse denied on Finance investigation
      const gstInv = invs.find((i) => i.issue_type === 'GST_ITC_RISK')!;
      await assert.rejects(
        () =>
          transitionInvestigationStatus({
            investigationId: gstInv.id,
            actorId: whId,
            actorRole: 'WAREHOUSE_EMPLOYEE',
            targetStatus: 'IN_PROGRESS',
            comment: 'Should fail RBAC',
          }),
        (err: { statusCode?: number }) => err.statusCode === 403
      );

      // Payment blocked while investigations remain OPEN
      await assert.rejects(
        () =>
          approveInvoicePayment({
            invoiceId: invId,
            approverId: fmId,
            approverRole: 'FINANCE_MANAGER',
            level: 2,
          }),
        (err: { statusCode?: number }) => err.statusCode === 409
      );

      // Copilot factual grounding check
      const copilot = await askCopilot({
        question: "Why is Supplier A's invoice flagged?",
        invoiceId: invId,
        actorId: fmId,
        actorRole: 'FINANCE_MANAGER',
      });
      assert.ok(copilot.evidence.length > 0);
      assert.ok(copilot.answer.includes('20'), 'Copilot answer should reference 20 kg gap');
      assert.ok(copilot.answer.includes('500'), 'Copilot answer should reference Rs 500');
      assert.ok(copilot.answer.includes('700'), 'Copilot answer should reference Rs 700');
      assert.ok(/9,?000/.test(copilot.answer), 'Copilot answer should reference Rs 9,000 ITC at risk');

      // Warehouse resolves quantity mismatch after recording missing 20 kg GRN -> REVALIDATED, others stay OPEN
      await createOrCorrectGrn({
        poNumber: 'PO-101',
        quantityReceived: 20,
        unit: 'kg',
        receivedBy: whId,
      });

      const qtyInv = (await listInvestigations({ invoiceId: invId })).find(
        (i) => i.issue_type === 'QUANTITY_MISMATCH'
      )!;
      const resolved = await transitionInvestigationStatus({
        investigationId: qtyInv.id,
        actorId: whId,
        actorRole: 'WAREHOUSE_EMPLOYEE',
        targetStatus: 'RESOLVED',
        comment: 'Remaining 20 kg wood delivered and verified via GRN.',
      });
      assert.equal(resolved.revalidation.outcome, 'REVALIDATED');
      assert.equal(resolved.invoiceStatus, 'ON_HOLD');
    }
  );
});

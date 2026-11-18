import { query } from '../db/pool.ts';
import { getDuplicateFlagsByInvoice } from './duplicateService.ts';

export interface DashboardMetricsResponse {
  cards: {
    totalInvoices: number;
    matchedCount: number;
    mismatchedCount: number;
    possibleDuplicatesCount: number;
    highRiskCount: number;
    pendingInvestigationsCount: number;
    itcAtRiskInr: number;
    eligibleForApprovalCount: number;
    approvedCount: number;
  };
  charts: {
    invoicesByStatus: Array<{ status: string; count: number }>;
    riskLevelDistribution: Array<{ riskLevel: string; count: number }>;
    investigationsByDepartment: Array<{
      department: string;
      openCount: number;
      revalidatedCount: number;
      totalCount: number;
    }>;
  };
  recentAlerts: Array<{
    flagId: number;
    invoiceId: number;
    invoiceNumber: string | null;
    supplierName: string | null;
    ruleCode: string;
    severity: string;
    reason: string;
    score: number;
    invoiceStatus: string;
    riskLevel: string;
    createdAt: string;
  }>;
}

export async function getDashboardMetrics(): Promise<DashboardMetricsResponse> {
  const [summaryRes, statusRes, riskRes, deptRes, alertsRes, duplicateFlags] = await Promise.all([
    query<{
      total_invoices: string;
      matched_count: string;
      mismatched_count: string;
      high_risk_count: string;
      pending_investigations_count: string;
      itc_at_risk_inr: string;
      eligible_count: string;
      approved_count: string;
    }>(
      `
      SELECT
        (SELECT COUNT(*) FROM invoices)::text AS total_invoices,
        (
          SELECT COUNT(*)
          FROM invoices i
          LEFT JOIN LATERAL (
            SELECT m.status
            FROM match_results m
            WHERE m.invoice_id = i.id
            ORDER BY m.evaluated_at DESC, m.id DESC
            LIMIT 1
          ) mr ON TRUE
          WHERE COALESCE(mr.status, i.status) = 'MATCHED' OR i.status IN ('ELIGIBLE_FOR_APPROVAL', 'APPROVED', 'PAID')
        )::text AS matched_count,
        (
          SELECT COUNT(*)
          FROM invoices i
          LEFT JOIN LATERAL (
            SELECT m.status
            FROM match_results m
            WHERE m.invoice_id = i.id
            ORDER BY m.evaluated_at DESC, m.id DESC
            LIMIT 1
          ) mr ON TRUE
          WHERE mr.status = 'MISMATCH'
        )::text AS mismatched_count,
        (
          SELECT COUNT(*)
          FROM invoices
          WHERE risk_level IN ('HIGH', 'CRITICAL')
        )::text AS high_risk_count,
        (
          SELECT COUNT(*)
          FROM investigations
          WHERE status IN ('OPEN', 'IN_PROGRESS', 'REOPENED', 'RESOLVED')
        )::text AS pending_investigations_count,
        (
          SELECT COALESCE(SUM(itc_at_risk), 0)
          FROM invoices
        )::text AS itc_at_risk_inr,
        (
          SELECT COUNT(*)
          FROM invoices
          WHERE status = 'ELIGIBLE_FOR_APPROVAL'
        )::text AS eligible_count,
        (
          SELECT COUNT(*)
          FROM invoices
          WHERE status IN ('APPROVED', 'PAID')
        )::text AS approved_count;
      `
    ),
    query<{ status: string; count: string }>(
      `
      SELECT status, COUNT(*)::text AS count
      FROM invoices
      GROUP BY status
      ORDER BY COUNT(*) DESC, status ASC;
      `
    ),
    query<{ risk_level: string; count: string }>(
      `
      SELECT risk_level, COUNT(*)::text AS count
      FROM invoices
      GROUP BY risk_level
      ORDER BY
        CASE risk_level
          WHEN 'CRITICAL' THEN 0
          WHEN 'HIGH' THEN 1
          WHEN 'MEDIUM' THEN 2
          ELSE 3
        END;
      `
    ),
    query<{
      department: string;
      open_count: string;
      revalidated_count: string;
      total_count: string;
    }>(
      `
      SELECT
        department,
        COUNT(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS', 'REOPENED', 'RESOLVED'))::text AS open_count,
        COUNT(*) FILTER (WHERE status = 'REVALIDATED')::text AS revalidated_count,
        COUNT(*)::text AS total_count
      FROM investigations
      GROUP BY department
      ORDER BY COUNT(*) DESC, department ASC;
      `
    ),
    query<{
      flag_id: number;
      invoice_id: number;
      invoice_number: string | null;
      supplier_name: string | null;
      rule_code: string;
      severity: string;
      reason: string;
      score: string;
      invoice_status: string;
      risk_level: string;
      created_at: string;
    }>(
      `
      SELECT
        rf.id AS flag_id,
        rf.entity_id AS invoice_id,
        i.invoice_number,
        COALESCE(s.name, i.supplier_name_extracted) AS supplier_name,
        rf.rule_code,
        rf.severity,
        rf.reason,
        rf.score,
        i.status AS invoice_status,
        i.risk_level,
        rf.created_at
      FROM risk_flags rf
      JOIN invoices i ON i.id = rf.entity_id
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE rf.entity_type = 'invoice'
        AND rf.is_resolved = FALSE
      ORDER BY
        CASE rf.severity
          WHEN 'CRITICAL' THEN 0
          WHEN 'HIGH' THEN 1
          WHEN 'MEDIUM' THEN 2
          ELSE 3
        END,
        rf.created_at DESC,
        rf.id DESC
      LIMIT 12;
      `
    ),
    getDuplicateFlagsByInvoice(),
  ]);

  let possibleDuplicatesCount = 0;
  for (const val of duplicateFlags.values()) {
    if (val.isPossibleDuplicate) possibleDuplicatesCount++;
  }

  const s = summaryRes.rows[0];

  return {
    cards: {
      totalInvoices: Number(s?.total_invoices || 0),
      matchedCount: Number(s?.matched_count || 0),
      mismatchedCount: Number(s?.mismatched_count || 0),
      possibleDuplicatesCount,
      highRiskCount: Number(s?.high_risk_count || 0),
      pendingInvestigationsCount: Number(s?.pending_investigations_count || 0),
      itcAtRiskInr: Number(Number(s?.itc_at_risk_inr || 0).toFixed(2)),
      eligibleForApprovalCount: Number(s?.eligible_count || 0),
      approvedCount: Number(s?.approved_count || 0),
    },
    charts: {
      invoicesByStatus: statusRes.rows.map((r) => ({
        status: r.status,
        count: Number(r.count),
      })),
      riskLevelDistribution: riskRes.rows.map((r) => ({
        riskLevel: r.risk_level,
        count: Number(r.count),
      })),
      investigationsByDepartment: deptRes.rows.map((r) => ({
        department: r.department,
        openCount: Number(r.open_count),
        revalidatedCount: Number(r.revalidated_count),
        totalCount: Number(r.total_count),
      })),
    },
    recentAlerts: alertsRes.rows.map((r) => ({
      flagId: r.flag_id,
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number,
      supplierName: r.supplier_name,
      ruleCode: r.rule_code,
      severity: r.severity,
      reason: r.reason,
      score: Number(r.score),
      invoiceStatus: r.invoice_status,
      riskLevel: r.risk_level,
      createdAt: r.created_at,
    })),
  };
}

import { getPool, query } from '../db/pool.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import { writeAuditLog } from './auditService.ts';
import { syncAndEvaluateInvoice } from './investigationService.ts';

export interface GrnListRow {
  id: number;
  grn_number: string;
  po_id: number;
  po_number: string;
  supplier_name: string;
  received_by: number | null;
  received_by_name: string | null;
  received_at: string;
  warehouse_location: string | null;
  status: string;
  total_quantity_received: string;
  unit: string;
}

export async function listGrns(): Promise<GrnListRow[]> {
  const res = await query<GrnListRow>(
    `
    SELECT
      g.id,
      g.grn_number,
      g.po_id,
      po.po_number,
      s.name AS supplier_name,
      g.received_by,
      u.name AS received_by_name,
      g.received_at,
      g.warehouse_location,
      g.status,
      COALESCE(SUM(gl.quantity_received), 0)::text AS total_quantity_received,
      COALESCE(MAX(gl.unit), 'kg') AS unit
    FROM grns g
    JOIN purchase_orders po ON po.id = g.po_id
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN users u ON u.id = g.received_by
    LEFT JOIN grn_lines gl ON gl.grn_id = g.id
    GROUP BY g.id, po.po_number, s.name, u.name
    ORDER BY g.id DESC;
    `
  );
  return res.rows;
}

export async function createOrCorrectGrn(params: {
  poId?: number;
  poNumber?: string;
  grnNumber?: string;
  quantityReceived: number;
  unit?: string;
  warehouseLocation?: string;
  replacesGrnId?: number | null;
  isCorrection?: boolean;
  receivedBy: number;
}): Promise<{
  grn: { id: number; grn_number: string; po_id: number; status: string };
  quantityReceived: number;
  reEvaluatedInvoices: Array<{ invoiceId: number; invoiceStatus: string }>;
}> {
  if (!Number.isFinite(params.quantityReceived) || params.quantityReceived <= 0) {
    throw new HttpError(400, 'quantityReceived must be a positive number.');
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let poRow: { id: number; po_number: string } | undefined;
    if (params.poId) {
      const r = await client.query<{ id: number; po_number: string }>(
        'SELECT id, po_number FROM purchase_orders WHERE id = $1 LIMIT 1',
        [params.poId]
      );
      poRow = r.rows[0];
    } else if (params.poNumber) {
      const r = await client.query<{ id: number; po_number: string }>(
        'SELECT id, po_number FROM purchase_orders WHERE UPPER(po_number) = $1 LIMIT 1',
        [params.poNumber.trim().toUpperCase()]
      );
      poRow = r.rows[0];
    }

    if (!poRow) {
      throw new HttpError(404, 'Purchase order not found for GRN.');
    }

    const poLineRes = await client.query<{
      id: number;
      description: string;
      unit: string;
      current_quantity: string;
    }>(
      'SELECT id, description, unit, current_quantity FROM po_lines WHERE po_id = $1 ORDER BY line_number ASC LIMIT 1',
      [poRow.id]
    );
    const poLine = poLineRes.rows[0];
    if (!poLine) {
      throw new HttpError(404, `No PO lines found for ${poRow.po_number}.`);
    }

    // If replacing/correcting an earlier GRN, mark prior active GRNs on this PO SUPERSEDED
    if (params.replacesGrnId) {
      await client.query("UPDATE grns SET status = 'SUPERSEDED' WHERE id = $1 AND po_id = $2", [
        params.replacesGrnId,
        poRow.id,
      ]);
    } else if (params.isCorrection) {
      await client.query(
        "UPDATE grns SET status = 'SUPERSEDED' WHERE po_id = $1 AND COALESCE(status, 'RECEIVED') <> 'SUPERSEDED'",
        [poRow.id]
      );
    }

    const grnNumber =
      params.grnNumber?.trim() ||
      `GRN-${poRow.po_number.replace(/[^0-9A-Z]/gi, '')}-${Date.now().toString().slice(-4)}`;

    const totalBeforeRes = await client.query<{ total: string }>(
      `
      SELECT COALESCE(SUM(gl.quantity_received), 0)::text AS total
      FROM grns g
      JOIN grn_lines gl ON gl.grn_id = g.id
      WHERE g.po_id = $1 AND COALESCE(g.status, 'RECEIVED') <> 'SUPERSEDED';
      `,
      [poRow.id]
    );
    const priorActiveQty = Number(totalBeforeRes.rows[0]?.total || 0);
    const newCumulative = priorActiveQty + params.quantityReceived;
    const orderedQty = Number(poLine.current_quantity);
    const grnStatus = newCumulative >= orderedQty ? 'RECEIVED' : 'PARTIAL_RECEIVED';

    const insertGrn = await client.query<{
      id: number;
      grn_number: string;
      po_id: number;
      status: string;
    }>(
      `
      INSERT INTO grns (
        grn_number, po_id, received_by, received_at, warehouse_location, status, is_sample_data
      )
      VALUES ($1, $2, $3, NOW(), $4, $5, TRUE)
      RETURNING id, grn_number, po_id, status;
      `,
      [
        grnNumber,
        poRow.id,
        params.receivedBy,
        params.warehouseLocation?.trim() || 'Pune Plant Bay-2 (Warehouse Entry)',
        grnStatus,
      ]
    );

    const grn = insertGrn.rows[0];

    await client.query(
      `
      INSERT INTO grn_lines (grn_id, po_line_id, description, quantity_received, unit, is_sample_data)
      VALUES ($1, $2, $3, $4, $5, TRUE);
      `,
      [
        grn.id,
        poLine.id,
        poLine.description,
        params.quantityReceived,
        params.unit || poLine.unit || 'kg',
      ]
    );

    await writeAuditLog(
      params.receivedBy,
      params.isCorrection ? 'GRN_CORRECTED' : 'GRN_CREATED',
      'grns',
      grn.id,
      {
        grnNumber: grn.grn_number,
        poNumber: poRow.po_number,
        quantityReceived: params.quantityReceived,
        isCorrection: Boolean(params.isCorrection),
        cumulativeActiveQty: newCumulative,
      },
      client
    );

    // Find linked non-historical invoices for this PO to re-run matching/risk pipeline
    const linkedInvRes = await client.query<{ id: number }>(
      'SELECT id FROM invoices WHERE po_id = $1 AND is_historical = FALSE ORDER BY id ASC',
      [poRow.id]
    );

    const reEvaluatedInvoices: Array<{ invoiceId: number; invoiceStatus: string }> = [];
    for (const inv of linkedInvRes.rows) {
      const outcome = await syncAndEvaluateInvoice(inv.id, params.receivedBy, client);
      reEvaluatedInvoices.push({
        invoiceId: inv.id,
        invoiceStatus: outcome.invoiceStatus,
      });
    }

    await client.query('COMMIT');
    return {
      grn,
      quantityReceived: params.quantityReceived,
      reEvaluatedInvoices,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

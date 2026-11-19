import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import { Pool } from 'pg';
import { fileURLToPath } from 'url';
import { computeAuditHash, GENESIS_HASH } from '../backend/src/audit/hashChain.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../backend/.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const SAMPLE_DEMO_USERS = [
  {
    employeeCode: 'EMP-101',
    name: 'Aarav Mehta (Sample AP Employee)',
    email: 'ap.employee@abcmfg.sample',
    password: 'SamplePass@101',
    role: 'AP_EMPLOYEE',
    department: 'Accounts Payable',
  },
  {
    employeeCode: 'EMP-102',
    name: 'Employee 102',
    email: 'employee102@abcmfg.sample',
    password: 'SamplePass@102',
    role: 'PROCUREMENT_EMPLOYEE',
    department: 'Procurement',
  },
  {
    employeeCode: 'EMP-103',
    name: 'Rohan Verma (Sample Warehouse Employee)',
    email: 'warehouse@abcmfg.sample',
    password: 'SamplePass@103',
    role: 'WAREHOUSE_EMPLOYEE',
    department: 'Warehouse',
  },
  {
    employeeCode: 'EMP-104',
    name: 'Priya Nair (Sample Finance Manager)',
    email: 'finance.manager@abcmfg.sample',
    password: 'SamplePass@104',
    role: 'FINANCE_MANAGER',
    department: 'Finance',
  },
  {
    employeeCode: 'EMP-105',
    name: 'Vikram Rao (Sample Admin)',
    email: 'admin@abcmfg.sample',
    password: 'SamplePass@105',
    role: 'ADMIN',
    department: 'Administration',
  },
] as const;

export async function seedDatabase(externalPool?: Pool): Promise<void> {
  const ownsPool = !externalPool;
  let pool = externalPool;

  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not set. Please configure .env before seeding.');
    }
    pool = new Pool({ connectionString: databaseUrl });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Clear existing sample data cleanly so the seed script is idempotent
    await client.query(`
      TRUNCATE TABLE
        audit_log,
        investigations,
        risk_flags,
        match_results,
        gstr2b_records,
        invoice_lines,
        invoices,
        grn_lines,
        grns,
        po_change_history,
        approvals,
        po_lines,
        purchase_orders,
        suppliers,
        users,
        risk_rules_config
      RESTART IDENTITY CASCADE;
    `);

    // 1. Seed 5 sample users (one per role, including Employee 102) with bcrypt-hashed demo passwords
    const userByCode = new Map<string, number>();
    for (const u of SAMPLE_DEMO_USERS) {
      const passwordHash = await bcrypt.hash(u.password, 10);
      const inserted = await client.query<{ id: number }>(
        `
        INSERT INTO users (employee_code, name, email, password_hash, role, department, is_sample_data)
        VALUES ($1, $2, $3, $4, $5, $6, TRUE)
        RETURNING id;
        `,
        [u.employeeCode, u.name, u.email, passwordHash, u.role, u.department]
      );
      userByCode.set(u.employeeCode, inserted.rows[0].id);
    }

    const apUserId = userByCode.get('EMP-101')!;
    const emp102Id = userByCode.get('EMP-102')!;
    const warehouseUserId = userByCode.get('EMP-103')!;

    // 2. Seed Supplier A and Supplier B sharing the same bank_identifier (Sample data)
    const sharedBankId = 'HDFC0001234-8877-SAMPLE';
    const suppliersRes = await client.query<{
      id: number;
      supplier_code: string;
      gstin: string;
      name: string;
    }>(
      `
      INSERT INTO suppliers (
        supplier_code, name, gstin, pan, state_code, bank_identifier, address, phone, gst_filing_status, is_sample_data
      )
      VALUES
        (
          'SUP-A',
          'Supplier A - Timber & Wood Traders (Sample)',
          '27AABCS5678C1Z9',
          'AABCS5678C',
          '27',
          $1,
          'Plot 14, Timber Market MIDC, Pune, Maharashtra 411026 (Sample Address)',
          '+91-98200-11101',
          'DELAYED_FILER',
          TRUE
        ),
        (
          'SUP-B',
          'Supplier B - Deccan Packaging & Crates (Sample)',
          '29AABCB9012D1Z0',
          'AABCB9012D',
          '29',
          $1,
          'Unit 8, Peenya Industrial Area, Bengaluru, Karnataka 560058 (Sample Address)',
          '+91-98450-22202',
          'REGULAR',
          TRUE
        )
      RETURNING id, supplier_code, gstin, name;
      `,
      [sharedBankId]
    );

    const supplierA = suppliersRes.rows.find((s) => s.supplier_code === 'SUP-A')!;
    const supplierB = suppliersRes.rows.find((s) => s.supplier_code === 'SUP-B')!;

    // 3. Seed PO-101 for ABC Manufacturing (sample):
    // Original: 100 kg wood @ Rs 500/kg = Rs 50,000.00 subtotal.
    // Unapproved modification: Rs 500/kg -> Rs 700/kg by Employee 102, no approval record.
    const buyerGstin = '27AABCA1234B1ZH';
    const buyerStateCode = '27';

    const poRes = await client.query<{ id: number }>(
      `
      INSERT INTO purchase_orders (
        po_number, supplier_id, buyer_company, buyer_gstin, buyer_state_code,
        status, original_total, current_total, created_by, is_sample_data
      )
      VALUES (
        'PO-101', $1, 'ABC Manufacturing (Sample)', $2, $3,
        'MODIFIED_UNAPPROVED', 50000.00, 70000.00, $4, TRUE
      )
      RETURNING id;
      `,
      [supplierA.id, buyerGstin, buyerStateCode, emp102Id]
    );
    const po101Id = poRes.rows[0].id;

    const poLineRes = await client.query<{ id: number }>(
      `
      INSERT INTO po_lines (
        po_id, line_number, item_code, description, hsn_sac,
        original_quantity, current_quantity, unit,
        original_unit_price, current_unit_price, gst_rate, is_sample_data
      )
      VALUES (
        $1, 1, 'MAT-WOOD-01', 'Industrial Hardwood Timber (Sample)', '4403',
        100.000, 100.000, 'kg',
        500.00, 700.00, 18.00, TRUE
      )
      RETURNING id;
      `,
      [po101Id]
    );
    const po101LineId = poLineRes.rows[0].id;

    // 4. Seed PO-101 price change history: Rs 500 -> Rs 700 by Employee 102, NO approval record (status = UNAPPROVED)
    await client.query(
      `
      INSERT INTO po_change_history (
        po_id, po_line_id, changed_by, changed_at, field, old_value, new_value, approval_id, status, reason, is_sample_data
      )
      VALUES (
        $1, $2, $3, NOW() - INTERVAL '2 days', 'unit_price', '500.00', '700.00', NULL, 'UNAPPROVED',
        'Sample unapproved price modification from Rs 500/kg to Rs 700/kg by Employee 102', TRUE
      );
      `,
      [po101Id, po101LineId, emp102Id]
    );

    // 5. Seed GRN-101 for PO-101: 80 kg received
    const grnRes = await client.query<{ id: number }>(
      `
      INSERT INTO grns (
        grn_number, po_id, received_by, received_at, warehouse_location, status, is_sample_data
      )
      VALUES (
        'GRN-101', $1, $2, NOW() - INTERVAL '1 day', 'Pune Plant Bay-2 (Sample)', 'PARTIAL_RECEIVED', TRUE
      )
      RETURNING id;
      `,
      [po101Id, warehouseUserId]
    );
    const grn101Id = grnRes.rows[0].id;

    await client.query(
      `
      INSERT INTO grn_lines (
        grn_id, po_line_id, description, quantity_received, unit, is_sample_data
      )
      VALUES (
        $1, $2, 'Industrial Hardwood Timber (Sample)', 80.000, 'kg', TRUE
      );
      `,
      [grn101Id, po101LineId]
    );

    // 6. Seed INV-101: 100 kg billed @ Rs 500/kg
    const inv101Res = await client.query<{ id: number }>(
      `
      INSERT INTO invoices (
        invoice_number, normalized_invoice_number, irn, supplier_id, po_id, invoice_date,
        subtotal, cgst, sgst, igst, extra_charges, total, status,
        extraction_confidence, file_path, uploaded_by, is_historical, is_sample_data
      )
      VALUES (
        'INV-101', 'INV101', 'IRN-SAMPLE-2026-INV101-A98F', $1, $2, CURRENT_DATE,
        50000.00, 4500.00, 4500.00, 0.00, 0.00, 59000.00, 'PENDING_REVIEW',
        '{"invoice_number": 0.99, "supplier_gstin": 0.97, "quantity": 0.95, "unit_price": 0.96, "total": 0.98}'::jsonb,
        'sample-data/INV-101-sample.pdf', $3, FALSE, TRUE
      )
      RETURNING id;
      `,
      [supplierA.id, po101Id, apUserId]
    );
    const inv101Id = inv101Res.rows[0].id;

    await client.query(
      `
      INSERT INTO invoice_lines (
        invoice_id, line_number, description, hsn_sac, quantity, unit,
        unit_price, extra_charge, tax_rate, line_total, is_sample_data
      )
      VALUES (
        $1, 1, 'Industrial Hardwood Timber (Sample)', '4403', 100.000, 'kg',
        500.00, 0.00, 18.00, 59000.00, TRUE
      );
      `,
      [inv101Id]
    );

    // 6b. Seed duplicate sample case: INV_101 re-submitted by Supplier A (same normalized_invoice_number INV101)
    const inv101DupRes = await client.query<{ id: number }>(
      `
      INSERT INTO invoices (
        invoice_number, normalized_invoice_number, irn, supplier_id, po_id, invoice_date,
        subtotal, cgst, sgst, igst, extra_charges, total, status,
        extraction_confidence, file_path, original_filename, uploaded_by, is_historical, is_sample_data
      )
      VALUES (
        'INV_101', 'INV101', 'IRN-SAMPLE-2026-INV101-A98F', $1, $2, CURRENT_DATE,
        50000.00, 4500.00, 4500.00, 0.00, 0.00, 59000.00, 'PENDING_REVIEW',
        '{"invoice_number": 0.96, "supplier_gstin": 0.96, "quantity": 0.95, "unit_price": 0.96, "total": 0.97}'::jsonb,
        'sample-data/INV_101-duplicate-sample.pdf', 'INV_101-duplicate-sample (Sample Data).pdf', $3, FALSE, TRUE
      )
      RETURNING id;
      `,
      [supplierA.id, po101Id, apUserId]
    );
    const inv101DupId = inv101DupRes.rows[0].id;

    await client.query(
      `
      INSERT INTO invoice_lines (
        invoice_id, line_number, description, hsn_sac, quantity, unit,
        unit_price, extra_charge, tax_rate, line_total, is_sample_data
      )
      VALUES (
        $1, 1, 'Industrial Hardwood Timber (Sample)', '4403', 100.000, 'kg',
        500.00, 0.00, 18.00, 59000.00, TRUE
      );
      `,
      [inv101DupId]
    );

    // 7. Seed 9 historical invoices for Supplier A (INV-091..INV-099) with repeated extra charges
    const historicalInvoices = [
      { num: 'INV-091', norm: 'INV091', daysAgo: 90, qty: 60, price: 480, extra: 500, extraLabel: 'Unloading & Handling Surcharge (Sample)' },
      { num: 'INV-092', norm: 'INV092', daysAgo: 80, qty: 80, price: 485, extra: 700, extraLabel: 'Special Packaging Fee (Sample)' },
      { num: 'INV-093', norm: 'INV093', daysAgo: 70, qty: 50, price: 490, extra: 1000, extraLabel: 'Urgent Dispatch Surcharge (Sample)' },
      { num: 'INV-094', norm: 'INV094', daysAgo: 60, qty: 100, price: 490, extra: 500, extraLabel: 'Fuel Adjustment Charge (Sample)' },
      { num: 'INV-095', norm: 'INV095', daysAgo: 50, qty: 75, price: 495, extra: 700, extraLabel: 'Yard Weighbridge Fee (Sample)' },
      { num: 'INV-096', norm: 'INV096', daysAgo: 40, qty: 90, price: 495, extra: 1000, extraLabel: 'Misc Freight Surcharge (Sample)' },
      { num: 'INV-097', norm: 'INV097', daysAgo: 30, qty: 70, price: 500, extra: 500, extraLabel: 'Moisture Treatment Fee (Sample)' },
      { num: 'INV-098', norm: 'INV098', daysAgo: 20, qty: 85, price: 500, extra: 700, extraLabel: 'Dock Handling Fee (Sample)' },
      { num: 'INV-099', norm: 'INV099', daysAgo: 10, qty: 95, price: 500, extra: 1000, extraLabel: 'Expedited Freight Surcharge (Sample)' },
    ];

    for (const h of historicalInvoices) {
      const baseAmount = h.qty * h.price;
      const taxableSubtotal = baseAmount + h.extra;
      const cgst = Number((taxableSubtotal * 0.09).toFixed(2));
      const sgst = Number((taxableSubtotal * 0.09).toFixed(2));
      const total = Number((taxableSubtotal + cgst + sgst).toFixed(2));

      const histInvRes = await client.query<{ id: number }>(
        `
        INSERT INTO invoices (
          invoice_number, normalized_invoice_number, irn, supplier_id, po_id, invoice_date,
          subtotal, cgst, sgst, igst, extra_charges, total, status,
          extraction_confidence, file_path, uploaded_by, is_historical, is_sample_data
        )
        VALUES (
          $1, $2, $3, $4, NULL, CURRENT_DATE - ($5 || ' days')::interval,
          $6, $7, $8, 0.00, $9, $10, 'PAID',
          '{"invoice_number": 0.99, "supplier_gstin": 0.99, "quantity": 0.98, "unit_price": 0.98, "total": 0.99}'::jsonb,
          $11, $12, TRUE, TRUE
        )
        RETURNING id;
        `,
        [
          h.num,
          h.norm,
          `IRN-SAMPLE-2026-${h.norm}`,
          supplierA.id,
          String(h.daysAgo),
          taxableSubtotal,
          cgst,
          sgst,
          h.extra,
          total,
          `sample-data/${h.num}-sample.pdf`,
          apUserId,
        ]
      );

      const histInvId = histInvRes.rows[0].id;

      await client.query(
        `
        INSERT INTO invoice_lines (
          invoice_id, line_number, description, hsn_sac, quantity, unit,
          unit_price, extra_charge, tax_rate, line_total, is_sample_data
        )
        VALUES
          ($1, 1, 'Industrial Hardwood Timber (Sample)', '4403', $2, 'kg', $3, 0.00, 18.00, $4, TRUE),
          ($1, 2, $5, '9965', 1.000, 'lot', $6, $6, 18.00, $7, TRUE);
        `,
        [
          histInvId,
          h.qty,
          h.price,
          Number((baseAmount * 1.18).toFixed(2)),
          h.extraLabel,
          h.extra,
          Number((h.extra * 1.18).toFixed(2)),
        ]
      );

      await client.query(
        `
        INSERT INTO gstr2b_records (
          return_period, supplier_gstin, supplier_name, invoice_number, normalized_invoice_number,
          invoice_date, taxable_value, cgst, sgst, igst, itc_available, irn, is_sample_data
        )
        VALUES (
          TO_CHAR(CURRENT_DATE - ($1 || ' days')::interval, 'MMYYYY'),
          $2, $3, $4, $5,
          CURRENT_DATE - ($1 || ' days')::interval,
          $6, $7, $8, 0.00, TRUE, $9, TRUE
        );
        `,
        [
          String(h.daysAgo),
          supplierA.gstin,
          supplierA.name,
          h.num,
          h.norm,
          taxableSubtotal,
          cgst,
          sgst,
          `IRN-SAMPLE-2026-${h.norm}`,
        ]
      );
    }

    await client.query(
      `
      INSERT INTO gstr2b_records (
        return_period, supplier_gstin, supplier_name, invoice_number, normalized_invoice_number,
        invoice_date, taxable_value, cgst, sgst, igst, itc_available, irn, is_sample_data
      )
      VALUES (
        TO_CHAR(CURRENT_DATE - INTERVAL '15 days', 'MMYYYY'),
        $1, $2, 'SUPB-201', 'SUPB201',
        CURRENT_DATE - INTERVAL '15 days',
        25000.00, 0.00, 0.00, 4500.00, TRUE, 'IRN-SAMPLE-2026-SUPB201', TRUE
      );
      `,
      [supplierB.gstin, supplierB.name]
    );

    // 8. Seed default risk_rules_config
    await client.query(`
      INSERT INTO risk_rules_config (rule_code, rule_name, description, weight, threshold, is_active, is_sample_data)
      VALUES
        ('QTY_MISMATCH', '3-Way Quantity Mismatch', 'Flags invoice quantity exceeding summed GRN received quantity beyond tolerance %', 25.00, 2.0000, TRUE, TRUE),
        ('PRICE_MISMATCH', '3-Way Unit Price Mismatch', 'Flags invoice unit price deviating from approved PO price beyond tolerance %', 20.00, 2.0000, TRUE, TRUE),
        ('UNAPPROVED_PO_CHANGE', 'Unapproved PO Modification', 'Flags purchase order price or quantity edits lacking an approval record', 25.00, 1.0000, TRUE, TRUE),
        ('DUPLICATE_INVOICE', 'Possible Duplicate Invoice', 'Flags normalized invoice number, IRN, or composite line similarity matches', 20.00, 0.6500, TRUE, TRUE),
        ('HISTORICAL_OVERBILLING', 'Historical Extra Charges / Overbilling', 'Flags suppliers with repeated extra charges or unusual price drift across past invoices', 15.00, 3.0000, TRUE, TRUE),
        ('GSTIN_INVALID', 'Invalid GSTIN / Checksum', 'Flags GSTIN format or Mod-36 checksum verification failure', 20.00, 1.0000, TRUE, TRUE),
        ('GST_TAX_TYPE_MISMATCH', 'CGST/SGST vs IGST Mismatch', 'Flags intra-state vs inter-state GST tax head discrepancies', 15.00, 0.0100, TRUE, TRUE),
        ('GSTR2B_MISSING', 'Missing in GSTR-2B (ITC at Risk)', 'Flags invoices absent from GSTR-2B putting Input Tax Credit at risk', 20.00, 1.0000, TRUE, TRUE),
        ('SHARED_BANK_IDENTIFIER', 'Shared Supplier Bank Identifier', 'Flags multiple suppliers sharing a common bank account identifier for verification', 15.00, 2.0000, TRUE, TRUE),
        ('SUPPLIER_FILING_RISK', 'Supplier GST Filing Status Risk', 'Flags suppliers with delayed or suspended GST return filing status', 15.00, 1.0000, TRUE, TRUE);
    `);

    // 9. Seed initial hash-chained audit_log entries using canonical SHA-256 chain
    const ts1 = new Date().toISOString();
    const payload1 = {
      note: 'Sample dataset initialized for ABC Manufacturing (Sample)',
      entities: ['PO-101', 'GRN-101', 'INV-101', 'SUP-A', 'SUP-B'],
      is_sample_data: true,
    };
    const hash1 = computeAuditHash({
      prevHash: GENESIS_HASH,
      actorId: null,
      action: 'SEED_INITIALIZED',
      entity: 'SYSTEM',
      entityId: 'PHASE_2',
      payload: payload1,
      createdAtIso: ts1,
    });

    await client.query(
      `
      INSERT INTO audit_log (actor_id, action, entity, entity_id, payload, prev_hash, hash, is_sample_data, created_at)
      VALUES (NULL, 'SEED_INITIALIZED', 'SYSTEM', 'PHASE_2', $1::jsonb, $2, $3, TRUE, $4::timestamptz);
      `,
      [JSON.stringify(payload1), GENESIS_HASH, hash1, ts1]
    );

    const ts2 = new Date(Date.now() + 1).toISOString();
    const payload2 = {
      po_number: 'PO-101',
      field: 'unit_price',
      old_value: '500.00',
      new_value: '700.00',
      approval_id: null,
      status: 'UNAPPROVED',
      is_sample_data: true,
    };
    const hash2 = computeAuditHash({
      prevHash: hash1,
      actorId: emp102Id,
      action: 'PO_MODIFIED',
      entity: 'purchase_orders',
      entityId: String(po101Id),
      payload: payload2,
      createdAtIso: ts2,
    });

    await client.query(
      `
      INSERT INTO audit_log (actor_id, action, entity, entity_id, payload, prev_hash, hash, is_sample_data, created_at)
      VALUES ($1, 'PO_MODIFIED', 'purchase_orders', $2, $3::jsonb, $4, $5, TRUE, $6::timestamptz);
      `,
      [emp102Id, String(po101Id), JSON.stringify(payload2), hash1, hash2, ts2]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    if (ownsPool) {
      await pool.end();
    }
  }
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  seedDatabase()
    .then(() => {
      console.log('Seed completed successfully: ABC Manufacturing sample scenario loaded with bcrypt passwords.');
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}

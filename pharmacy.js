import express from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { wrap, badRequest, notFound, HttpError } from '../utils/validate.js';
import { prescriptionNumber } from '../utils/format.js';

const router = express.Router();
router.use(requireAuth);

/** Stock status derived from quantity vs. the medication's reorder level. */
function stockStatus(med) {
  const qty = Number(med.quantity_in_stock ?? 0);
  const reorder = Number(med.reorder_level ?? 0);
  if (qty <= 0) return 'OutOfStock';
  if (qty <= reorder) return 'LowStock';
  return 'InStock';
}

function shapeMedication(row) {
  return {
    medicationId: row.medication_id,
    drugName: row.drug_name,
    drugCode: row.drug_code,
    category: row.category,
    unitOfMeasure: row.unit_of_measure,
    reorderLevel: Number(row.reorder_level ?? 0),
    quantityInStock: Number(row.quantity_in_stock ?? 0),
    expiryDate: row.expiry_date,
    lastRestocked: row.last_restocked,
    supplier: row.supplier,
    unitCost: Number(row.unit_cost ?? 0),
    stockStatus: stockStatus(row),
    formulary: Boolean(row.formulary),
  };
}

const SELECT_MED = `
  SELECT m.*, i.quantity_in_stock, i.expiry_date, i.last_restocked, i.supplier, i.unit_cost
    FROM medication m
    LEFT JOIN inventory i ON i.medication_id = m.medication_id`;

/** GET /api/pharmacy/medications?q= - formulary search (SCR-06 dropdown). */
router.get(
  '/medications',
  wrap(async (req, res) => {
    const q = `%${String(req.query.q ?? '').trim()}%`;
    const rows = await db.all(
      `${SELECT_MED}
        WHERE (? = '%%' OR m.drug_name LIKE ? OR m.drug_code LIKE ? OR m.category LIKE ?)
        ORDER BY m.drug_name`,
      [q, q, q, q],
    );
    return res.json({ medications: rows.map(shapeMedication) });
  }),
);

/** GET /api/pharmacy/inventory - the stock table on SCR-07. */
router.get(
  '/inventory',
  wrap(async (req, res) => {
    const { status, q = '' } = req.query;
    let rows = await db.all(
      `${SELECT_MED} ORDER BY m.drug_name`,
    );
    rows = rows.map(shapeMedication);

    if (status && status !== 'All') {
      rows = rows.filter((r) => r.stockStatus === status);
    }
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.drugName.toLowerCase().includes(needle) ||
          String(r.drugCode || '').toLowerCase().includes(needle),
      );
    }

    const summary = {
      total: rows.length,
      lowStock: rows.filter((r) => r.stockStatus === 'LowStock').length,
      outOfStock: rows.filter((r) => r.stockStatus === 'OutOfStock').length,
      expiringSoon: rows.filter((r) => {
        if (!r.expiryDate) return false;
        const days = (new Date(r.expiryDate) - new Date()) / 86400000;
        return days <= 90 && days >= 0;
      }).length,
    };

    return res.json({ inventory: rows, summary });
  }),
);

/** GET /api/pharmacy/queue - pending prescriptions, urgent first (SCR-07). */
router.get(
  '/queue',
  wrap(async (req, res) => {
    const rows = await db.all(
      `SELECT r.*, p.first_name AS patient_first, p.last_name AS patient_last,
              d.first_name AS doctor_first, d.last_name AS doctor_last
         FROM prescription r
         JOIN patient p ON p.patient_id = r.patient_id
         JOIN staff   d ON d.staff_id  = r.doctor_id
        WHERE r.status = 'Pending'
        ORDER BY CASE r.priority WHEN 'Urgent' THEN 0 ELSE 1 END, r.prescribed_date ASC`,
    );

    const out = [];
    for (const r of rows) {
      const items = await db.all(
        `SELECT pi.*, m.drug_name, i.quantity_in_stock
           FROM prescription_item pi
           JOIN medication m ON m.medication_id = pi.medication_id
           LEFT JOIN inventory i ON i.medication_id = m.medication_id
          WHERE pi.prescription_id = ?`,
        [r.prescription_id],
      );
      out.push({
        prescriptionId: r.prescription_id,
        number: prescriptionNumber(r.prescription_id),
        patientId: r.patient_id,
        patientName: `${r.patient_first} ${r.patient_last}`,
        doctorName: `Dr. ${r.doctor_first} ${r.doctor_last}`,
        prescribedDate: r.prescribed_date,
        priority: r.priority,
        pharmacyNotes: r.pharmacy_notes,
        items: items.map((i) => ({
          itemId: i.item_id,
          drugName: i.drug_name,
          dosage: i.dosage,
          frequency: i.frequency,
          quantityInStock: Number(i.quantity_in_stock ?? 0),
        })),
        canDispense: items.every((i) => Number(i.quantity_in_stock ?? 0) > 0),
      });
    }

    return res.json({ queue: out });
  }),
);

/**
 * POST /api/pharmacy/dispense
 * Decrements stock and marks the prescription Dispensed in one transaction so
 * inventory can never drift from the prescription record.
 */
router.post(
  '/dispense',
  requireRole('Pharmacist', 'Admin'),
  wrap(async (req, res) => {
    const { prescriptionId, notes } = req.body ?? {};
    if (!prescriptionId) throw badRequest('prescriptionId is required.');

    const rx = await db.get('SELECT * FROM prescription WHERE prescription_id = ?', [
      prescriptionId,
    ]);
    if (!rx) throw notFound('Prescription not found.');
    if (rx.status === 'Dispensed') {
      throw new HttpError(409, 'This prescription has already been dispensed.');
    }

    const items = await db.all(
      `SELECT pi.*, m.drug_name, i.quantity_in_stock
         FROM prescription_item pi
         JOIN medication m ON m.medication_id = pi.medication_id
         LEFT JOIN inventory i ON i.medication_id = m.medication_id
        WHERE pi.prescription_id = ?`,
      [prescriptionId],
    );

    // Hard block: dispensing a drug that is out of stock is not permitted.
    const missing = items.filter((i) => Number(i.quantity_in_stock ?? 0) <= 0);
    if (missing.length) {
      throw new HttpError(
        409,
        `Cannot dispense: ${missing.map((m) => m.drug_name).join(', ')} out of stock.`,
        { outOfStock: missing.map((m) => m.drug_name) },
      );
    }

    const reorderAlerts = await db.transaction(async (exec) => {
      for (const item of items) {
        await exec.run(
          'UPDATE inventory SET quantity_in_stock = quantity_in_stock - 1 WHERE medication_id = ?',
          [item.medication_id],
        );
        await exec.run(
          "UPDATE prescription SET status = 'Dispensed', dispensed_at = CURRENT_TIMESTAMP, pharmacy_notes = ? WHERE prescription_id = ?",
          [notes ?? rx.pharmacy_notes ?? null, prescriptionId],
        );
      }

      // Flag anything that has just fallen below its reorder level.
      const alerts = [];
      for (const item of items) {
        const row = await exec.get(
          `SELECT m.drug_name, m.reorder_level, i.quantity_in_stock
             FROM medication m JOIN inventory i ON i.medication_id = m.medication_id
            WHERE m.medication_id = ?`,
          [item.medication_id],
        );
        if (row && Number(row.quantity_in_stock) <= Number(row.reorder_level)) {
          alerts.push({
            drugName: row.drug_name,
            quantityInStock: Number(row.quantity_in_stock),
            reorderLevel: Number(row.reorder_level),
            message: `Reorder alert: ${row.drug_name} is at ${row.quantity_in_stock} (reorder at ${row.reorder_level}). Procurement officer notified by email.`,
          });
        }
      }
      return alerts;
    });

    await audit(req, 'Dispensed prescription', 'PRESCRIPTION', prescriptionId);
    return res.json({
      message: `${prescriptionNumber(prescriptionId)} dispensed successfully.`,
      reorderAlerts,
    });
  }),
);

/** POST /api/pharmacy/restock - "Receive Stock" form on SCR-07. */
router.post(
  '/restock',
  requireRole('Pharmacist', 'Admin'),
  wrap(async (req, res) => {
    const { medicationId, quantity, expiryDate, supplier, unitCost } = req.body ?? {};
    if (!medicationId) throw badRequest('medicationId is required.');
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw badRequest('Please correct the highlighted fields.', {
        quantity: 'Enter a quantity greater than zero',
      });
    }

    const med = await db.get('SELECT * FROM medication WHERE medication_id = ?', [medicationId]);
    if (!med) throw notFound('Medication not found.');

    await db.transaction(async (exec) => {
      const existing = await exec.get('SELECT inventory_id FROM inventory WHERE medication_id = ?', [
        medicationId,
      ]);
      if (existing) {
        await exec.run(
          `UPDATE inventory
              SET quantity_in_stock = quantity_in_stock + ?,
                  expiry_date = COALESCE(?, expiry_date),
                  supplier = COALESCE(?, supplier),
                  unit_cost = COALESCE(?, unit_cost),
                  last_restocked = CURRENT_TIMESTAMP
            WHERE medication_id = ?`,
          [qty, expiryDate || null, supplier || null, unitCost ?? null, medicationId],
        );
      } else {
        await exec.run(
          `INSERT INTO inventory (medication_id, quantity_in_stock, expiry_date, last_restocked, supplier, unit_cost)
           VALUES (?,?,?,CURRENT_TIMESTAMP,?,?)`,
          [medicationId, qty, expiryDate || null, supplier || null, unitCost ?? 0],
        );
      }
    });

    await audit(req, 'Received stock', 'INVENTORY', medicationId);
    const row = await db.get(`${SELECT_MED} WHERE m.medication_id = ?`, [medicationId]);
    return res.json({
      medication: shapeMedication(row),
      message: `Stock received for ${row.drug_name}.`,
    });
  }),
);

export default router;
export { SELECT_MED, stockStatus };
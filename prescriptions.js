import express from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, HttpError } from '../utils/validate.js';
import { prescriptionNumber } from '../utils/format.js';

const router = express.Router();
router.use(requireAuth);

const SELECT_RX = `
  SELECT r.*, p.first_name AS patient_first, p.last_name AS patient_last,
         d.first_name AS doctor_first, d.last_name AS doctor_last
    FROM prescription r
    JOIN patient p ON p.patient_id = r.patient_id
    JOIN staff   d ON d.staff_id  = r.doctor_id`;

export async function itemsFor(prescriptionId, exec = db) {
  return exec.all(
    `SELECT pi.*, m.drug_name, m.drug_code, m.category
       FROM prescription_item pi
       JOIN medication m ON m.medication_id = pi.medication_id
      WHERE pi.prescription_id = ?
      ORDER BY pi.item_id`,
    [prescriptionId],
  );
}

function shape(row, items = []) {
  return {
    prescriptionId: row.prescription_id,
    number: prescriptionNumber(row.prescription_id),
    patientId: row.patient_id,
    patientName: `${row.patient_first} ${row.patient_last}`,
    doctorId: row.doctor_id,
    doctorName: `Dr. ${row.doctor_first} ${row.doctor_last}`,
    prescribedDate: row.prescribed_date,
    status: row.status,
    priority: row.priority,
    pharmacyNotes: row.pharmacy_notes,
    items: items.map((i) => ({
      itemId: i.item_id,
      medicationId: i.medication_id,
      drugName: i.drug_name,
      drugCode: i.drug_code,
      dosage: i.dosage,
      frequency: i.frequency,
      durationDays: i.duration_days,
      route: i.route,
      instructions: i.instructions,
    })),
  };
}

/** GET /api/prescriptions - filters: status, priority, patientId */
router.get(
  '/',
  wrap(async (req, res) => {
    const { status, priority, patientId } = req.query;
    const where = [];
    const params = [];
    if (status) {
      where.push('r.status = ?');
      params.push(status);
    }
    if (priority) {
      where.push('r.priority = ?');
      params.push(priority);
    }
    if (patientId) {
      where.push('r.patient_id = ?');
      params.push(patientId);
    }

    const rows = await db.all(
      `${SELECT_RX} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY CASE r.priority WHEN 'Urgent' THEN 0 ELSE 1 END,
                 r.prescribed_date DESC`,
      params,
    );

    const out = [];
    for (const r of rows) out.push(shape(r, await itemsFor(r.prescription_id)));
    return res.json({ prescriptions: out });
  }),
);

/** GET /api/prescriptions/:id */
router.get(
  '/:id',
  wrap(async (req, res) => {
    const row = await db.get(`${SELECT_RX} WHERE r.prescription_id = ?`, [req.params.id]);
    if (!row) throw notFound('Prescription not found.');
    return res.json({ prescription: shape(row, await itemsFor(row.prescription_id)) });
  }),
);

/**
 * POST /api/prescriptions (SCR-06)
 * Creates the prescription header plus its PRESCRIPTION_ITEM rows, rejects
 * allergies against the formulary, and notifies the pharmacy queue.
 */
router.post(
  '/',
  requireRole('Doctor', 'Admin'),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const errors = {};

    if (!b.patientId) errors.patientId = 'Required';
    if (!Array.isArray(b.items) || b.items.length === 0) {
      errors.items = 'Add at least one medication';
    } else {
      b.items.forEach((it, i) => {
        if (!it.medicationId) errors[`items.${i}.medicationId`] = 'Select a drug';
        if (!it.dosage) errors[`items.${i}.dosage`] = 'Required';
        if (!it.frequency) errors[`items.${i}.frequency`] = 'Required';
      });
    }
    if (b.priority && !['Urgent', 'Routine'].includes(b.priority)) {
      errors.priority = 'Invalid priority';
    }
    if (Object.keys(errors).length) {
      throw new HttpError(400, 'Please correct the highlighted fields.', errors);
    }

    const patient = await db.get('SELECT * FROM patient WHERE patient_id = ?', [b.patientId]);
    if (!patient) throw notFound('Patient not found.');

    // Allergy cross-check against the EHR, including the drug's drug class.
    const allergyText = (
      await db.all('SELECT allergies FROM ehr_record WHERE patient_id = ?', [b.patientId])
    )
      .map((r) => r.allergies || '')
      .join(', ');
    const allergies = allergyText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const meds = await db.all(
      `SELECT m.*, i.quantity_in_stock FROM medication m
         LEFT JOIN inventory i ON i.medication_id = m.medication_id
        WHERE m.medication_id IN (${b.items.map(() => '?').join(',')})`,
      b.items.map((i) => i.medicationId),
    );
    const medById = new Map(meds.map((m) => [Number(m.medication_id), m]));

    for (const item of b.items) {
      const med = medById.get(Number(item.medicationId));
      if (!med) throw notFound(`Medication ${item.medicationId} not found.`);

      const conflict = allergies.find(
        (a) => a.toLowerCase() === String(med.drug_name).toLowerCase() ||
               String(med.category || '').toLowerCase().includes(a.toLowerCase()),
      );
      if (conflict) {
        throw new HttpError(
          409,
          `Safety alert: ${patient.first_name} ${patient.last_name} is allergic to ${conflict}.`,
          { allergy: conflict },
        );
      }
    }

    const out = await db.transaction(async (exec) => {
      const { insertId } = await exec.run(
        `INSERT INTO prescription
           (patient_id, doctor_id, prescribed_date, status, priority, pharmacy_notes)
         VALUES (?, ?, CURRENT_TIMESTAMP, 'Pending', ?, ?)`,
        [b.patientId, b.doctorId || req.user.sub, b.priority || 'Routine', b.pharmacyNotes || null],
      );

      for (const item of b.items) {
        await exec.run(
          `INSERT INTO prescription_item
             (prescription_id, medication_id, dosage, frequency, duration_days, route, instructions)
           VALUES (?,?,?,?,?,?,?)`,
          [
            insertId,
            item.medicationId,
            item.dosage,
            item.frequency,
            item.durationDays ?? null,
            item.route || null,
            item.instructions || null,
          ],
        );
      }
      return insertId;
    });

    await audit(req, 'Created prescription', 'PRESCRIPTION', out);
    const row = await db.get(`${SELECT_RX} WHERE r.prescription_id = ?`, [out]);
    return res.status(201).json({
      prescription: shape(row, await itemsFor(out)),
      message: `${prescriptionNumber(out)} sent to the pharmacy queue.`,
    });
  }),
);

/** PATCH /api/prescriptions/:id - pharmacist disposition + notes. */
router.patch(
  '/:id',
  requireRole('Pharmacist', 'Doctor', 'Admin'),
  wrap(async (req, res) => {
    const { status, priority, pharmacyNotes } = req.body ?? {};
    const existing = await db.get('SELECT * FROM prescription WHERE prescription_id = ?', [
      req.params.id,
    ]);
    if (!existing) throw notFound('Prescription not found.');

    if (status) {
      if (!['Pending', 'Dispensed', 'Cancelled'].includes(status)) {
        throw new HttpError(400, 'Unknown prescription status.', { status: 'Invalid status' });
      }
      await db.run(
        `UPDATE prescription
            SET status = ?, dispensed_at = CASE WHEN ? = 'Dispensed' THEN CURRENT_TIMESTAMP ELSE dispensed_at END
          WHERE prescription_id = ?`,
        [status, status, req.params.id],
      );
    }
    if (priority) {
      await db.run('UPDATE prescription SET priority = ? WHERE prescription_id = ?', [
        priority,
        req.params.id,
      ]);
    }
    if (pharmacyNotes !== undefined) {
      await db.run('UPDATE prescription SET pharmacy_notes = ? WHERE prescription_id = ?', [
        pharmacyNotes,
        req.params.id,
      ]);
    }

    await audit(req, `Prescription marked ${status || 'updated'}`, 'PRESCRIPTION', req.params.id);
    const row = await db.get(`${SELECT_RX} WHERE r.prescription_id = ?`, [req.params.id]);
    return res.json({ prescription: shape(row, await itemsFor(req.params.id)) });
  }),
);

export default router;
export { SELECT_RX };
import express from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound } from '../utils/validate.js';
import { prescriptionNumber } from '../utils/format.js';

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/ehr/:patientId
 * Everything the EHR screen (SCR-04) renders, in one request: demographics,
 * allergies, current medications, and the per-tab collections.
 */
router.get(
  '/:patientId',
  wrap(async (req, res) => {
    const { patientId } = req.params;
    const patient = await db.get('SELECT * FROM patient WHERE patient_id = ?', [patientId]);
    if (!patient) throw notFound('Patient not found.');

    await audit(req, 'Accessed patient EHR', 'EHR_RECORD', patientId);

    const history = await db.all(
      `SELECT e.*, s.first_name, s.last_name
         FROM ehr_record e
         JOIN staff s ON s.staff_id = e.recorded_by
        WHERE e.patient_id = ?
        ORDER BY e.visit_date DESC`,
      [patientId],
    );

    const prescriptions = await db.all(
      `SELECT r.*, s.first_name AS doctor_first, s.last_name AS doctor_last,
              (SELECT COUNT(*) FROM prescription_item pi WHERE pi.prescription_id = r.prescription_id) AS item_count
         FROM prescription r
         JOIN staff s ON s.staff_id = r.doctor_id
        WHERE r.patient_id = ?
        ORDER BY r.prescribed_date DESC`,
      [patientId],
    );

    const appointments = await db.all(
      `SELECT a.*, d.first_name AS doctor_first, d.last_name AS doctor_last
         FROM appointment a
         JOIN staff d ON d.staff_id = a.doctor_id
        WHERE a.patient_id = ?
        ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
      [patientId],
    );

    const labs = await db.all(
      `SELECT l.*, r.result_id, r.result_data, r.technician_notes, r.result_date, r.abnormal_flag
         FROM lab_order l
         LEFT JOIN lab_result r ON r.lab_id = l.lab_id
        WHERE l.patient_id = ?
        ORDER BY l.order_date DESC`,
      [patientId],
    );

    const invoices = await db.all(
      `SELECT * FROM invoice WHERE patient_id = ? ORDER BY invoice_date DESC`,
      [patientId],
    );

    // Allergies are consolidated across every EHR entry, de-duplicated.
    const allergies = new Set();
    for (const h of history) {
      (h.allergies || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((a) => allergies.add(a));
    }

    // "Current" = every dispensed medication not yet marked complete.
    const currentMedications = await db.all(
      `SELECT m.medication_id, m.drug_name, pi.dosage, pi.frequency, pi.route, pi.instructions,
              r.prescribed_date, r.prescription_id
         FROM prescription r
         JOIN prescription_item pi ON pi.prescription_id = r.prescription_id
         JOIN medication m ON m.medication_id = pi.medication_id
        WHERE r.patient_id = ? AND r.status = 'Dispensed'
        ORDER BY r.prescribed_date DESC`,
      [patientId],
    );

    return res.json({
      patient: {
        patientId: patient.patient_id,
        firstName: patient.first_name,
        lastName: patient.last_name,
        dateOfBirth: patient.date_of_birth,
        gender: patient.gender,
        idNumber: patient.id_number,
        phoneNumber: patient.phone_number,
        emailAddress: patient.email_address,
        physicalAddress: patient.physical_address,
        bloodType: patient.blood_type,
        medicalAidProvider: patient.medical_aid_provider,
        medicalAidNumber: patient.medical_aid_number,
        emergencyContactName: patient.emergency_contact_name,
        emergencyContactPhone: patient.emergency_contact_phone,
      },
      allergies: [...allergies],
      currentMedications: currentMedications.map((m) => ({
        medicationId: m.medication_id,
        drugName: m.drug_name,
        dosage: m.dosage,
        frequency: m.frequency,
        route: m.route,
        instructions: m.instructions,
        prescribedDate: m.prescribed_date,
        prescriptionId: m.prescription_id,
      })),
      history: history.map((h) => ({
        ehrId: h.ehr_id,
        visitDate: h.visit_date,
        diagnosis: h.diagnosis,
        treatmentNotes: h.treatment_notes,
        allergies: h.allergies,
        followUpDate: h.follow_up_date,
        recordedBy: `Dr. ${h.first_name} ${h.last_name}`,
        recordedById: h.recorded_by,
      })),
      prescriptions: prescriptions.map((p) => ({
        prescriptionId: p.prescription_id,
        number: prescriptionNumber(p.prescription_id),
        prescribedDate: p.prescribed_date,
        status: p.status,
        priority: p.priority,
        itemCount: Number(p.item_count),
        doctorName: `Dr. ${p.doctor_first} ${p.doctor_last}`,
      })),
      appointments: appointments.map((a) => ({
        appointmentId: a.appointment_id,
        date: a.appointment_date,
        time: a.appointment_time,
        type: a.appointment_type,
        reason: a.reason,
        status: a.status,
        doctorName: `Dr. ${a.doctor_first} ${a.doctor_last}`,
      })),
      labs: labs.map((l) => ({
        labId: l.lab_id,
        testName: l.test_name,
        orderDate: l.order_date,
        status: l.status,
        urgency: l.urgency,
        abnormalFlag: Boolean(l.abnormal_flag),
        technicianNotes: l.technician_notes,
        resultDate: l.result_date,
        resultData: l.result_data ? JSON.parse(l.result_data) : null,
      })),
      invoices: invoices.map((i) => ({
        invoiceId: i.invoice_id,
        invoiceDate: i.invoice_date,
        totalAmount: Number(i.total_amount),
        patientOwing: Number(i.patient_owing),
        status: i.status,
      })),
    });
  }),
);

/** POST /api/ehr/:patientId/diagnosis - "Add Diagnosis" action on SCR-04. */
router.post(
  '/:patientId/diagnosis',
  requireRole('Doctor', 'Admin'),
  wrap(async (req, res) => {
    const { diagnosis, treatmentNotes, followUpDate } = req.body ?? {};
    if (!diagnosis || !String(diagnosis).trim()) {
      throw Object.assign(new Error('Please correct the highlighted fields.'), {
        status: 400,
        details: { diagnosis: 'Required' },
      });
    }

    const patient = await db.get('SELECT patient_id FROM patient WHERE patient_id = ?', [
      req.params.patientId,
    ]);
    if (!patient) throw notFound('Patient not found.');

    const { insertId } = await db.run(
      `INSERT INTO ehr_record (patient_id, recorded_by, visit_date, diagnosis, treatment_notes, follow_up_date)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
      [req.params.patientId, req.user.sub, diagnosis.trim(), treatmentNotes || null, followUpDate || null],
    );

    await audit(req, 'Created diagnosis', 'EHR_RECORD', insertId);
    return res.status(201).json({ ehrId: insertId, message: 'Diagnosis added to the patient record.' });
  }),
);

export default router;
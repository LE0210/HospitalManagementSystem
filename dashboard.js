import express from 'express';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { wrap } from '../utils/validate.js';

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/dashboard
 * Returns the widget set for the signed-in role. Per the usability feedback in
 * report Section 2.1 ("Change 3 - Role-Adaptive Dashboard"), nurses and
 * pharmacists get clinical widgets instead of financial ones.
 */
router.get(
  '/',
  wrap(async (req, res) => {
    const date = config.systemDate;
    const role = req.user.role;

    // The appointment widgets are hospital-wide (matching SCR-03); the
    // role-adaptation in report Section 2.1 changes *which* widgets render,
    // not which appointments they count.
    const appts = await db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'Scheduled' THEN 1 ELSE 0 END) AS scheduled,
              SUM(CASE WHEN status = 'NoShow'    THEN 1 ELSE 0 END) AS no_shows
         FROM appointment
        WHERE appointment_date = ?`,
      [date],
    );

    const pendingLabs = await db.get(
      "SELECT COUNT(*) AS n FROM lab_order WHERE status <> 'Completed'",
    );

    const abnormalLabs = await db.all(
      `SELECT l.lab_id, l.test_name, l.urgency, l.status, r.abnormal_flag, r.technician_notes,
              p.patient_id, p.first_name, p.last_name
         FROM lab_order l
         JOIN lab_result r ON r.lab_id = l.lab_id
         JOIN patient p ON p.patient_id = l.patient_id
        WHERE r.abnormal_flag = 1
        ORDER BY l.order_date DESC LIMIT 5`,
    );

    const inProgressLabs = await db.all(
      `SELECT l.lab_id, l.test_name, l.status, p.patient_id,
              p.first_name, p.last_name
         FROM lab_order l
         JOIN patient p ON p.patient_id = l.patient_id
        WHERE l.status = 'InProgress'
        ORDER BY l.order_date DESC LIMIT 5`,
    );

    const pendingRx = await db.get(
      `SELECT COUNT(*) AS n FROM prescription WHERE status = 'Pending'`,
    );

    // Upcoming appointments for the list panel.
    const upcoming = await db.all(
      `SELECT a.*, p.first_name, p.last_name
         FROM appointment a
         JOIN patient p ON p.patient_id = a.patient_id
        WHERE a.appointment_date = ? AND a.status = 'Scheduled'
        ORDER BY a.appointment_time LIMIT 6`,
      [date],
    );

    const queueSize = await db.get(
      "SELECT COUNT(*) AS n FROM appointment WHERE appointment_date = ? AND status = 'Scheduled'",
      [date],
    );

    const vitalsDue = await db.get(
      `SELECT COUNT(*) AS n FROM ehr_record WHERE date(visit_date) = ?`,
      [date],
    );

    const discharges = await db.get(
      `SELECT COUNT(*) AS n FROM ehr_record WHERE follow_up_date = ?`,
      [date],
    );

    const stock = await db.get(
      `SELECT SUM(CASE WHEN i.quantity_in_stock <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
              SUM(CASE WHEN i.quantity_in_stock > 0 AND i.quantity_in_stock <= m.reorder_level THEN 1 ELSE 0 END) AS low_stock
         FROM medication m
         LEFT JOIN inventory i ON i.medication_id = m.medication_id`,
    );

    const dispensedToday = await db.get(
      `SELECT COUNT(*) AS n FROM prescription WHERE status = 'Dispensed' AND date(dispensed_at) = ?`,
      [date],
    );

    const patientCount = await db.get('SELECT COUNT(*) AS n FROM patient');
    const revenue = await db.get(
      `SELECT COALESCE(SUM(total_amount), 0) AS billed,
              COALESCE(SUM(patient_owing), 0) AS owing
         FROM invoice WHERE date(invoice_date) = ?`,
      [date],
    );

    return res.json({
      date,
      role,
      stats: {
        todayAppointments: Number(appts?.total ?? 0),
        scheduled: Number(appts?.scheduled ?? 0),
        noShows: Number(appts?.no_shows ?? 0),
        queueSize: Number(queueSize?.n ?? 0),
        pendingLabs: Number(pendingLabs?.n ?? 0),
        pendingPrescriptions: Number(pendingRx?.n ?? 0),
        vitalsDue: Number(vitalsDue?.n ?? 0),
        dischargesPending: Number(discharges?.n ?? 0),
        lowStock: Number(stock?.low_stock ?? 0),
        outOfStock: Number(stock?.out_of_stock ?? 0),
        dispensedToday: Number(dispensedToday?.n ?? 0),
        totalPatients: Number(patientCount?.n ?? 0),
        billedToday: Number(revenue?.billed ?? 0),
        owingToday: Number(revenue?.owing ?? 0),
      },
      upcomingAppointments: upcoming.map((a) => ({
        appointmentId: a.appointment_id,
        patientId: a.patient_id,
        patientName: `${a.first_name} ${a.last_name}`,
        initials: `${a.first_name.charAt(0)}${a.last_name.charAt(0)}`.toUpperCase(),
        time: a.appointment_time,
        type: a.appointment_type,
        reason: a.reason,
        status: a.status,
      })),
      labAlerts: [
        ...abnormalLabs.map((l) => ({
          labId: l.lab_id,
          patientId: l.patient_id,
          patientName: `${l.first_name} ${l.last_name}`,
          testName: l.test_name,
          abnormalFlag: true,
          urgency: l.urgency,
          notes: l.technician_notes,
        })),
        ...inProgressLabs.map((l) => ({
          labId: l.lab_id,
          patientId: l.patient_id,
          patientName: `${l.first_name} ${l.last_name}`,
          testName: l.test_name,
          abnormalFlag: false,
          urgency: 'Routine',
          notes: null,
        })),
      ].slice(0, 5),
    });
  }),
);

export default router;
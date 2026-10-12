import express from 'express';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { wrap, badRequest, notFound, assertNoErrors } from '../utils/validate.js';

const router = express.Router();
router.use(requireAuth);

const TYPES = ['Consultation', 'Follow-up', 'Procedure'];
const STATUSES = ['Scheduled', 'Completed', 'Cancelled', 'NoShow'];

function shape(row) {
  return {
    appointmentId: row.appointment_id,
    patientId: row.patient_id,
    patientName: `${row.first_name} ${row.last_name}`,
    patientInitials: `${row.first_name.charAt(0)}${row.last_name.charAt(0)}`.toUpperCase(),
    doctorId: row.doctor_id,
    doctorName: `Dr. ${row.doctor_first} ${row.doctor_last}`,
    doctorSpecialty: row.doctor_specialty,
    appointmentDate: row.appointment_date,
    appointmentTime: row.appointment_time,
    appointmentType: row.appointment_type,
    reason: row.reason,
    status: row.status,
    reminderSent: Boolean(row.reminder_sent),
  };
}

const SELECT_APPT = `
  SELECT a.*,
         p.first_name, p.last_name,
         d.first_name AS doctor_first, d.last_name AS doctor_last,
         d.specialty AS doctor_specialty
    FROM appointment a
    JOIN patient p ON p.patient_id = a.patient_id
    JOIN staff   d ON d.staff_id  = a.doctor_id`;

/** GET /api/appointments?date=&doctorId=&status= */
router.get(
  '/',
  wrap(async (req, res) => {
    const { date, doctorId, status, patientId } = req.query;
    const where = [];
    const params = [];

    if (date) {
      where.push('a.appointment_date = ?');
      params.push(date);
    }
    if (doctorId) {
      where.push('a.doctor_id = ?');
      params.push(doctorId);
    }
    if (status) {
      where.push('a.status = ?');
      params.push(status);
    }
    if (patientId) {
      where.push('a.patient_id = ?');
      params.push(patientId);
    }

    const rows = await db.all(
      `${SELECT_APPT}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.appointment_date DESC, a.appointment_time ASC`,
      params,
    );
    return res.json({ appointments: rows.map(shape) });
  }),
);

/** GET /api/appointments/summary - the counters on SCR-05. */
router.get(
  '/summary',
  wrap(async (req, res) => {
    const date = req.query.date || config.systemDate;
    const doctorId = req.query.doctorId;

    const day = await db.get(
      `SELECT COUNT(*) AS total FROM appointment WHERE appointment_date = ?`,
      [date],
    );
    // No-shows are reported across the full period, not just the selected day.
    const period = await db.get(
      `SELECT SUM(CASE WHEN status = 'NoShow'    THEN 1 ELSE 0 END) AS no_shows,
              SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled
         FROM appointment WHERE appointment_date <= ?${doctorId ? ' AND doctor_id = ?' : ''}`,
      doctorId ? [date, doctorId] : [date],
    );

    return res.json({
      date,
      total: Number(day?.total ?? 0),
      noShows: Number(period?.no_shows ?? 0),
      completed: Number(period?.completed ?? 0),
      cancelled: Number(period?.cancelled ?? 0),
    });
  }),
);

/**
 * GET /api/appointments/availability - the Mon-Fri strip on SCR-05.
 * Days are returned pre-marked available/full so the UI never double-books.
 */
router.get(
  '/availability',
  wrap(async (req, res) => {
    const doctorId = req.query.doctorId;
    if (!doctorId) throw badRequest('doctorId is required.');

    const days = [];
    const base = new Date(`${config.systemDate}T00:00:00Z`);

    for (let i = 0; i < 5; i += 1) {
      const d = new Date(base);
      d.setUTCDate(base.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const row = await db.get(
        'SELECT COUNT(*) AS n FROM appointment WHERE doctor_id = ? AND appointment_date = ? AND status <> ?',
        [doctorId, iso, 'Cancelled'],
      );
      days.push({
        date: iso,
        label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()],
        dayOfMonth: d.getUTCDate(),
        available: Number(row.n) < 8,
        booked: Number(row.n),
      });
    }
    return res.json({ days });
  }),
);

/** POST /api/appointments (SCR-05) */
router.post(
  '/',
  requireRole('Admin', 'BillingClerk', 'Doctor'),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const errors = {};
    ['patientId', 'doctorId', 'appointmentDate', 'appointmentTime', 'appointmentType'].forEach(
      (f) => {
        if (!b[f] || !String(b[f]).trim()) errors[f] = 'Required';
      },
    );
    if (b.appointmentType && !TYPES.includes(b.appointmentType)) {
      errors.appointmentType = 'Select an appointment type';
    }
    assertNoErrors(errors);

    const patient = await db.get('SELECT patient_id FROM patient WHERE patient_id = ?', [
      b.patientId,
    ]);
    if (!patient) throw notFound('Patient not found.');

    const doctor = await db.get("SELECT staff_id FROM staff WHERE staff_id = ? AND role = 'Doctor'", [
      b.doctorId,
    ]);
    if (!doctor) throw notFound('Doctor not found.');

    // Prevent double-booking: one slot per doctor.
    const clash = await db.get(
      `SELECT appointment_id FROM appointment
        WHERE doctor_id = ? AND appointment_date = ? AND appointment_time = ?
          AND status <> 'Cancelled'`,
      [b.doctorId, b.appointmentDate, b.appointmentTime],
    );
    if (clash) {
      throw badRequest('That time slot is already booked for this doctor.', {
        appointmentTime: 'Select another time slot',
      });
    }

    const { insertId } = await db.run(
      `INSERT INTO appointment
         (patient_id, doctor_id, appointment_date, appointment_time, appointment_type,
          reason, status, reminder_sent, created_at)
       VALUES (?,?,?,?,?,?, 'Scheduled', ?, CURRENT_TIMESTAMP)`,
      [
        b.patientId,
        b.doctorId,
        b.appointmentDate,
        b.appointmentTime,
        b.appointmentType,
        b.reason || null,
        b.sendSms || b.sendEmail ? 1 : 0,
      ],
    );

    await audit(req, 'Created appointment', 'APPOINTMENT', insertId);
    const row = await db.get(`${SELECT_APPT} WHERE a.appointment_id = ?`, [insertId]);
    return res.status(201).json({
      appointment: shape(row),
      message: `Appointment confirmed for ${row.first_name} ${row.last_name}.`,
      reminders: {
        sms: Boolean(b.sendSms),
        email: Boolean(b.sendEmail),
      },
    });
  }),
);

/** PATCH /api/appointments/:id - status transitions, incl. No-Show. */
router.patch(
  '/:id',
  requireRole('Admin', 'BillingClerk', 'Doctor', 'Nurse'),
  wrap(async (req, res) => {
    const { status, reminderSent } = req.body ?? {};
    if (status && !STATUSES.includes(status)) {
      throw badRequest('Unknown appointment status.', { status: 'Invalid status' });
    }

    const existing = await db.get('SELECT * FROM appointment WHERE appointment_id = ?', [
      req.params.id,
    ]);
    if (!existing) throw notFound('Appointment not found.');

    if (status) {
      await db.run('UPDATE appointment SET status = ? WHERE appointment_id = ?', [
        status,
        req.params.id,
      ]);
    }
    if (reminderSent !== undefined) {
      await db.run('UPDATE appointment SET reminder_sent = ? WHERE appointment_id = ?', [
        reminderSent ? 1 : 0,
        req.params.id,
      ]);
    }

    await audit(req, `Appointment marked ${status || 'updated'}`, 'APPOINTMENT', req.params.id);
    const row = await db.get(`${SELECT_APPT} WHERE a.appointment_id = ?`, [req.params.id]);
    return res.json({ appointment: shape(row) });
  }),
);

export default router;
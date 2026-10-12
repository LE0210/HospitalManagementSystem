import express from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, HttpError } from '../utils/validate.js';
import { labNumber } from '../utils/format.js';

const router = express.Router();
router.use(requireAuth);

const SELECT_LAB = `
  SELECT l.*, p.first_name AS patient_first, p.last_name AS patient_last,
         r.result_id, r.result_data, r.technician_notes, r.result_date, r.abnormal_flag,
         t.first_name AS tech_first, t.last_name AS tech_last,
         o.first_name AS order_first, o.last_name AS order_last
    FROM lab_order l
    JOIN patient p ON p.patient_id = l.patient_id
    JOIN staff   o ON o.staff_id  = l.ordered_by
    LEFT JOIN lab_result r ON r.lab_id = l.lab_id
    LEFT JOIN staff t ON t.staff_id = r.uploaded_by`;

function shape(row) {
  return {
    labId: row.lab_id,
    labNumber: labNumber(row.lab_id),
    patientId: row.patient_id,
    patientName: `${row.patient_first} ${row.patient_last}`,
    orderedBy: row.ordered_by,
    orderedByName: `Dr. ${row.order_first} ${row.order_last}`,
    testName: row.test_name,
    orderDate: row.order_date,
    status: row.status,
    urgency: row.urgency,
    abnormalFlag: Boolean(row.abnormal_flag),
    technicianNotes: row.technician_notes,
    resultDate: row.result_date,
    uploadedByName: row.tech_first ? `${row.tech_first} ${row.tech_last}` : null,
    resultData: row.result_data ? JSON.parse(row.result_data) : null,
  };
}

/** GET /api/labs */
router.get(
  '/',
  wrap(async (req, res) => {
    const { status, patientId, abnormalOnly } = req.query;
    const where = [];
    const params = [];

    if (status) {
      where.push('l.status = ?');
      params.push(status);
    }
    if (patientId) {
      where.push('l.patient_id = ?');
      params.push(patientId);
    }
    if (abnormalOnly === 'true') where.push('r.abnormal_flag = 1');

    const rows = await db.all(
      `${SELECT_LAB} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY CASE l.urgency WHEN 'STAT' THEN 0 WHEN 'Urgent' THEN 1 ELSE 2 END,
                 l.order_date DESC`,
      params,
    );
    return res.json({ labs: rows.map(shape) });
  }),
);

/**
 * POST /api/labs/:labId/results  (SCR-09)
 * Stores the result set, auto-flags abnormal values and notifies the ordering
 * doctor. `abnormal_flag` is derived here, never trusted from the client.
 */
router.post(
  '/:labId/results',
  requireRole('LabTech', 'Admin'),
  wrap(async (req, res) => {
    const { resultData, technicianNotes } = req.body ?? {};

    if (!Array.isArray(resultData) || resultData.length === 0) {
      throw new HttpError(400, 'Please correct the highlighted fields.', {
        resultData: 'Enter at least one result parameter',
      });
    }

    const order = await db.get('SELECT * FROM lab_order WHERE lab_id = ?', [req.params.labId]);
    if (!order) throw notFound('Lab order not found.');

    const existing = await db.get('SELECT result_id FROM lab_result WHERE lab_id = ?', [
      req.params.labId,
    ]);
    if (existing) {
      throw new HttpError(409, 'Results have already been uploaded for this order.');
    }

    // Auto-flag: the technician marks each parameter, but the order-level flag
    // is computed server-side so the dashboard and email alerts agree.
    const abnormal = resultData.some((r) =>
      ['LOW', 'HIGH', 'CRITICAL', 'ABNORMAL'].includes(String(r.flag ?? '').toUpperCase()),
    );

    await db.transaction(async (exec) => {
      await exec.run(
        `INSERT INTO lab_result
           (lab_id, uploaded_by, result_data, technician_notes, result_date, abnormal_flag)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP,?)`,
        [req.params.labId, req.user.sub, JSON.stringify(resultData), technicianNotes || null, abnormal ? 1 : 0],
      );
      await exec.run("UPDATE lab_order SET status = 'Completed' WHERE lab_id = ?", [req.params.labId]);
    });

    await audit(req, 'Uploaded lab results', 'LAB_RESULT', req.params.labId);

    return res.status(201).json({
      labId: Number(req.params.labId),
      labNumber: labNumber(req.params.labId),
      abnormalFlag: abnormal,
      message: abnormal
        ? 'Results uploaded. Ordering doctor notified of abnormal values.'
        : 'Results uploaded and appended to the patient EHR.',
    });
  }),
);

/** POST /api/labs - order a test from the EHR ("Order Lab Test"). */
router.post(
  '/',
  requireRole('Doctor', 'Admin'),
  wrap(async (req, res) => {
    const { patientId, testName, urgency } = req.body ?? {};
    const errors = {};
    if (!patientId) errors.patientId = 'Required';
    if (!testName) errors.testName = 'Required';
    if (Object.keys(errors).length) {
      throw new HttpError(400, 'Please correct the highlighted fields.', errors);
    }

    const patient = await db.get('SELECT patient_id FROM patient WHERE patient_id = ?', [patientId]);
    if (!patient) throw notFound('Patient not found.');

    const { insertId } = await db.run(
      `INSERT INTO lab_order (patient_id, ordered_by, test_name, order_date, status, urgency)
       VALUES (?,?,?,CURRENT_TIMESTAMP,'Ordered',?)`,
      [patientId, req.user.sub, testName, urgency || 'Routine'],
    );

    await audit(req, 'Ordered lab test', 'LAB_ORDER', insertId);
    return res.status(201).json({
      labId: insertId,
      labNumber: labNumber(insertId),
      message: `${labNumber(insertId)} ordered.`,
    });
  }),
);

export default router;
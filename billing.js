import express from 'express';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { wrap, badRequest, notFound } from '../utils/validate.js';
import { invoiceNumber } from '../utils/format.js';

const router = express.Router();
router.use(requireAuth);

const SELECT_INV = `
  SELECT i.*, p.first_name AS patient_first, p.last_name AS patient_last,
         p.medical_aid_provider, p.medical_aid_number
    FROM invoice i
    JOIN patient p ON p.patient_id = i.patient_id`;

function shape(row, items = [], payments = []) {
  return {
    invoiceId: row.invoice_id,
    invoiceNumber: invoiceNumber(row.invoice_id, row.invoice_date),
    patientId: row.patient_id,
    patientName: `${row.patient_first} ${row.patient_last}`,
    medicalAidProvider: row.medical_aid_provider,
    medicalAidNumber: row.medical_aid_number,
    invoiceDate: row.invoice_date,
    totalAmount: Number(row.total_amount),
    aidCovers: Number(row.aid_covers),
    patientOwing: Number(row.patient_owing),
    status: row.status,
    items: items.map((it) => ({
      id: it.invoice_item_id,
      description: it.description,
      category: it.category,
      amount: Number(it.amount),
    })),
    payments: payments.map((p) => ({
      id: p.payment_id,
      amount: Number(p.amount),
      method: p.method,
      paidAt: p.paid_at,
    })),
  };
}

const selectItems = (id, exec = db) =>
  exec.all('SELECT * FROM invoice_item WHERE invoice_id = ? ORDER BY invoice_item_id', [id]);

const selectPayments = (id, exec = db) =>
  exec.all('SELECT * FROM payment WHERE invoice_id = ? ORDER BY paid_at DESC', [id]);

/** GET /api/billing?status=&q= - the invoice list on SCR-08. */
router.get(
  '/',
  wrap(async (req, res) => {
    const { status, q = '' } = req.query;
    let rows = await db.all(`${SELECT_INV} ORDER BY i.invoice_date DESC`);

    if (status && status !== 'All') rows = rows.filter((r) => r.status === status);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          `${r.patient_first} ${r.patient_last}`.toLowerCase().includes(needle) ||
          invoiceNumber(r.invoice_id, r.invoice_date).toLowerCase().includes(needle),
      );
    }

    const out = [];
    for (const r of rows) {
      out.push(shape(r, await selectItems(r.invoice_id), await selectPayments(r.invoice_id)));
    }

    const totals = rows.reduce(
      (acc, r) => {
        acc.billed += Number(r.total_amount);
        acc.aid += Number(r.aid_covers);
        acc.owing += Number(r.patient_owing);
        if (r.status === 'Paid') acc.paid += Number(r.total_amount) - Number(r.patient_owing);
        return acc;
      },
      { billed: 0, aid: 0, owing: 0, paid: 0 },
    );

    return res.json({ invoices: out, totals });
  }),
);

/** GET /api/billing/:id */
router.get(
  '/:id',
  wrap(async (req, res) => {
    const row = await db.get(`${SELECT_INV} WHERE i.invoice_id = ?`, [req.params.id]);
    if (!row) throw notFound('Invoice not found.');
    return res.json({
      invoice: shape(row, await selectItems(row.invoice_id), await selectPayments(row.invoice_id)),
    });
  }),
);

/**
 * POST /api/billing
 * SCR-08 auto-populates services rendered from consultation, lab and pharmacy
 * activity, then applies medical aid cover and computes the patient owing.
 */
router.post(
  '/',
  requireRole('BillingClerk', 'Admin'),
  wrap(async (req, res) => {
    const { patientId, aidCoveragePercent, items, sendToMedicalAid } = req.body ?? {};
    if (!patientId) throw badRequest('patientId is required.');

    const patient = await db.get('SELECT * FROM patient WHERE patient_id = ?', [patientId]);
    if (!patient) throw notFound('Patient not found.');

    const lines = Array.isArray(items) && items.length ? items : [];

    const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
    const pct = patient.medical_aid_number ? Number(aidCoveragePercent ?? 100) : 0;
    const aidCovers = Number(((total * pct) / 100).toFixed(2));
    const patientOwing = Number((total - aidCovers).toFixed(2));

    const invoiceId = await db.transaction(async (exec) => {
      const { insertId } = await exec.run(
        `INSERT INTO invoice
           (patient_id, created_by, invoice_date, total_amount, aid_covers, patient_owing, status)
         VALUES (?,?,CURRENT_TIMESTAMP,?,?,?, 'Unpaid')`,
        [patientId, req.user.sub, total, aidCovers, patientOwing],
      );
      for (const l of lines) {
        await exec.run(
          'INSERT INTO invoice_item (invoice_id, description, category, amount) VALUES (?,?,?,?)',
          [insertId, l.description, l.category || 'Consultation', l.amount],
        );
      }
      return insertId;
    });

    await audit(req, 'Generated invoice', 'INVOICE', invoiceId);
    const row = await db.get(`${SELECT_INV} WHERE i.invoice_id = ?`, [invoiceId]);
    return res.status(201).json({
      invoice: shape(row, await selectItems(invoiceId)),
      message: `${invoiceNumber(invoiceId, row.invoice_date)} generated${
        sendToMedicalAid ? ' and submitted to the medical aid' : ''
      }.`,
    });
  }),
);

/** POST /api/billing/:id/payment - record a payment against an invoice. */
router.post(
  '/:id/payment',
  requireRole('BillingClerk', 'Admin'),
  wrap(async (req, res) => {
    const { amount, method } = req.body ?? {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      throw badRequest('Please correct the highlighted fields.', {
        amount: 'Enter an amount greater than zero',
      });
    }

    const invoice = await db.get('SELECT * FROM invoice WHERE invoice_id = ?', [req.params.id]);
    if (!invoice) throw notFound('Invoice not found.');

    const owing = Number(invoice.patient_owing);
    if (amt > owing + 0.01) {
      throw badRequest('Payment exceeds the outstanding balance.', {
        amount: `Maximum ${owing.toFixed(2)}`,
      });
    }

    const newOwing = Number((owing - amt).toFixed(2));
    const status = newOwing <= 0 ? 'Paid' : 'PartiallyPaid';

    await db.transaction(async (exec) => {
      await exec.run(
        'INSERT INTO payment (invoice_id, amount, method, paid_at, received_by) VALUES (?,?,?,CURRENT_TIMESTAMP,?)',
        [req.params.id, amt, method || 'Cash', req.user.sub],
      );
      await exec.run('UPDATE invoice SET patient_owing = ?, status = ? WHERE invoice_id = ?', [
        newOwing,
        status,
        req.params.id,
      ]);
    });

    await audit(req, 'Recorded payment', 'INVOICE', req.params.id);
    const row = await db.get(`${SELECT_INV} WHERE i.invoice_id = ?`, [req.params.id]);
    return res.json({
      invoice: shape(row, await selectItems(req.params.id), await selectPayments(req.params.id)),
      message:
        status === 'Paid'
          ? 'Payment received in full. Invoice settled.'
          : 'Part payment recorded.',
    });
  }),
);

/**
 * GET /api/billing/:patientId/draft
 * Services rendered during the visit, ready to be turned into an invoice.
 */
router.get(
  '/:id/draft',
  wrap(async (req, res) => {
    const patientId = req.params.id;
    const patient = await db.get('SELECT * FROM patient WHERE patient_id = ?', [patientId]);
    if (!patient) throw notFound('Patient not found.');

    const consultations = await db.all(
      `SELECT a.*, d.specialty FROM appointment a
         JOIN staff d ON d.staff_id = a.doctor_id
        WHERE a.patient_id = ? AND a.status = 'Completed'
        ORDER BY a.appointment_date DESC LIMIT 20`,
      [patientId],
    );
    const labs = await db.all(
      `SELECT * FROM lab_order WHERE patient_id = ? AND status = 'Completed'`,
      [patientId],
    );
    const dispensed = await db.all(
      `SELECT r.prescription_id, COUNT(pi.item_id) AS n
         FROM prescription r
         JOIN prescription_item pi ON pi.prescription_id = r.prescription_id
        WHERE r.patient_id = ? AND r.status = 'Dispensed'
        GROUP BY r.prescription_id`,
      [patientId],
    );

    // Illustrative tariff - a real deployment reads this from a price list.
    const items = [
      ...consultations.map((c) => ({
        description: `${c.appointment_type} - ${c.specialty || 'General Practice'}`,
        category: 'Consultation',
        amount: c.appointment_type === 'Procedure' ? 450 : c.appointment_type === 'Follow-up' ? 220 : 320,
        source: `APPT-${c.appointment_id}`,
      })),
      ...labs.map((l) => ({
        description: `Laboratory: ${l.test_name}`,
        category: 'Lab',
        amount: 180,
        source: labNumberSafe(l.lab_id),
      })),
      ...dispensed.map((d) => ({
        description: `Pharmacy: ${d.n} medication(s) dispensed`,
        category: 'Pharmacy',
        amount: Number(d.n) * 95,
        source: `RX-${String(d.prescription_id).padStart(4, '0')}`,
      })),
    ];

    void config;
    return res.json({
      patient: {
        patientId: patient.patient_id,
        name: `${patient.first_name} ${patient.last_name}`,
        medicalAidProvider: patient.medical_aid_provider,
        medicalAidNumber: patient.medical_aid_number,
      },
      items,
      total: items.reduce((s, i) => s + i.amount, 0),
    });
  }),
);

const labNumberSafe = (id) => `LAB-${String(id).padStart(3, '0')}`;

export default router;
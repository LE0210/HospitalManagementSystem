import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, ROLES } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import { wrap, badRequest, notFound, HttpError, isValidEmail } from '../utils/validate.js';
import { initials } from '../utils/format.js';

const router = express.Router();
router.use(requireAuth);

const shape = (r) => ({
  staffId: r.staff_id,
  firstName: r.first_name,
  lastName: r.last_name,
  fullName: `${r.role === 'Doctor' ? 'Dr. ' : ''}${r.first_name} ${r.last_name}`,
  initials: initials(r.first_name, r.last_name),
  role: r.role,
  specialty: r.specialty,
  email: r.email_address,
  phone: r.phone_number,
  isActive: Boolean(r.is_active),
  dateJoined: r.date_joined,
});

/** GET /api/staff - any authenticated user may look up doctors for dropdowns. */
router.get(
  '/',
  wrap(async (req, res) => {
    const { role, includeInactive = 'true' } = req.query;
    const where = [];
    const params = [];

    if (role) {
      where.push('role = ?');
      params.push(role);
    }
    if (includeInactive === 'false') where.push('is_active = 1');

    const rows = await db.all(
      `SELECT * FROM staff ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY role, last_name`,
      params,
    );
    return res.json({ staff: rows.map(shape), roles: ROLES });
  }),
);

/** GET /api/staff/audit-log - the Audit Log panel on SCR-10 (Admin only). */
router.get(
  '/audit-log',
  requireRole('Admin'),
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const rows = await db.all(
      `SELECT a.*, s.first_name, s.last_name, s.role
         FROM audit_log a
         LEFT JOIN staff s ON s.staff_id = a.staff_id
        ORDER BY a.timestamp DESC, a.log_id DESC
        LIMIT ?`,
      [limit],
    );

    return res.json({
      entries: rows.map((r) => ({
        logId: r.log_id,
        staffName:
          r.staff_id && r.first_name
            ? `${r.role === 'Doctor' ? 'Dr. ' : ''}${r.first_name} ${r.last_name}`
            : r.staff_id || 'System',
        staffId: r.staff_id,
        role: r.role,
        action: r.action,
        affectedTable: r.affected_table,
        affectedRecordId: r.affected_record_id,
        timestamp: r.timestamp,
        ipAddress: r.ip_address,
      })),
    });
  }),
);

/** POST /api/staff - "Add User" on SCR-10. */
router.post(
  '/',
  requireRole('Admin'),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const errors = {};

    ['staffId', 'firstName', 'lastName', 'role', 'email', 'password'].forEach((f) => {
      if (!b[f] || !String(b[f]).trim()) errors[f] = 'Required';
    });
    if (b.role && !ROLES.includes(b.role)) errors.role = 'Select a valid role';
    if (b.email && !isValidEmail(b.email)) errors.email = 'Enter a valid email address';
    if (b.password && String(b.password).length < 8) {
      errors.password = 'Use at least 8 characters';
    }
    if (Object.keys(errors).length) {
      throw new HttpError(400, 'Please correct the highlighted fields.', errors);
    }

    const clash = await db.get('SELECT staff_id FROM staff WHERE staff_id = ?', [b.staffId]);
    if (clash) {
      throw new HttpError(400, 'That Staff ID is already in use.', {
        staffId: 'Already in use',
      });
    }

    await db.run(
      `INSERT INTO staff
         (staff_id, first_name, last_name, role, specialty, email_address, phone_number,
          hashed_password, is_active, date_joined)
       VALUES (?,?,?,?,?,?,?,?,1, COALESCE(?, CURRENT_DATE))`,
      [
        b.staffId,
        b.firstName,
        b.lastName,
        b.role,
        b.specialty || null,
        b.email,
        b.phone || null,
        await bcrypt.hash(String(b.password), 10),
        b.dateJoined || null,
      ],
    );

    await audit(req, 'Created staff account', 'STAFF', b.staffId);
    const row = await db.get('SELECT * FROM staff WHERE staff_id = ?', [b.staffId]);
    return res.status(201).json({ staff: shape(row), message: `${b.staffId} added successfully.` });
  }),
);

/** PATCH /api/staff/:id - edit details or change role (RBAC change). */
router.patch(
  '/:id',
  requireRole('Admin'),
  wrap(async (req, res) => {
    const existing = await db.get('SELECT * FROM staff WHERE staff_id = ?', [req.params.id]);
    if (!existing) throw notFound('Staff account not found.');

    const b = req.body ?? {};
    const map = {
      firstName: 'first_name',
      lastName: 'last_name',
      role: 'role',
      specialty: 'specialty',
      email: 'email_address',
      phone: 'phone_number',
    };

    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(map)) {
      if (b[key] !== undefined) {
        if (key === 'role' && !ROLES.includes(b[key])) {
          throw badRequest('Please correct the highlighted fields.', { role: 'Select a valid role' });
        }
        sets.push(`${column} = ?`);
        params.push(b[key]);
      }
    }
    if (b.password) {
      if (String(b.password).length < 8) {
        throw badRequest('Please correct the highlighted fields.', {
          password: 'Use at least 8 characters',
        });
      }
      sets.push('hashed_password = ?');
      params.push(await bcrypt.hash(String(b.password), 10));
    }

    if (!sets.length) throw badRequest('Nothing to update.');
    params.push(req.params.id);
    await db.run(`UPDATE staff SET ${sets.join(', ')} WHERE staff_id = ?`, params);

    await audit(req, 'Updated staff account', 'STAFF', req.params.id);
    const row = await db.get('SELECT * FROM staff WHERE staff_id = ?', [req.params.id]);
    return res.json({ staff: shape(row), message: 'Account updated.' });
  }),
);

/** POST /api/staff/:id/toggle - activate / deactivate. */
router.post(
  '/:id/toggle',
  requireRole('Admin'),
  wrap(async (req, res) => {
    const existing = await db.get('SELECT * FROM staff WHERE staff_id = ?', [req.params.id]);
    if (!existing) throw notFound('Staff account not found.');

    if (existing.staff_id === req.user.sub) {
      throw badRequest('You cannot deactivate your own account.');
    }

    const next = existing.is_active ? 0 : 1;
    await db.run('UPDATE staff SET is_active = ? WHERE staff_id = ?', [next, req.params.id]);

    await audit(req, next ? 'Activated staff account' : 'Deactivated staff account', 'STAFF', req.params.id);
    const row = await db.get('SELECT * FROM staff WHERE staff_id = ?', [req.params.id]);
    return res.json({
      staff: shape(row),
      message: next ? 'Account activated.' : 'Account deactivated.',
    });
  }),
);

export default router;
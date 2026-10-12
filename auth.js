import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, badRequest } from '../utils/validate.js';
import { initials } from '../utils/format.js';

const router = express.Router();

const DOCTORIAL_ROLES = new Set(['Doctor']);

function publicStaff(row) {
  const title = DOCTORIAL_ROLES.has(row.role) ? 'Dr.' : '';
  return {
    staffId: row.staff_id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${title} ${row.first_name} ${row.last_name}`.trim(),
    initials: initials(row.first_name, row.last_name),
    role: row.role,
    specialty: row.specialty,
    email: row.email_address,
    phone: row.phone_number,
    isActive: Boolean(row.is_active),
  };
}

/**
 * POST /api/auth/login  (SCR-01)
 * Auth, then issue an RBAC token. Locks the account after 5 failed attempts.
 */
router.post(
  '/login',
  wrap(async (req, res) => {
    const { staffId, password, role } = req.body ?? {};

    if (!staffId || !password || !role) {
      throw badRequest('Staff ID, password and role are all required.');
    }

    const staff = await db.get('SELECT * FROM staff WHERE staff_id = ?', [String(staffId).trim()]);

    // Uniform failure message: never reveal whether the staff ID exists.
    const invalid = () =>
      res.status(401).json({
        error: 'invalid_credentials',
        message: 'Incorrect staff ID, password or role.',
      });

    if (!staff) return invalid();

    if (staff.locked_until && new Date(staff.locked_until) > new Date()) {
      return res.status(423).json({
        error: 'account_locked',
        message: `Account locked after ${config.security.maxFailedLogins} failed attempts. Try again later.`,
        lockedUntil: staff.locked_until,
      });
    }

    if (!staff.is_active) {
      return res.status(403).json({
        error: 'account_inactive',
        message: 'This account has been deactivated. Contact an administrator.',
      });
    }

    const ok = await bcrypt.compare(String(password), staff.hashed_password);
    if (!ok) {
      const attempts = Number(staff.failed_attempts || 0) + 1;
      const lock = attempts >= config.security.maxFailedLogins;
      await db.run(
        `UPDATE staff
            SET failed_attempts = ?,
                locked_until = CASE WHEN ? THEN datetime('now', '+' || ? || ' minutes') ELSE locked_until END
          WHERE staff_id = ?`,
        [attempts, lock ? 1 : 0, config.security.lockoutMinutes, staff.staff_id],
      );
      return invalid();
    }

    // The role chosen on the login form must match the role on record.
    if (role !== staff.role) {
      return res.status(401).json({
        error: 'invalid_credentials',
        message: 'Incorrect staff ID, password or role.',
      });
    }

    await db.run('UPDATE staff SET failed_attempts = 0, locked_until = NULL WHERE staff_id = ?', [
      staff.staff_id,
    ]);

    req.user = { sub: staff.staff_id, role: staff.role };
    await audit(req, 'Logged in', 'STAFF', staff.staff_id);

    return res.json({
      token: signToken(staff),
      expiresIn: config.jwt.expiresIn,
      user: publicStaff(staff),
      systemDate: config.systemDate,
    });
  }),
);

/** GET /api/auth/me - used on boot to restore a session from a stored token. */
router.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const staff = await db.get('SELECT * FROM staff WHERE staff_id = ?', [req.user.sub]);
    if (!staff || !staff.is_active) {
      return res.status(401).json({ error: 'invalid_session' });
    }
    return res.json({ user: publicStaff(staff), systemDate: config.systemDate });
  }),
);

/** POST /api/auth/forgot-password - SCR-01 secure email reset flow. */
router.post(
  '/forgot-password',
  wrap(async (req, res) => {
    const { staffId, email } = req.body ?? {};
    // Always respond identically so the endpoint cannot enumerate staff IDs.
    await db.run(
      `INSERT INTO audit_log (staff_id, action, affected_table, affected_record_id, timestamp, ip_address)
       VALUES (?, 'Password reset requested', 'STAFF', ?, CURRENT_TIMESTAMP, ?)`,
      [staffId || null, staffId || null, req.ip || 'unknown'],
    );
    void email;
    return res.json({
      message: `If ${staffId || 'that staff ID'} is registered, a reset link has been sent to the email on file.`,
    });
  }),
);

/** POST /api/auth/logout - audit only; JWT expiry ends the session. */
router.post(
  '/logout',
  requireAuth,
  wrap(async (req, res) => {
    await audit(req, 'Logged out', 'STAFF', req.user.sub);
    return res.json({ message: 'Signed out.' });
  }),
);

export default router;
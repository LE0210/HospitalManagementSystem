/**
 * Role-Based Access Control (SCR-01, SCR-10).
 *
 * Each route declares the roles permitted to call it; `requireRole` denies
 * everything else with 403. The doctor's role also gates clinical modules, so
 * a billing clerk cannot write prescriptions and a nurse cannot issue them.
 */

export const ROLES = [
  'Doctor',
  'Nurse',
  'Pharmacist',
  'Admin',
  'BillingClerk',
  'LabTech',
];

export function requireRole(...allowed) {
  const set = new Set(allowed.flat());
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    if (!set.has(req.user.role)) {
      return res.status(403).json({
        error: 'forbidden',
        message: `Access denied. This action requires: ${[...set].join(', ')}.`,
      });
    }
    return next();
  };
}

/** True when the signed-in user may act as a doctor on this request. */
export const isDoctor = (user) => user?.role === 'Doctor' || user?.role === 'Admin';

export default requireRole;
import { db } from '../db/index.js';

/**
 * Writes a row to AUDIT_LOG (report Section 4.12).
 *
 * Every PHI read or write funnels through here so the audit trail required for
 * POPIA / HIPAA compliance is complete. Logging failures never break the
 * request itself - the clinical operation succeeding matters more than the log.
 */
export function audit(req, action, table, recordId) {
  const staffId = req?.user?.sub ?? null;
  const ip =
    req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    req?.socket?.remoteAddress ||
    'unknown';

  // The SQLite driver is synchronous, so wrap the result to get a real promise.
  return Promise.resolve(
    db.run(
      `INSERT INTO audit_log (staff_id, action, affected_table, affected_record_id, timestamp, ip_address)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [staffId, action, table ?? null, recordId != null ? String(recordId) : null, ip],
    ),
  ).catch((err) => {
    console.error('[audit] failed to record entry:', err.message);
  });
}

export default audit;
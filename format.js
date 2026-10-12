/** Display-number formatting for entities stored with surrogate integer keys. */

/** INV-2026-00472 */
export function invoiceNumber(invoiceId, dateStr) {
  const year = String(dateStr || new Date().toISOString()).slice(0, 4);
  return `INV-${year}-${String(invoiceId).padStart(5, '0')}`;
}

/** RX-4420 */
export function prescriptionNumber(prescriptionId) {
  return `RX-${String(prescriptionId).padStart(4, '0')}`;
}

/** LAB-901 */
export function labNumber(labId) {
  return `LAB-${String(labId).padStart(3, '0')}`;
}

/** CGH-2025-00098 */
export function patientIdFromSequence(year, n) {
  return `CGH-${year}-${String(n).padStart(5, '0')}`;
}

export const money = (n) =>
  Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const initials = (first = '', last = '') =>
  `${String(first).charAt(0)}${String(last).charAt(0)}`.toUpperCase();
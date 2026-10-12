/** Validation helpers shared by the route modules. */

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);

/** 13-digit South African ID number (13 digits, Luhn-style month/day sanity). */
export function isValidSaIdNumber(value) {
  if (!/^\d{13}$/.test(String(value ?? ''))) return false;
  const yy = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  const dd = Number(value.slice(4, 6));
  if (mm < 1 || mm > 12) return false;
  if (dd < 1 || dd > 31) return false;
  return yy >= 0;
}

export const isValidPhone = (value) => /^[0-9+\-\s()]{7,15}$/.test(String(value ?? ''));

export const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? ''));

/** Collects `{ field: message }` errors, throwing 400 if any were found. */
export function assertNoErrors(errors) {
  const keys = Object.keys(errors);
  if (keys.length) {
    throw badRequest('Please correct the highlighted fields.', errors);
  }
}

export function requireFields(body, fields) {
  const errors = {};
  for (const f of fields) {
    const v = body?.[f];
    if (v === undefined || v === null || String(v).trim() === '') {
      errors[f] = 'Required';
    }
  }
  assertNoErrors(errors);
  return body;
}

/** Express async handler wrapper so thrown errors reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export default wrap;
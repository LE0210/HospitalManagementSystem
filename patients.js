import express from 'express';
import { db, nextSequenceValue } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { audit } from '../middleware/audit.js';
import {
  wrap,
  badRequest,
  notFound,
  isValidSaIdNumber,
  isValidPhone,
  isValidEmail,
  assertNoErrors,
} from '../utils/validate.js';
import { initials } from '../utils/format.js';

const router = express.Router();
router.use(requireAuth);

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

export function shapePatient(row) {
  return {
    patientId: row.patient_id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`,
    initials: initials(row.first_name, row.last_name),
    dateOfBirth: row.date_of_birth,
    age: ageFrom(row.date_of_birth),
    gender: row.gender,
    idNumber: row.id_number,
    phoneNumber: row.phone_number,
    emailAddress: row.email_address,
    physicalAddress: row.physical_address,
    bloodType: row.blood_type,
    medicalAidProvider: row.medical_aid_provider,
    medicalAidNumber: row.medical_aid_number,
    emergencyContactName: row.emergency_contact_name,
    emergencyContactPhone: row.emergency_contact_phone,
    registrationDate: row.registration_date,
  };
}

const SELECT_PATIENT = 'SELECT p.* FROM patient p';

function ageFrom(dob) {
  if (!dob) return null;
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    now.getMonth() < birth.getMonth() ||
    (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/** GET /api/patients - list + search, powers the Patients screen. */
router.get(
  '/',
  wrap(async (req, res) => {
    const { q = '', limit = 100 } = req.query;
    const like = `%${String(q).trim()}%`;
    const rows = await db.all(
      `${SELECT_PATIENT}
        WHERE (? = '%%' OR p.patient_id LIKE ? OR p.first_name LIKE ?
               OR p.last_name LIKE ? OR p.phone_number LIKE ?)
        ORDER BY p.last_name, p.first_name
        LIMIT ?`,
      [like, like, like, like, like, Number(limit)],
    );
    await audit(req, `Viewed patient list (${rows.length} records)`, 'PATIENT', null);
    return res.json({ patients: rows.map(shapePatient) });
  }),
);

/** GET /api/patients/:id - the EHR header data (SCR-04). */
router.get(
  '/:id',
  wrap(async (req, res) => {
    const row = await db.get(`${SELECT_PATIENT} WHERE p.patient_id = ?`, [req.params.id]);
    if (!row) throw notFound('Patient not found.');
    await audit(req, 'Accessed patient record', 'PATIENT', row.patient_id);
    return res.json({ patient: shapePatient(row) });
  }),
);

/**
 * POST /api/patients (SCR-02)
 * Generates the Patient ID and creates the EHR shell in one transaction.
 */
router.post(
  '/',
  requireRole('Admin', 'BillingClerk'),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const errors = {};

    ['firstName', 'lastName', 'dateOfBirth', 'gender', 'phoneNumber'].forEach((f) => {
      if (!b[f] || !String(b[f]).trim()) errors[f] = 'Required';
    });

    if (b.idNumber && !isValidSaIdNumber(b.idNumber)) {
      errors.idNumber = 'ID number must be 13 digits';
    }
    if (b.phoneNumber && !isValidPhone(b.phoneNumber)) {
      errors.phoneNumber = 'Enter a valid phone number';
    }
    if (b.emailAddress && !isValidEmail(b.emailAddress)) {
      errors.emailAddress = 'Enter a valid email address';
    }
    if (b.bloodType && !BLOOD_TYPES.includes(b.bloodType)) {
      errors.bloodType = 'Select a valid blood type';
    }
    if (!['M', 'F', 'X'].includes(b.gender)) {
      errors.gender = 'Select a gender';
    }

    assertNoErrors(errors);

    const year = new Date(b.dateOfBirth || Date.now()).getFullYear();
    const seq = await nextSequenceValue('patient', new Date().getFullYear());
    const patientId = `CGH-${new Date().getFullYear()}-${String(seq).padStart(5, '0')}`;
    void year;

    const created = await db.transaction(async (exec) => {
      await exec.run(
        `INSERT INTO patient
           (patient_id, first_name, last_name, date_of_birth, gender, id_number,
            phone_number, email_address, physical_address, blood_type,
            medical_aid_provider, medical_aid_number, emergency_contact_name,
            emergency_contact_phone, registration_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`,
        [
          patientId,
          b.firstName.trim(),
          b.lastName.trim(),
          b.dateOfBirth,
          b.gender,
          b.idNumber || null,
          b.phoneNumber.trim(),
          b.emailAddress || null,
          b.physicalAddress || null,
          b.bloodType || null,
          b.medicalAidProvider || null,
          b.medicalAidNumber || null,
          b.emergencyContactName || null,
          b.emergencyContactPhone || null,
        ],
      );

      // Registration opens the patient's EHR so clinical staff have a record to
      // write into from the first visit.
      await exec.run(
        `INSERT INTO ehr_record (patient_id, recorded_by, visit_date, diagnosis, treatment_notes, allergies)
         VALUES (?, ?, CURRENT_TIMESTAMP, 'Patient registered', ?, NULL)`,
        [patientId, req.user.sub, `Registered at Community General Hospital.`],
      );
      return await exec.get(`${SELECT_PATIENT} WHERE p.patient_id = ?`, [patientId]);
    });

    await audit(req, 'Registered new patient', 'PATIENT', patientId);
    return res.status(201).json({
      patient: shapePatient(created),
      message: `Patient ${patientId} registered successfully.`,
    });
  }),
);

/** PATCH /api/patients/:id - demographics edit (SCR-04 "Edit Demographics"). */
router.patch(
  '/:id',
  requireRole('Admin', 'BillingClerk', 'Doctor', 'Nurse'),
  wrap(async (req, res) => {
    const existing = await db.get('SELECT * FROM patient WHERE patient_id = ?', [req.params.id]);
    if (!existing) throw notFound('Patient not found.');

    const b = req.body ?? {};
    if (b.idNumber && !isValidSaIdNumber(b.idNumber)) {
      throw badRequest('Please correct the highlighted fields.', {
        idNumber: 'ID number must be 13 digits',
      });
    }
    if (b.emailAddress && !isValidEmail(b.emailAddress)) {
      throw badRequest('Please correct the highlighted fields.', {
        emailAddress: 'Enter a valid email address',
      });
    }

    const map = {
      firstName: 'first_name',
      lastName: 'last_name',
      dateOfBirth: 'date_of_birth',
      gender: 'gender',
      idNumber: 'id_number',
      phoneNumber: 'phone_number',
      emailAddress: 'email_address',
      physicalAddress: 'physical_address',
      bloodType: 'blood_type',
      medicalAidProvider: 'medical_aid_provider',
      medicalAidNumber: 'medical_aid_number',
      emergencyContactName: 'emergency_contact_name',
      emergencyContactPhone: 'emergency_contact_phone',
    };

    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(map)) {
      if (b[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(b[key]);
      }
    }
    if (!sets.length) throw badRequest('Nothing to update.');

    params.push(req.params.id);
    await db.run(`UPDATE patient SET ${sets.join(', ')} WHERE patient_id = ?`, params);

    await audit(req, 'Updated patient demographics', 'PATIENT', req.params.id);
    const row = await db.get(`${SELECT_PATIENT} WHERE p.patient_id = ?`, [req.params.id]);
    return res.json({ patient: shapePatient(row) });
  }),
);

export default router;
export { BLOOD_TYPES };
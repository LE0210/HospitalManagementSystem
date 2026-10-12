import bcrypt from 'bcryptjs';
import { db, migrate, isEmpty } from '../db/index.js';

/**
 * Demo dataset for the Phase 3 prototype.
 *
 * The records mirror the figures in the Phase 3 report's interface mock-ups:
 * 8 staff accounts, 6 patients, the four appointments on 12 May 2026, the
 * FBC result set for Sara Dlamini, and the four outstanding invoices.
 * Surrogate keys are inserted explicitly so the derived display numbers
 * (INV-2026-00472, RX-4420, LAB-901) match the report exactly.
 */

const TODAY = '2026-05-12';

/** Rows created by the seeder, so --force can remove exactly what we added. */
async function truncate() {
  const driver = process.env.DB_DRIVER === 'mysql' ? 'MySQL' : 'SQLite';
  if (driver === 'MySQL') {
    await db.run('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [
      'audit_log', 'payment', 'invoice_item', 'invoice', 'lab_result', 'lab_order',
      'inventory', 'prescription_item', 'prescription', 'medication', 'ehr_record',
      'appointment', 'patient', 'staff', 'id_sequence',
    ]) {
      await db.run(`TRUNCATE TABLE ${t}`);
    }
    await db.run('SET FOREIGN_KEY_CHECKS = 1');
    return;
  }
  for (const t of [
    'audit_log', 'payment', 'invoice_item', 'invoice', 'lab_result', 'lab_order',
    'inventory', 'prescription_item', 'prescription', 'medication', 'ehr_record',
    'appointment', 'patient', 'staff', 'id_sequence',
  ]) {
    await db.run(`DELETE FROM ${t}`);
  }
}

export async function seed({ force = false } = {}) {
  await migrate();

  if (!force && !(await isEmpty())) {
    return { seeded: false, reason: 'Database already contains data. Use --force to reseed.' };
  }

  await truncate();

  // --- Staff ----------------------------------------------------------------
  // Passwords follow the demo credentials printed on the login screen.
  const passwords = {
    Doctor: 'doctor123',
    Nurse: 'nurse123',
    Pharmacist: 'pharm123',
    Admin: 'admin123',
    BillingClerk: 'billing123',
    LabTech: 'labtech123',
  };

  const staffSeed = [
    ['DR001', 'Aisha', 'Naidoo', 'Doctor', 'General Practice', 'a.naidoo@cgh.co.za', '0821234567', 1, '2019-03-04'],
    ['DR002', 'James', 'Sithole', 'Doctor', 'Cardiology', 'jsithole@cgh.co.za', '0829876543', 1, '2017-08-21'],
    ['NR001', 'Nomsa', 'Khumalo', 'Nurse', null, 'n.khumalo@cgh.co.za', '0834567890', 1, '2021-01-11'],
    ['NR002', 'Thandi', 'Dube', 'Nurse', null, 't.dube@cgh.co.za', '0836543210', 1, '2022-06-13'],
    ['PH001', 'Leon', 'Fortuin', 'Pharmacist', null, 'l.fortuin@cgh.co.za', '0812345678', 1, '2020-02-17'],
    ['AD001', 'Amanda', 'Jacobs', 'Admin', null, 'a.jacobs@cgh.co.za', '0871234567', 1, '2018-11-05'],
    ['BC001', 'Themba', 'Sithole', 'BillingClerk', null, 'tsithole@cgh.co.za', '0843456789', 0, '2023-04-02'],
    ['LT001', 'Priya', 'Govender', 'LabTech', null, 'p.govender@cgh.co.za', '0856789012', 1, '2021-09-27'],
  ];

  const hashCache = new Map();
  for (const [id, first, last, role, specialty, email, phone, active, joined] of staffSeed) {
    if (!hashCache.has(role)) hashCache.set(role, await bcrypt.hash(passwords[role], 10));
    await db.run(
      `INSERT INTO staff
         (staff_id, first_name, last_name, role, specialty, email_address, phone_number,
          hashed_password, is_active, date_joined)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, first, last, role, specialty, email, phone, hashCache.get(role), active, joined],
    );
  }

  // --- Patients -------------------------------------------------------------
  const patients = [
    ['CGH-2025-00098', 'John', 'Mokoena', '1985-06-03', 'M', '8506035467890', '0731234567', 'john.mokoena@email.com',
      '18 Berea Road, Kimberley, 8301', 'O+', 'Discovery Health', 'DH998213', 'Thandi Mokoena', '0731234567', '2025-02-11 09:14'],
    ['CGH-2025-00211', 'Sara', 'Dlamini', '1992-11-18', 'F', '9211180322087', '0725551234', 'sara.dlamini@email.com',
      '44 Hanover Street, Kimberley, 8301', 'A-', 'Momentum Health', 'MH445120', 'Thabo Dlamini', '0725551235', '2025-03-02 10:41'],
    ['CGH-2025-00334', 'David', 'Petersen', '1978-03-22', 'M', '7803225119048', '0712345678', 'david.petersen@email.com',
      '7 Jones Street, Kimberley, 8301', 'B+', 'Bonitas', 'BT778291', 'Lene Petersen', '0712345679', '2025-04-19 14:02'],
    ['CGH-2025-00167', 'Lindiwe', 'Zulu', '1969-09-30', 'F', '6909300212088', '0744556677', 'lindiwe.zulu@email.com',
      '220 Preez Street, Kimberley, 8301', 'O-', null, null, 'Nomvula Zulu', '0744556678', '2025-01-08 08:55'],
    ['CGH-2025-00355', 'Michael', 'van der Berg', '1981-01-14', 'M', '8101145078091', '0766778899', 'michael.vdb@email.com',
      '9 Fleet Street, Kimberley, 8301', 'A+', 'Discovery Health', 'DH332014', 'Elsie van der Berg', '0766778890', '2025-05-06 11:20'],
    ['CGH-2026-00412', 'Sibongile', 'Ndlovu', '1996-07-07', 'F', '9607070432085', '0701234567', 'sibongile.ndlovu@email.com',
      '31 Phillip Street, Kimberley, 8301', 'AB+', 'GEMS', 'GM902133', 'Ayanda Ndlovu', '0701234568', '2026-05-12 08:30'],
  ];

  for (const p of patients) {
    await db.run(
      `INSERT INTO patient
         (patient_id, first_name, last_name, date_of_birth, gender, id_number, phone_number,
          email_address, physical_address, blood_type, medical_aid_provider, medical_aid_number,
          emergency_contact_name, emergency_contact_phone, registration_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p,
    );
  }

  // Patient IDs generated by SCR-02 must continue past the seeded range
  // (highest seeded id is CGH-2026-00412).
  await db.run(
    `INSERT INTO id_sequence (entity, year, current_value) VALUES ('patient', ?, 412)
     ON CONFLICT(entity) DO UPDATE SET year = 412, current_value = 412`,
    [new Date().getFullYear()],
  );

  // --- EHR records ----------------------------------------------------------
  const ehr = [
    [1, 'CGH-2025-00098', 'DR001', '2024-11-10 09:30', 'Hypertension (Stage 1)',
      'Started Amlodipine 5mg daily. Advised low-sodium diet and exercise.', null, '2025-02-10'],
    [2, 'CGH-2025-00098', 'DR002', '2024-08-22 11:05', 'Type 2 Diabetes Mellitus',
      'Started Metformin 500mg twice daily. HbA1c monitoring required quarterly.', null, '2024-11-22'],
    [3, 'CGH-2025-00098', 'DR001', '2023-03-15 08:45', 'Seasonal Allergic Rhinitis',
      'Started antihistamine as needed during spring.', null, '2023-03-29'],
    [4, 'CGH-2025-00211', 'DR001', '2026-05-12 09:30', 'Iron Deficiency Anaemia',
      'Full blood count shows microcytic anaemia. Commencing oral iron.',
      'Sulfonamides', '2026-06-23'],
    [5, 'CGH-2025-00211', 'DR001', '2025-11-04 10:15', 'Anaemia follow-up',
      'Dietary iron advised. Repeat FBC in six weeks.', 'Sulfonamides', '2026-05-12'],
    [6, 'CGH-2025-00167', 'DR002', '2026-05-10 14:00', 'Paroxysmal Supraventricular Tachycardia',
      'Holter monitoring confirms paroxysmal SVT. Refer for cardiology review.', null, '2026-06-10'],
    [7, 'CGH-2025-00334', 'DR001', '2026-05-06 09:00', 'Hyperlipidaemia',
      'Started statin therapy alongside lifestyle modification.', null, '2026-08-06'],
    [8, 'CGH-2026-00412', 'AD001', '2026-05-12 08:30', 'Patient registered',
      'Registered at Community General Hospital.', null, null],
  ];
  for (const e of ehr) {
    await db.run(
      `INSERT INTO ehr_record
         (ehr_id, patient_id, recorded_by, visit_date, diagnosis, treatment_notes, allergies, follow_up_date)
       VALUES (?,?,?,?,?,?,?,?)`,
      e,
    );
  }

  // --- Medications + inventory ---------------------------------------------
  const meds = [
    ['Metformin 500mg', 'MET-500', 'Antidiabetic', 'Tablet', 100, 1, 480, '2026-11-30', 'Cipla South Africa', 4.5],
    ['Amlodipine 5mg', 'AML-005', 'Antihypertensive', 'Tablet', 80, 1, 64, '2027-01-31', 'PharmActi', 6.2],
    ['Bisoprolol 5mg', 'BIS-005', 'Beta-blocker', 'Tablet', 60, 1, 48, '2026-09-15', 'PharmActi', 9.8],
    ['Losartan 50mg', 'LOS-050', 'Antihypertensive', 'Tablet', 80, 1, 0, '2027-03-31', 'Cipla South Africa', 7.1],
    ['Atorvastatin 20mg', 'ATO-020', 'Antihyperlipidaemic', 'Tablet', 70, 1, 95, '2026-12-31', 'PharmActi', 12.4],
    ['Amoxicillin 500mg', 'AMX-500', 'Antibiotic', 'Capsule', 120, 1, 210, '2026-08-31', 'PharmActi', 3.9],
    ['Paracetamol 500mg', 'PAR-500', 'Analgesic', 'Tablet', 150, 1, 640, '2027-04-30', 'Generic supplier', 1.2],
    ['Ibuprofen 400mg', 'IBU-400', 'Analgesic', 'Tablet', 150, 1, 18, '2026-10-31', 'Generic supplier', 2.4],
    ['Co-trimoxazole 960mg', 'COT-960', 'Sulfonamides', 'Tablet', 40, 1, 7, '2026-07-31', 'PharmActi', 5.6],
    ['Insulin Glargine', 'INS-GLR', 'Antidiabetic', 'Injection', 25, 1, 11, '2026-06-30', 'Sanofi', 285.0],
    ['Levothyroxine 100mcg', 'LEV-100', 'Thyroid hormone', 'Tablet', 60, 1, 132, '2027-05-31', 'Cipla South Africa', 8.8],
    ['Ferrous Sulphate 200mg', 'FER-200', 'Supplement', 'Tablet', 100, 1, 58, '2026-11-30', 'Generic supplier', 2.1],
  ];
  // medication_id is the 1-based position in this list (prescription_item below
  // references these ids directly, so the order matters).
  let medicationId = 0;
  for (const m of meds) {
    medicationId += 1;
    await db.run(
      `INSERT INTO medication
         (medication_id, drug_name, drug_code, category, unit_of_measure, reorder_level, formulary)
       VALUES (?,?,?,?,?,?,1)`,
      [medicationId, ...m.slice(0, 5)],
    );
    // meds columns: 0 name, 1 code, 2 category, 3 unit, 4 reorder, 5 formulary,
    // 6 qty, 7 expiry, 8 supplier, 9 unit cost.
    await db.run(
      `INSERT INTO inventory
         (medication_id, quantity_in_stock, expiry_date, last_restocked, supplier, unit_cost)
       VALUES (?,?,?, CURRENT_TIMESTAMP, ?, ?)`,
      [medicationId, m[6], m[7], m[8], m[9]],
    );
  }

  // --- Prescriptions --------------------------------------------------------
  const rx = [
    [4420, 'CGH-2025-00098', 'DR001', '2026-05-12 08:40', 'Dispensed', 'Routine', 'Dispensed without issues.', '2026-05-12 08:55'],
    [4421, 'CGH-2025-00211', 'DR001', '2026-05-12 09:45', 'Pending', 'Urgent', 'Anaemia - iron therapy required.', null],
    [4422, 'CGH-2025-00167', 'DR002', '2026-05-10 14:10', 'Pending', 'Routine', 'Cardiology review pending.', null],
  ];
  for (const r of rx) {
    await db.run(
      `INSERT INTO prescription
         (prescription_id, patient_id, doctor_id, prescribed_date, status, priority, pharmacy_notes, dispensed_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      r,
    );
  }

  const rxItems = [
    [4420, 1, '500mg', 'Twice daily', 30, 'Oral', 'Take with food.'],
    [4420, 2, '5mg', 'Once daily', 30, 'Oral', 'Take in the morning.'],
    [4421, 12, '200mg', 'Once daily', 42, 'Oral', 'Take on an empty stomach.'],
    [4422, 3, '5mg', 'Once daily', 30, 'Oral', 'Do not stop abruptly.'],
  ];
  for (const i of rxItems) {
    await db.run(
      `INSERT INTO prescription_item
         (prescription_id, medication_id, dosage, frequency, duration_days, route, instructions)
       VALUES (?,?,?,?,?,?,?)`,
      i,
    );
  }

  // --- Appointments ---------------------------------------------------------
  const appts = [
    ['CGH-2025-00098', 'DR001', TODAY, '09:00', 'Consultation', 'Routine check-up', 'Scheduled', 1, '2026-04-30 09:00'],
    ['CGH-2025-00211', 'DR001', TODAY, '09:30', 'Follow-up', 'Anaemia follow-up', 'Scheduled', 1, '2026-04-30 09:05'],
    ['CGH-2025-00334', 'DR001', TODAY, '10:00', 'Consultation', 'Lab review', 'Scheduled', 0, '2026-05-05 11:20'],
    ['CGH-2025-00167', 'DR002', TODAY, '11:00', 'Consultation', 'Cardiology consult', 'Scheduled', 1, '2026-04-28 15:10'],
    ['CGH-2025-00355', 'DR002', '2026-05-13', '08:30', 'Follow-up', 'Lipid results review', 'Scheduled', 1, '2026-05-10 10:00'],
    ['CGH-2025-00334', 'DR001', '2026-05-06', '09:00', 'Consultation', 'Lipid panel follow-up', 'Completed', 1, '2026-04-25 09:00'],
    ['CGH-2025-00098', 'DR001', '2026-05-04', '08:30', 'Follow-up', 'Blood pressure review', 'NoShow', 1, '2026-04-20 08:00'],
    ['CGH-2025-00211', 'DR001', '2026-04-28', '10:00', 'Consultation', 'FBC results', 'Completed', 1, '2026-04-21 09:30'],
    ['CGH-2025-00167', 'DR002', '2026-04-30', '14:00', 'Consultation', 'Holter fitting', 'Completed', 1, '2026-04-25 09:00'],
    ['CGH-2025-00355', 'DR001', '2026-05-08', '09:00', 'Procedure', 'Minor procedure', 'Cancelled', 0, '2026-05-01 09:00'],
  ];
  for (const a of appts) {
    await db.run(
      `INSERT INTO appointment
         (patient_id, doctor_id, appointment_date, appointment_time, appointment_type,
          reason, status, reminder_sent, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      a,
    );
  }

  // Historical volume for the previous four months so the Reports monthly
  // chart (SCR-11) shows a meaningful trend rather than a single data point.
  const history = [
    ['2026-01-06', 6], ['2026-01-13', 7], ['2026-01-20', 6], ['2026-01-27', 7],
    ['2026-02-03', 7], ['2026-02-10', 6], ['2026-02-17', 8], ['2026-02-24', 7],
    ['2026-03-03', 8], ['2026-03-10', 7], ['2026-03-17', 8], ['2026-03-24', 8],
    ['2026-04-07', 8], ['2026-04-14', 7], ['2026-04-21', 8], ['2026-04-28', 7],
  ];
  const reasons = ['Routine check-up', 'Follow-up review', 'New consultation', 'Lab review', 'Medication review'];
  const slots = ['08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00'];

  let n = 0;
  for (const [day, count] of history) {
    for (let i = 0; i < count; i += 1) {
      const patient = patients[n % patients.length];
      const doctor = n % 3 === 2 ? 'DR002' : 'DR001';
      // Roughly an 8% no-show rate, in line with the KPIs in the report.
      const status = n % 11 === 0 ? 'NoShow' : n % 5 === 0 ? 'Cancelled' : 'Completed';
      await db.run(
        `INSERT INTO appointment
           (patient_id, doctor_id, appointment_date, appointment_time, appointment_type,
            reason, status, reminder_sent, created_at)
         VALUES (?,?,?,?,?,?,?,1,?)`,
        [
          patient[0], doctor, day, slots[n % slots.length],
          n % 4 === 0 ? 'Follow-up' : 'Consultation',
          reasons[n % reasons.length], status, `${day} 08:00:00`,
        ],
      );
      n += 1;
    }
  }

  // --- Lab orders and results ------------------------------------------------
  const labs = [
    [901, 'CGH-2025-00211', 'DR001', 'Full Blood Count (FBC)', '2026-05-12 09:20', 'Completed', 'Routine'],
    [902, 'CGH-2025-00098', 'DR001', 'HbA1c & Fasting Glucose', '2026-05-12 09:35', 'InProgress', 'Routine'],
    [903, 'CGH-2025-00355', 'DR001', 'Lipid Profile', '2026-05-11 11:10', 'Ordered', 'Routine'],
    [904, 'CGH-2025-00167', 'DR002', 'ECG + Holter', '2026-05-10 13:50', 'Completed', 'Urgent'],
    [905, 'CGH-2025-00334', 'DR001', 'Lipid Profile', '2026-05-06 09:10', 'Completed', 'Routine'],
  ];
  for (const l of labs) {
    await db.run(
      `INSERT INTO lab_order (lab_id, patient_id, ordered_by, test_name, order_date, status, urgency)
       VALUES (?,?,?,?,?,?,?)`,
      l,
    );
  }

  const fbcSara = [
    { parameter: 'Haemoglobin', result: '11.2 g/dL', range: '12.0–16.0 g/dL', flag: 'LOW' },
    { parameter: 'White Cell Count', result: '8.5 ×10⁹/L', range: '4.0–11.0 ×10⁹/L', flag: 'Normal' },
    { parameter: 'Platelets', result: '290 ×10⁹/L', range: '150–400 ×10⁹/L', flag: 'Normal' },
    { parameter: 'MCV', result: '72 fL', range: '80–100 fL', flag: 'LOW' },
    { parameter: 'Serum Ferritin', result: '8 µg/L', range: '12–150 µg/L', flag: 'LOW' },
  ];

  const ecgLindiwe = [
    { parameter: 'Average Heart Rate', result: '112 bpm', range: '60–100 bpm', flag: 'HIGH' },
    { parameter: 'SVT Episodes (24h)', result: '3 episodes', range: '0 episodes', flag: 'ABNORMAL' },
    { parameter: 'PR Interval', result: '164 ms', range: '120–200 ms', flag: 'Normal' },
    { parameter: 'QRS Duration', result: '92 ms', range: '80–100 ms', flag: 'Normal' },
  ];

  const lipidDavid = [
    { parameter: 'Total Cholesterol', result: '4.9 mmol/L', range: '< 5.2 mmol/L', flag: 'Normal' },
    { parameter: 'LDL Cholesterol', result: '3.1 mmol/L', range: '< 3.0 mmol/L', flag: 'HIGH' },
    { parameter: 'HDL Cholesterol', result: '1.2 mmol/L', range: '> 1.0 mmol/L', flag: 'Normal' },
    { parameter: 'Triglycerides', result: '1.7 mmol/L', range: '< 1.7 mmol/L', flag: 'Normal' },
  ];

  const results = [
    [901, 'LT001', fbcSara, 'Mild anaemia – recommend dietary iron supplementation and follow-up in 6 weeks', '2026-05-12 10:20', 1],
    [904, 'LT001', ecgLindiwe, 'Paroxysmal SVT episodes noted on Holter. Refer for cardiology review.', '2026-05-10 15:40', 1],
    [905, 'LT001', lipidDavid, 'LDL marginally raised. Continue statin therapy and recheck in 3 months.', '2026-05-06 13:05', 1],
  ];
  for (const [labId, tech, data, notes, date, abnormal] of results) {
    await db.run(
      `INSERT INTO lab_result
         (lab_id, uploaded_by, result_data, technician_notes, result_date, abnormal_flag)
       VALUES (?,?,?,?,?,?)`,
      [labId, tech, JSON.stringify(data), notes, date, abnormal],
    );
  }

  // --- Invoices --------------------------------------------------------------
  // aid_covers + patient_owing must equal total_amount on every row.
  const invoices = [
    [472, 'CGH-2025-00098', 'BC001', '2026-05-12 11:00', 950.0, 790.0, 160.0, 'PartiallyPaid'],
    [471, 'CGH-2025-00211', 'BC001', '2026-05-12 10:50', 1380.0, 1100.0, 280.0, 'PartiallyPaid'],
    [468, 'CGH-2025-00334', 'BC001', '2026-05-10 11:00', 720.0, 720.0, 0.0, 'Paid'],
    [465, 'CGH-2025-00167', 'BC001', '2026-05-08 11:00', 2800.0, 0.0, 2800.0, 'Unpaid'],
  ];
  for (const i of invoices) {
    await db.run(
      `INSERT INTO invoice
         (invoice_id, patient_id, created_by, invoice_date, total_amount, aid_covers, patient_owing, status)
       VALUES (?,?,?,?,?,?,?,?)`,
      i,
    );
  }

  const invoiceItems = [
    [472, 'Consultation - General Practice', 'Consultation', 320],
    [472, 'Laboratory: HbA1c & Fasting Glucose', 'Lab', 180],
    [472, 'Pharmacy: 2 medication(s) dispensed', 'Pharmacy', 190],
    [472, 'Follow-up consultation', 'Consultation', 260],
    [471, 'Consultation - General Practice', 'Consultation', 320],
    [471, 'Laboratory: Full Blood Count (FBC)', 'Lab', 180],
    [471, 'Iron therapy - course', 'Pharmacy', 440],
    [471, 'Procedure: dressing', 'Procedure', 440],
    [468, 'Consultation - General Practice', 'Consultation', 320],
    [468, 'Laboratory: Lipid Profile', 'Lab', 180],
    [468, 'Statin therapy - 3 months', 'Pharmacy', 220],
    [465, 'Cardiology consultation - Holter fitting', 'Consultation', 1800],
    [465, 'ECG + Holter monitoring', 'Procedure', 1000],
  ];
  for (const i of invoiceItems) {
    await db.run('INSERT INTO invoice_item (invoice_id, description, category, amount) VALUES (?,?,?,?)', i);
  }

  await db.run(
    `INSERT INTO payment (invoice_id, amount, method, paid_at, received_by)
     VALUES (468, 720.00, 'MedicalAid', '2026-05-10 11:05', 'BC001')`,
  );
  await db.run(
    `INSERT INTO payment (invoice_id, amount, method, paid_at, received_by)
     VALUES (472, 790.00, 'MedicalAid', '2026-05-12 11:02', 'BC001')`,
  );

  // --- Audit log -------------------------------------------------------------
  const audit = [
    ['DR001', 'Accessed patient EHR (CGH-2025-00098)', 'EHR_RECORD', 'CGH-2025-00098', '2026-05-12 09:12:00', '192.168.1.101'],
    ['PH001', 'Dispensed prescription (RX-4420)', 'PRESCRIPTION', '4420', '2026-05-12 08:55:00', '192.168.1.105'],
    ['AD001', 'Registered new patient (CGH-2026-00412)', 'PATIENT', 'CGH-2026-00412', '2026-05-12 08:30:00', '192.168.1.102'],
    ['DR001', 'Created prescription (RX-4421)', 'PRESCRIPTION', '4421', '2026-05-12 09:45:00', '192.168.1.101'],
    ['LT001', 'Uploaded lab results (LAB-901)', 'LAB_RESULT', '901', '2026-05-12 10:20:00', '192.168.1.108'],
    ['BC001', 'Generated invoice (INV-2026-00472)', 'INVOICE', '472', '2026-05-12 11:00:00', '192.168.1.103'],
    ['DR002', 'Accessed patient EHR (CGH-2025-00167)', 'EHR_RECORD', 'CGH-2025-00167', '2026-05-10 14:05:00', '192.168.1.104'],
    ['NR001', 'Recorded vitals (CGH-2025-00098)', 'EHR_RECORD', 'CGH-2025-00098', '2026-05-12 08:48:00', '192.168.1.106'],
  ];
  for (const a of audit) {
    await db.run(
      `INSERT INTO audit_log (staff_id, action, affected_table, affected_record_id, timestamp, ip_address)
       VALUES (?,?,?,?,?,?)`,
      a,
    );
  }

  return {
    seeded: true,
    staff: staffSeed.length,
    patients: patients.length,
    appointments: appts.length,
    prescriptions: rx.length,
    labOrders: labs.length,
    invoices: invoices.length,
  };
}

export default seed;
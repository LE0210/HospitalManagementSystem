-- ============================================================================
-- HMS - Community General Hospital
-- SQLite schema (runtime default for the Phase 3 prototype)
--
-- Mirrors the Phase 3 report, Section 4 "Entity Descriptions" and the ERD in
-- Section 3. Column names, types and constraints follow the documented data
-- dictionary. ENUM columns are implemented as TEXT + CHECK so that the exact
-- same table definitions can be translated to MySQL 8 (see db/schema.mysql.sql).
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 4.1 PATIENT ---------------------------------------------------------------
-- Core demographic and contact information for every registered patient.
CREATE TABLE IF NOT EXISTS patient (
  patient_id                TEXT PRIMARY KEY,          -- e.g. CGH-2025-00098
  first_name                TEXT    NOT NULL,
  last_name                 TEXT    NOT NULL,
  date_of_birth             DATE    NOT NULL,
  gender                    TEXT    NOT NULL CHECK (gender IN ('M','F','X')),
  id_number                 TEXT,
  phone_number              TEXT    NOT NULL,
  email_address             TEXT,
  physical_address          TEXT,
  blood_type                TEXT,
  medical_aid_provider      TEXT,
  medical_aid_number        TEXT,
  emergency_contact_name    TEXT,
  emergency_contact_phone   TEXT,
  registration_date         DATETIME NOT NULL
);

-- 4.2 STAFF -----------------------------------------------------------------
-- All hospital employees. `role` drives role-based access control (RBAC).
CREATE TABLE IF NOT EXISTS staff (
  staff_id        TEXT PRIMARY KEY,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN
                    ('Doctor','Nurse','Pharmacist','Admin','BillingClerk','LabTech')),
  specialty       TEXT,
  email_address   TEXT,
  phone_number    TEXT,
  hashed_password TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT 1,
  date_joined     DATE NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    DATETIME
);

-- 4.3 APPOINTMENT -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment (
  appointment_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id       TEXT NOT NULL REFERENCES patient(patient_id) ON DELETE CASCADE,
  doctor_id        TEXT NOT NULL REFERENCES staff(staff_id),
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  appointment_type TEXT NOT NULL CHECK (appointment_type IN
                      ('Consultation','Follow-up','Procedure')),
  reason           TEXT,
  status           TEXT NOT NULL DEFAULT 'Scheduled' CHECK (status IN
                      ('Scheduled','Completed','Cancelled','NoShow')),
  reminder_sent    BOOLEAN NOT NULL DEFAULT 0,
  created_at       DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appt_doctor_date
  ON appointment (doctor_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_appt_patient
  ON appointment (patient_id);

-- 4.4 EHR_RECORD ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ehr_record (
  ehr_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     TEXT NOT NULL REFERENCES patient(patient_id) ON DELETE CASCADE,
  recorded_by    TEXT NOT NULL REFERENCES staff(staff_id),
  visit_date     DATETIME NOT NULL,
  diagnosis      TEXT,
  treatment_notes TEXT,
  allergies      TEXT,
  follow_up_date DATE
);

CREATE INDEX IF NOT EXISTS idx_ehr_patient ON ehr_record (patient_id);

-- 4.5 PRESCRIPTION ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS prescription (
  prescription_id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id      TEXT    NOT NULL REFERENCES patient(patient_id) ON DELETE CASCADE,
  doctor_id       TEXT    NOT NULL REFERENCES staff(staff_id),
  prescribed_date DATETIME NOT NULL,
  status          TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN
                     ('Pending','Dispensed','Cancelled')),
  priority        TEXT NOT NULL DEFAULT 'Routine' CHECK (priority IN
                     ('Urgent','Routine')),
  pharmacy_notes  TEXT,
  dispensed_at    DATETIME
);

CREATE INDEX IF NOT EXISTS idx_rx_status ON prescription (status, priority);

-- 4.6 MEDICATION ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS medication (
  medication_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  drug_name      TEXT NOT NULL,
  drug_code      TEXT UNIQUE,
  category       TEXT,
  unit_of_measure TEXT,
  reorder_level  INTEGER NOT NULL DEFAULT 0,
  formulary      BOOLEAN NOT NULL DEFAULT 1
);

-- 4.7 PRESCRIPTION_ITEM (bridge table) --------------------------------------
-- Resolves the M:N relationship between PRESCRIPTION and MEDICATION.
CREATE TABLE IF NOT EXISTS prescription_item (
  item_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  prescription_id INTEGER NOT NULL REFERENCES prescription(prescription_id) ON DELETE CASCADE,
  medication_id   INTEGER NOT NULL REFERENCES medication(medication_id),
  dosage          TEXT NOT NULL,
  frequency       TEXT NOT NULL,
  duration_days   INTEGER,
  route           TEXT,
  instructions    TEXT
);

CREATE INDEX IF NOT EXISTS idx_rxitem_rx ON prescription_item (prescription_id);
CREATE INDEX IF NOT EXISTS idx_rxitem_med ON prescription_item (medication_id);

-- 4.8 INVENTORY -------------------------------------------------------------
-- 1:1 with MEDICATION - each medication has exactly one stock record.
CREATE TABLE IF NOT EXISTS inventory (
  inventory_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id  INTEGER NOT NULL UNIQUE REFERENCES medication(medication_id),
  quantity_in_stock INTEGER NOT NULL DEFAULT 0,
  expiry_date    DATE,
  last_restocked DATETIME,
  supplier       TEXT,
  unit_cost      DECIMAL(10,2) NOT NULL DEFAULT 0.00
);

-- 4.9 LAB_ORDER -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lab_order (
  lab_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  TEXT NOT NULL REFERENCES patient(patient_id) ON DELETE CASCADE,
  ordered_by  TEXT NOT NULL REFERENCES staff(staff_id),
  test_name   TEXT NOT NULL,
  order_date  DATETIME NOT NULL,
  status      TEXT NOT NULL DEFAULT 'Ordered' CHECK (status IN
                ('Ordered','InProgress','Completed')),
  urgency     TEXT NOT NULL DEFAULT 'Routine' CHECK (urgency IN
                ('Routine','Urgent','STAT'))
);

CREATE INDEX IF NOT EXISTS idx_lab_patient ON lab_order (patient_id);

-- 4.10 LAB_RESULT -----------------------------------------------------------
-- 1:1 with LAB_ORDER.
CREATE TABLE IF NOT EXISTS lab_result (
  result_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_id          INTEGER NOT NULL UNIQUE REFERENCES lab_order(lab_id) ON DELETE CASCADE,
  uploaded_by     TEXT REFERENCES staff(staff_id),
  result_data     TEXT,             -- JSON document of {parameter, result, range, flag}
  technician_notes TEXT,
  result_date     DATETIME NOT NULL,
  abnormal_flag   BOOLEAN NOT NULL DEFAULT 0
);

-- 4.11 INVOICE --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice (
  invoice_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id    TEXT NOT NULL REFERENCES patient(patient_id) ON DELETE CASCADE,
  created_by    TEXT REFERENCES staff(staff_id),
  invoice_date  DATETIME NOT NULL,
  total_amount  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  aid_covers    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  patient_owing DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  status        TEXT NOT NULL DEFAULT 'Unpaid' CHECK (status IN
                  ('Unpaid','PartiallyPaid','Paid'))
);

CREATE INDEX IF NOT EXISTS idx_inv_patient ON invoice (patient_id);

-- Invoice line items. Not in the Phase 3 data dictionary, but required by
-- SCR-08: the billing screen itemises consultations, lab orders and pharmacy
-- dispensing against a single invoice.
CREATE TABLE IF NOT EXISTS invoice_item (
  invoice_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id      INTEGER NOT NULL REFERENCES invoice(invoice_id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  category        TEXT,            -- Consultation | Lab | Pharmacy | Procedure
  amount          DECIMAL(10,2) NOT NULL DEFAULT 0.00
);

-- PAYMENT (shown in the ERD, Section 3) -------------------------------------
-- 1:M with INVOICE.
CREATE TABLE IF NOT EXISTS payment (
  payment_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoice(invoice_id) ON DELETE CASCADE,
  amount       DECIMAL(10,2) NOT NULL,
  method       TEXT NOT NULL CHECK (method IN
                  ('Cash','Card','EFT','MedicalAid')),
  paid_at      DATETIME NOT NULL,
  received_by  TEXT REFERENCES staff(staff_id)
);

-- 4.12 AUDIT_LOG ------------------------------------------------------------
-- Every data access / modification event, supporting POPIA + HIPAA compliance.
CREATE TABLE IF NOT EXISTS audit_log (
  log_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id         TEXT REFERENCES staff(staff_id),
  action           TEXT NOT NULL,
  affected_table   TEXT,
  affected_record_id TEXT,
  timestamp        DATETIME NOT NULL,
  ip_address       TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (timestamp DESC);

-- Patient sequence for generated IDs (CGH-2025-00098 -> CGH-2025-00099).
CREATE TABLE IF NOT EXISTS id_sequence (
  entity       TEXT PRIMARY KEY,
  year         INTEGER NOT NULL,
  current_value INTEGER NOT NULL
);
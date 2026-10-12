-- ============================================================================
-- HMS - Community General Hospital
-- MySQL 8.x schema (production target, per Phase 3 report Section 6.1)
--
-- Run:  mysql -u root -p < db/schema.mysql.sql
--
-- This is the MySQL translation of the Phase 3 data dictionary (report
-- Section 4). Types and lengths match the documented specification exactly,
-- including ENUM definitions and DECIMAL(10,2) for money columns.
-- Engine InnoDB is used throughout for ACID compliance and foreign keys.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS hms
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE hms;

-- 4.1 PATIENT ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patient (
  patient_id              VARCHAR(20)  NOT NULL,          -- CGH-2025-00098
  first_name              VARCHAR(50)  NOT NULL,
  last_name               VARCHAR(50)  NOT NULL,
  date_of_birth           DATE         NOT NULL,
  gender                  ENUM('M','F','X') NOT NULL,
  id_number               VARCHAR(13),
  phone_number            VARCHAR(15)  NOT NULL,
  email_address           VARCHAR(100),
  physical_address        TEXT,
  blood_type              ENUM('A+','A-','B+','B-','O+','O-','AB+','AB-'),
  medical_aid_provider    VARCHAR(100),
  medical_aid_number      VARCHAR(30),
  emergency_contact_name  VARCHAR(100),
  emergency_contact_phone VARCHAR(15),
  registration_date       DATETIME     NOT NULL,
  PRIMARY KEY (patient_id),
  KEY idx_patient_name (last_name, first_name),
  KEY idx_patient_id_number (id_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.2 STAFF -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
  staff_id        VARCHAR(15) NOT NULL,
  first_name      VARCHAR(50) NOT NULL,
  last_name       VARCHAR(50) NOT NULL,
  role            ENUM('Doctor','Nurse','Pharmacist','Admin','BillingClerk','LabTech') NOT NULL,
  specialty       VARCHAR(100),
  email_address   VARCHAR(100),
  phone_number    VARCHAR(15),
  hashed_password VARCHAR(255) NOT NULL,                   -- bcrypt
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  date_joined     DATE        NOT NULL,
  failed_attempts INT         NOT NULL DEFAULT 0,
  locked_until    DATETIME    NULL,
  PRIMARY KEY (staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.3 APPOINTMENT -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment (
  appointment_id   INT AUTO_INCREMENT PRIMARY KEY,
  patient_id       VARCHAR(20) NOT NULL,
  doctor_id        VARCHAR(15) NOT NULL,
  appointment_date DATE        NOT NULL,
  appointment_time TIME        NOT NULL,
  appointment_type ENUM('Consultation','Follow-up','Procedure') NOT NULL,
  reason           TEXT,
  status           ENUM('Scheduled','Completed','Cancelled','NoShow') NOT NULL DEFAULT 'Scheduled',
  reminder_sent    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       DATETIME    NOT NULL,
  CONSTRAINT fk_appt_patient FOREIGN KEY (patient_id) REFERENCES patient(patient_id) ON DELETE CASCADE,
  CONSTRAINT fk_appt_doctor  FOREIGN KEY (doctor_id)  REFERENCES staff(staff_id),
  KEY idx_appt_doctor_date (doctor_id, appointment_date),
  KEY idx_appt_patient (patient_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.4 EHR_RECORD ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ehr_record (
  ehr_id          INT AUTO_INCREMENT PRIMARY KEY,
  patient_id      VARCHAR(20) NOT NULL,
  recorded_by     VARCHAR(15) NOT NULL,
  visit_date      DATETIME    NOT NULL,
  diagnosis       TEXT,
  treatment_notes TEXT,
  allergies       TEXT,
  follow_up_date  DATE,
  CONSTRAINT fk_ehr_patient  FOREIGN KEY (patient_id)  REFERENCES patient(patient_id) ON DELETE CASCADE,
  CONSTRAINT fk_ehr_recorded FOREIGN KEY (recorded_by) REFERENCES staff(staff_id),
  KEY idx_ehr_patient (patient_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.5 PRESCRIPTION ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS prescription (
  prescription_id INT AUTO_INCREMENT PRIMARY KEY,
  patient_id      VARCHAR(20) NOT NULL,
  doctor_id       VARCHAR(15) NOT NULL,
  prescribed_date DATETIME    NOT NULL,
  status          ENUM('Pending','Dispensed','Cancelled') NOT NULL DEFAULT 'Pending',
  priority        ENUM('Urgent','Routine') NOT NULL DEFAULT 'Routine',
  pharmacy_notes  TEXT,
  dispensed_at    DATETIME    NULL,
  CONSTRAINT fk_rx_patient FOREIGN KEY (patient_id) REFERENCES patient(patient_id) ON DELETE CASCADE,
  CONSTRAINT fk_rx_doctor  FOREIGN KEY (doctor_id)  REFERENCES staff(staff_id),
  KEY idx_rx_status (status, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.6 MEDICATION ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS medication (
  medication_id   INT AUTO_INCREMENT PRIMARY KEY,
  drug_name       VARCHAR(150) NOT NULL,
  drug_code       VARCHAR(20)  UNIQUE,
  category        VARCHAR(80),
  unit_of_measure VARCHAR(20),
  reorder_level   INT NOT NULL DEFAULT 0,
  formulary       BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.7 PRESCRIPTION_ITEM (bridge table, resolves the M:N) ---------------------
CREATE TABLE IF NOT EXISTS prescription_item (
  item_id         INT AUTO_INCREMENT PRIMARY KEY,
  prescription_id INT NOT NULL,
  medication_id   INT NOT NULL,
  dosage          VARCHAR(50) NOT NULL,
  frequency       VARCHAR(50) NOT NULL,
  duration_days   INT,
  route           VARCHAR(30),
  instructions    TEXT,
  CONSTRAINT fk_rxitem_rx   FOREIGN KEY (prescription_id) REFERENCES prescription(prescription_id) ON DELETE CASCADE,
  CONSTRAINT fk_rxitem_med  FOREIGN KEY (medication_id)   REFERENCES medication(medication_id),
  KEY idx_rxitem_rx (prescription_id),
  KEY idx_rxitem_med (medication_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.8 INVENTORY (1:1 with MEDICATION) ---------------------------------------
CREATE TABLE IF NOT EXISTS inventory (
  inventory_id     INT AUTO_INCREMENT PRIMARY KEY,
  medication_id    INT NOT NULL UNIQUE,
  quantity_in_stock INT NOT NULL DEFAULT 0,
  expiry_date      DATE,
  last_restocked   DATETIME,
  supplier         VARCHAR(100),
  unit_cost        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  CONSTRAINT fk_inv_med FOREIGN KEY (medication_id) REFERENCES medication(medication_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.9 LAB_ORDER -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lab_order (
  lab_id     INT AUTO_INCREMENT PRIMARY KEY,
  patient_id VARCHAR(20) NOT NULL,
  ordered_by VARCHAR(15) NOT NULL,
  test_name  VARCHAR(100) NOT NULL,
  order_date DATETIME NOT NULL,
  status     ENUM('Ordered','InProgress','Completed') NOT NULL DEFAULT 'Ordered',
  urgency    ENUM('Routine','Urgent','STAT') NOT NULL DEFAULT 'Routine',
  CONSTRAINT fk_lab_patient FOREIGN KEY (patient_id) REFERENCES patient(patient_id) ON DELETE CASCADE,
  CONSTRAINT fk_lab_staff   FOREIGN KEY (ordered_by) REFERENCES staff(staff_id),
  KEY idx_lab_patient (patient_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.10 LAB_RESULT (1:1 with LAB_ORDER) --------------------------------------
CREATE TABLE IF NOT EXISTS lab_result (
  result_id        INT AUTO_INCREMENT PRIMARY KEY,
  lab_id           INT NOT NULL UNIQUE,
  uploaded_by      VARCHAR(15),
  result_data      JSON,
  technician_notes TEXT,
  result_date      DATETIME NOT NULL,
  abnormal_flag    BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT fk_result_lab  FOREIGN KEY (lab_id)      REFERENCES lab_order(lab_id) ON DELETE CASCADE,
  CONSTRAINT fk_result_tech FOREIGN KEY (uploaded_by) REFERENCES staff(staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.11 INVOICE --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice (
  invoice_id    INT AUTO_INCREMENT PRIMARY KEY,
  patient_id    VARCHAR(20) NOT NULL,
  created_by    VARCHAR(15),
  invoice_date  DATETIME NOT NULL,
  total_amount  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  aid_covers    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  patient_owing DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  status        ENUM('Unpaid','PartiallyPaid','Paid') NOT NULL DEFAULT 'Unpaid',
  CONSTRAINT fk_inv_patient FOREIGN KEY (patient_id) REFERENCES patient(patient_id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_creator FOREIGN KEY (created_by) REFERENCES staff(staff_id),
  KEY idx_inv_patient (patient_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Invoice line items (required by SCR-08 billing screen).
CREATE TABLE IF NOT EXISTS invoice_item (
  invoice_item_id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id      INT NOT NULL,
  description     VARCHAR(255) NOT NULL,
  category        VARCHAR(50),
  amount          DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  CONSTRAINT fk_invitem_inv FOREIGN KEY (invoice_id) REFERENCES invoice(invoice_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- PAYMENT (1:M with INVOICE, shown in the ERD) ------------------------------
CREATE TABLE IF NOT EXISTS payment (
  payment_id  INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id  INT NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  method      ENUM('Cash','Card','EFT','MedicalAid') NOT NULL,
  paid_at     DATETIME NOT NULL,
  received_by VARCHAR(15),
  CONSTRAINT fk_pay_inv   FOREIGN KEY (invoice_id)  REFERENCES invoice(invoice_id) ON DELETE CASCADE,
  CONSTRAINT fk_pay_staff FOREIGN KEY (received_by) REFERENCES staff(staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4.12 AUDIT_LOG ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  log_id            INT AUTO_INCREMENT PRIMARY KEY,
  staff_id          VARCHAR(15),
  action            VARCHAR(200) NOT NULL,
  affected_table    VARCHAR(50),
  affected_record_id VARCHAR(30),
  timestamp         DATETIME NOT NULL,
  ip_address        VARCHAR(45),
  CONSTRAINT fk_audit_staff FOREIGN KEY (staff_id) REFERENCES staff(staff_id),
  KEY idx_audit_ts (timestamp DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sequence backing generated Patient IDs (CGH-2025-000NN).
CREATE TABLE IF NOT EXISTS id_sequence (
  entity        VARCHAR(30) NOT NULL PRIMARY KEY,
  year          INT NOT NULL,
  current_value INT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
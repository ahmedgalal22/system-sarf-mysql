-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Vehicle Ledger (دفتر حسابات المركبات)
-- Per-vehicle/client financial events
-- Financial identity: client_id + client_type (canonical)
-- Run after database.sql
-- ═══════════════════════════════════════════════════════════════

USE karta_erp_v2;

CREATE TABLE IF NOT EXISTS vehicle_ledger (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid              CHAR(36)      NOT NULL,
  username          VARCHAR(100)  NOT NULL,

  -- Vehicle info (asset ownership — NOT financial identity)
  vehicle_id        VARCHAR(50)   DEFAULT NULL,
  vehicle_plate     VARCHAR(50)   DEFAULT NULL,
  vehicle_owner_id  VARCHAR(50)   DEFAULT NULL,
  vehicle_owner_name VARCHAR(200) DEFAULT NULL,

  -- Financial identity (canonical — single source of truth)
  client_id         VARCHAR(50)   DEFAULT NULL,
  client_type       VARCHAR(20)   DEFAULT NULL,
  client_name       VARCHAR(200)  DEFAULT NULL,

  -- Entry classification
  type              VARCHAR(20)   NOT NULL,              -- deposit | withdraw | receipt_due | receipt_payment
  effect            VARCHAR(50)   DEFAULT NULL,           -- receipt_total | receipt_payment | ...
  amount            BIGINT        NOT NULL DEFAULT 0,     -- cents

  -- Reference linking (NOT UNIQUE — multiple entries per receipt)
  reference_type    VARCHAR(50)   DEFAULT NULL,           -- receipt | client_balance | office_deposit | ...
  reference_id      VARCHAR(50)   DEFAULT NULL,
  receipt_number    VARCHAR(50)   DEFAULT NULL,

  -- Dates
  date              DATE          DEFAULT NULL,
  applied_at        VARCHAR(30)   DEFAULT NULL,

  -- Description
  note              TEXT          DEFAULT NULL,

  -- Reversal
  is_reversed       TINYINT(1)    NOT NULL DEFAULT 0,
  reversed_at       VARCHAR(30)   DEFAULT NULL,
  reversed_by       VARCHAR(100)  DEFAULT NULL,

  -- Archive
  is_archived       TINYINT(1)    NOT NULL DEFAULT 0,
  archive_batch_id  CHAR(36)      DEFAULT NULL,
  archived_at       DATETIME(3)   DEFAULT NULL,

  -- Audit
  created_by        VARCHAR(100)  DEFAULT NULL,
  updated_by        VARCHAR(100)  DEFAULT NULL,
  deleted_by        VARCHAR(100)  DEFAULT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at        DATETIME(3)   DEFAULT NULL,

  UNIQUE KEY uq_uuid (uuid),
  INDEX idx_username (username),
  INDEX idx_vehicle_id (vehicle_id),
  INDEX idx_client_id (client_id),
  INDEX idx_reference_id (reference_id),
  INDEX idx_reference_type (reference_type),
  INDEX idx_type (type),
  INDEX idx_effect (effect),
  INDEX idx_reversed (is_reversed),
  INDEX idx_archived (is_archived),
  INDEX idx_date (date),
  INDEX idx_deleted (deleted_at),
  INDEX idx_ref_active (reference_id, is_reversed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Main Capital Treasury (خزينة رأس المال)
-- Independent capital tracking for the dashboard
-- Run after database.sql
-- ═══════════════════════════════════════════════════════════════

USE karta_erp;

CREATE TABLE IF NOT EXISTS main_capital_treasury (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid              CHAR(36)      NOT NULL,
  username          VARCHAR(100)  NOT NULL,

  type              VARCHAR(20)   NOT NULL,              -- deposit | withdraw
  amount            BIGINT        NOT NULL DEFAULT 0,     -- cents
  description       TEXT          DEFAULT NULL,
  date              DATE          DEFAULT NULL,

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
  INDEX idx_type (type),
  INDEX idx_date (date),
  INDEX idx_archived (is_archived),
  INDEX idx_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

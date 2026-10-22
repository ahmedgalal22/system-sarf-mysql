-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Archive Batches + Financial Snapshots
-- Run after all financial tables exist.
-- ═══════════════════════════════════════════════════════════════

USE karta_erp;

CREATE TABLE IF NOT EXISTS archive_batches (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid              CHAR(36)      NOT NULL,
  username          VARCHAR(100)  NOT NULL,

  from_date         DATE          NOT NULL,
  to_date           DATE          NOT NULL,

  status            VARCHAR(20)   NOT NULL DEFAULT 'archived',   -- archived | restored
  archive_version   INT UNSIGNED  NOT NULL DEFAULT 1,

  snapshot_id       CHAR(36)      DEFAULT NULL,

  notes             TEXT          DEFAULT NULL,

  archived_at       DATETIME(3)   DEFAULT NULL,
  archived_by       VARCHAR(100)  DEFAULT NULL,
  restored_at       DATETIME(3)   DEFAULT NULL,
  last_rearchived_at DATETIME(3)  DEFAULT NULL,

  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at        DATETIME(3)   DEFAULT NULL,

  UNIQUE KEY uq_uuid (uuid),
  INDEX idx_username (username),
  INDEX idx_status (status),
  INDEX idx_dates (from_date, to_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS financial_snapshots (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid              CHAR(36)      NOT NULL,
  archive_batch_id  CHAR(36)      NOT NULL,

  snapshot_date     DATE          DEFAULT NULL,
  treasury_balance  BIGINT        NOT NULL DEFAULT 0,
  client_balances   JSON          DEFAULT NULL,
  integrity_hash    VARCHAR(100)  DEFAULT NULL,

  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at        DATETIME(3)   DEFAULT NULL,

  UNIQUE KEY uq_uuid (uuid),
  INDEX idx_batch (archive_batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

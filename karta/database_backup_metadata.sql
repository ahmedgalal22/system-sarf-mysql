-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Backup Metadata Tracking
-- Single-row table tracking the last successful backup.
-- NOT a source of financial data — metadata only.
--
-- Safe to run multiple times (IF NOT EXISTS + INSERT IGNORE).
-- If this table is lost, backup/restore continue normally.
-- ═══════════════════════════════════════════════════════════════

USE karta_erp;

CREATE TABLE IF NOT EXISTS backup_metadata (
  id               TINYINT UNSIGNED NOT NULL DEFAULT 1,
  last_backup_at   DATETIME         NULL     DEFAULT NULL,
  last_backup_by   VARCHAR(100)     NULL     DEFAULT NULL,
  backup_count     INT UNSIGNED     NOT NULL DEFAULT 0,
  last_backup_size INT UNSIGNED     NULL     DEFAULT NULL COMMENT 'bytes',
  created_at       DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT chk_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the singleton row
INSERT IGNORE INTO backup_metadata (id) VALUES (1);

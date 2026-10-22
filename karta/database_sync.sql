-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Version Tracking Infrastructure
-- Metadata tracking only — NOT a source of truth.
-- MySQL business tables remain the sole authority.
--
-- Run after all other database SQL files.
-- Safe to run multiple times (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════

USE karta_erp_v2;

CREATE TABLE IF NOT EXISTS data_versions (
  entity_name VARCHAR(100) NOT NULL,
  version     BIGINT       NOT NULL DEFAULT 1,
  updated_at  DATETIME     NULL     DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Initial seed — only inserts if not already present
INSERT IGNORE INTO data_versions (entity_name, version) VALUES
  ('vehicle_owners',    1),
  ('offices',           1),
  ('vehicles',          1),
  ('receipts',          1),
  ('treasury',          1),
  ('vehicle_ledger',    1),
  ('main_capital',      1),
  ('archive_batches',   1),
  ('drivers',           1),
  ('notes',             1);

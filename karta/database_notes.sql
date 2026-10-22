-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Phase 5: Notes (ملاحظات)
-- Run after database.sql
-- ═══════════════════════════════════════════════════════════════

USE karta_erp;

CREATE TABLE IF NOT EXISTS notes (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36)      NOT NULL,
  username        VARCHAR(100)  NOT NULL,
  related_store   VARCHAR(50)   DEFAULT NULL,
  related_id      VARCHAR(50)   DEFAULT NULL,
  title           VARCHAR(200)  DEFAULT NULL,
  content         TEXT          DEFAULT NULL,
  created_by      VARCHAR(100)  DEFAULT NULL,
  updated_by      VARCHAR(100)  DEFAULT NULL,
  deleted_by      VARCHAR(100)  DEFAULT NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)   DEFAULT NULL,
  UNIQUE KEY uq_uuid (uuid),
  INDEX idx_username (username),
  INDEX idx_related (related_store, related_id),
  INDEX idx_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Vehicle Owners + Brokers (أصحاب المركبات + الوسطاء)
-- Run after database.sql
-- owner_type: 'owner' (default) or 'broker'
-- ═══════════════════════════════════════════════════════════════

USE karta_erp_v2;

CREATE TABLE IF NOT EXISTS vehicle_owners (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36)      NOT NULL,
  username        VARCHAR(100)  NOT NULL,
  name            VARCHAR(200)  NOT NULL,
  phone           VARCHAR(50)   DEFAULT NULL,
  owner_type      VARCHAR(20)   NOT NULL DEFAULT 'owner',
  notes           TEXT          DEFAULT NULL,
  created_by      VARCHAR(100)  DEFAULT NULL,
  updated_by      VARCHAR(100)  DEFAULT NULL,
  deleted_by      VARCHAR(100)  DEFAULT NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)   DEFAULT NULL,
  UNIQUE KEY uq_uuid (uuid),
  INDEX idx_username (username),
  INDEX idx_name (name),
  INDEX idx_owner_type (owner_type),
  INDEX idx_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

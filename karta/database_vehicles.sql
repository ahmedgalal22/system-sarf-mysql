-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Vehicles (المركبات)
-- Run after database.sql and database_vehicle_owners.sql
-- ═══════════════════════════════════════════════════════════════

USE karta_erp;

CREATE TABLE IF NOT EXISTS vehicles (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36)      NOT NULL,
  plate           VARCHAR(50)   NOT NULL,
  owner_id        VARCHAR(50)   DEFAULT NULL,
  owner_name      VARCHAR(200)  DEFAULT NULL,
  driver_name     VARCHAR(200)  DEFAULT NULL,
  notes           TEXT          DEFAULT NULL,
  username        VARCHAR(100)  NOT NULL,
  created_by      VARCHAR(100)  DEFAULT NULL,
  updated_by      VARCHAR(100)  DEFAULT NULL,
  deleted_by      VARCHAR(100)  DEFAULT NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)   DEFAULT NULL,

  UNIQUE KEY uq_uuid (uuid),
  INDEX idx_plate (plate),
  INDEX idx_owner (owner_id),
  INDEX idx_username (username),
  INDEX idx_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

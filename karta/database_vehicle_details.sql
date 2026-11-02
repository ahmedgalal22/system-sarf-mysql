-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Vehicle Details Movements (تفاصيل السيارات — الحركات)
-- Run after database_vehicle_owners.sql and database_sync.sql
-- Standalone manual movements table — zero financial impact
-- ═══════════════════════════════════════════════════════════════

USE karta_erp_v2;

CREATE TABLE IF NOT EXISTS vehicle_details_movements (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36)       NOT NULL,
  owner_id        INT UNSIGNED   NOT NULL,
  username        VARCHAR(100)   NOT NULL,
  movement_date   DATE           NOT NULL,
  movement_time   TIME           NOT NULL,
  lah             DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  alayh           DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  notes           TEXT           DEFAULT NULL,
  created_by      VARCHAR(100)   DEFAULT NULL,
  updated_by      VARCHAR(100)   DEFAULT NULL,
  deleted_by      VARCHAR(100)   DEFAULT NULL,
  created_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)    DEFAULT NULL,
  UNIQUE KEY uq_uuid (uuid),
  INDEX idx_owner_id (owner_id),
  INDEX idx_username (username),
  INDEX idx_owner_date (owner_id, movement_date),
  INDEX idx_deleted (deleted_at),
  CONSTRAINT fk_vehicle_details_owner FOREIGN KEY (owner_id) REFERENCES vehicle_owners(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Register in data_versions for real-time sync
INSERT IGNORE INTO data_versions (entity_name, version)
VALUES ('vehicle_details_movements', 1);

-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Owner Account Details (تفاصيل الحساب لصاحب المركبة)
-- Run after database_vehicle_owners.sql
-- Non-financial memo rows belonging to a vehicle owner.
-- ═══════════════════════════════════════════════════════════════

USE karta_erp_v2;

CREATE TABLE IF NOT EXISTS owner_account_details (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36)       NOT NULL,
  owner_id        INT UNSIGNED   NOT NULL,
  username        VARCHAR(100)   NOT NULL,
  leh_amount      DECIMAL(14,2)  DEFAULT NULL,
  alayh_amount    DECIMAL(14,2)  DEFAULT NULL,
  notes           TEXT           DEFAULT NULL,
  entry_date      DATE           NOT NULL,
  entry_time      TIME           NOT NULL,
  created_by      VARCHAR(100)   DEFAULT NULL,
  updated_by      VARCHAR(100)   DEFAULT NULL,
  created_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_uuid (uuid),
  INDEX idx_owner_user_id (owner_id, username, id),
  INDEX idx_owner_entry_date (owner_id, entry_date),
  INDEX idx_username (username),
  FOREIGN KEY (owner_id) REFERENCES vehicle_owners(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Register in data_versions for sync
INSERT IGNORE INTO data_versions (entity_name, version)
VALUES ('owner_account_details', 1);

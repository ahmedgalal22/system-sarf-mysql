-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Hamola Details (تفاصيل الحمولة)
-- Run after database_offices.sql
-- Each row is one load route for an office (was JSON in offices.hamola_rows)
-- ═══════════════════════════════════════════════════════════════

USE karta_erp_v2;

CREATE TABLE IF NOT EXISTS hamola_details (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid              CHAR(36)       NOT NULL,
  office_id         INT UNSIGNED   NOT NULL,
  username          VARCHAR(100)   NOT NULL,
  loading_place     VARCHAR(200)   NOT NULL,
  destination_place VARCHAR(200)   NOT NULL,
  nolon             DECIMAL(12,2)  NOT NULL DEFAULT 0,
  office_amount     DECIMAL(12,2)  NOT NULL DEFAULT 0,
  item_type         VARCHAR(100)   DEFAULT NULL,
  price             DECIMAL(12,2)  NOT NULL DEFAULT 0,
  created_by        VARCHAR(100)   DEFAULT NULL,
  updated_by        VARCHAR(100)   DEFAULT NULL,
  deleted_by        VARCHAR(100)   DEFAULT NULL,
  created_at        DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at        DATETIME(3)    DEFAULT NULL,
  UNIQUE KEY uq_uuid (uuid),
  INDEX idx_office (office_id),
  INDEX idx_username (username),
  INDEX idx_deleted (deleted_at),
  FOREIGN KEY (office_id) REFERENCES offices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Register in data_versions for sync
INSERT IGNORE INTO data_versions (entity_name, version)
VALUES ('hamola_details', 1);

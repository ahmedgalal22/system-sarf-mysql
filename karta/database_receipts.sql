-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Receipts + Receipt Counter
-- Run after database.sql and database_vehicles.sql
-- ═══════════════════════════════════════════════════════════════

USE karta_erp_v2;

-- ───────────────────────────────────────────────────────────────
-- Receipt number counter
-- ONE row per user. Atomic UPDATE via LAST_INSERT_ID pattern.
-- next_number = last allocated number (starts at 0).
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS receipt_counters (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username    VARCHAR(100) NOT NULL,
  next_number INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────
-- Receipts table — raw data storage, NO calculated fields
-- DATETIME(3) for millisecond-precision optimistic locking
-- Three UNIQUE constraints enforce data integrity at DB level:
--   uq_uuid           — one record per client-generated UUID
--   uq_receipt_number  — no duplicate receipt numbers per user
--   uq_request_id      — idempotency guarantee
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS receipts (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid              CHAR(36)      NOT NULL,
  username          VARCHAR(100)  NOT NULL,
  receipt_number    VARCHAR(50)   NOT NULL,
  receipt_date      DATE          DEFAULT NULL,

  -- Client identity (canonical: client_id + client_type)
  client_id         VARCHAR(50)   DEFAULT NULL,
  client_type       VARCHAR(20)   DEFAULT NULL,
  client_name       VARCHAR(200)  DEFAULT NULL,
  recipient_name    VARCHAR(200)  DEFAULT NULL,
  company_name      VARCHAR(200)  DEFAULT NULL,
  company_phone     VARCHAR(50)   DEFAULT NULL,

  -- Payout state (managed by client financial engine)
  payout_status     ENUM('paid','unpaid','partial','cancelled') NOT NULL DEFAULT 'unpaid',
  paid_at           DATETIME(3)   DEFAULT NULL,
  account_type      VARCHAR(20)   DEFAULT NULL,

  -- Raw financial values (integer cents — stored as-is from client)
  total             BIGINT        NOT NULL DEFAULT 0,
  net_due           BIGINT        NOT NULL DEFAULT 0,
  net_total         BIGINT        NOT NULL DEFAULT 0,
  paid              BIGINT        NOT NULL DEFAULT 0,
  previous_balance  BIGINT        NOT NULL DEFAULT 0,
  general_add       BIGINT        NOT NULL DEFAULT 0,

  -- Row data (JSON array — client owns structure)
  `rows`            JSON          DEFAULT NULL,

  -- Metadata
  notes             TEXT          DEFAULT NULL,
  shipping_number   VARCHAR(100)  DEFAULT NULL,
  request_id        CHAR(36)      DEFAULT NULL,

  -- Archive fields
  is_archived       TINYINT(1)    NOT NULL DEFAULT 0,
  archive_batch_id  CHAR(36)      DEFAULT NULL,
  archived_at       DATETIME(3)   DEFAULT NULL,

  -- Audit trail (server-authoritative)
  created_by        VARCHAR(100)  DEFAULT NULL,
  updated_by        VARCHAR(100)  DEFAULT NULL,
  deleted_by        VARCHAR(100)  DEFAULT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at        DATETIME(3)   DEFAULT NULL,

  -- Hard uniqueness constraints (DB-level enforcement)
  UNIQUE KEY uq_uuid (uuid),
  UNIQUE KEY uq_receipt_number (username, receipt_number),
  UNIQUE KEY uq_request_id (request_id),

  -- Performance indexes
  INDEX idx_username (username),
  INDEX idx_client (client_id),
  INDEX idx_date (receipt_date),
  INDEX idx_status (payout_status),
  INDEX idx_archived (is_archived),
  INDEX idx_deleted (deleted_at),
  INDEX idx_created (created_at),
  INDEX idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

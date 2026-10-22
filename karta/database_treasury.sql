-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Treasury (خزينة)
-- Financial entries: deposits, withdrawals, salfa, expenses, payouts
-- Run after database.sql
-- ═══════════════════════════════════════════════════════════════

USE karta_erp;

CREATE TABLE IF NOT EXISTS treasury (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid              CHAR(36)      NOT NULL,
  username          VARCHAR(100)  NOT NULL,

  -- Entry classification
  type              VARCHAR(20)   NOT NULL,              -- deposit | withdraw
  effect            VARCHAR(50)   DEFAULT NULL,           -- capital_deposit | receipt_payout | salfa | expense | salary | mandoub_cash_out | bolsa_deduction | ...
  account_type      VARCHAR(20)   DEFAULT 'cash',         -- cash | bank | ...
  entry_type        VARCHAR(20)   DEFAULT NULL,           -- receipt | independent | bolsa | ...

  -- Amount in cents (BIGINT — no floating point)
  amount            BIGINT        NOT NULL DEFAULT 0,

  -- Reference linking (NOT UNIQUE — multiple entries per receipt)
  reference_type    VARCHAR(50)   DEFAULT NULL,           -- receipt | capital | bolsa | salfa | client_balance | ...
  reference_id      VARCHAR(50)   DEFAULT NULL,           -- UUID or receipt ID

  -- Client info (denormalized for display)
  client_id         VARCHAR(50)   DEFAULT NULL,
  client_type       VARCHAR(20)   DEFAULT NULL,           -- owner | mandoub | office
  client_name       VARCHAR(200)  DEFAULT NULL,
  agent_id          VARCHAR(50)   DEFAULT NULL,
  receipt_number    VARCHAR(50)   DEFAULT NULL,

  -- Dates
  date              DATE          DEFAULT NULL,            -- business date
  applied_at        VARCHAR(30)   DEFAULT NULL,            -- execution timestamp

  -- Description
  description       TEXT          DEFAULT NULL,
  note              TEXT          DEFAULT NULL,

  -- Reversal
  is_reversed       TINYINT(1)    NOT NULL DEFAULT 0,
  reversed_at       VARCHAR(30)   DEFAULT NULL,
  reversed_by       VARCHAR(100)  DEFAULT NULL,

  -- Archive
  is_archived       TINYINT(1)    NOT NULL DEFAULT 0,
  archive_batch_id  CHAR(36)      DEFAULT NULL,
  archived_at       DATETIME(3)   DEFAULT NULL,

  -- Audit
  created_by        VARCHAR(100)  DEFAULT NULL,
  updated_by        VARCHAR(100)  DEFAULT NULL,
  deleted_by        VARCHAR(100)  DEFAULT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at        DATETIME(3)   DEFAULT NULL,

  UNIQUE KEY uq_uuid (uuid),
  INDEX idx_username (username),
  INDEX idx_type (type),
  INDEX idx_effect (effect),
  INDEX idx_account_type (account_type),
  INDEX idx_reference_id (reference_id),
  INDEX idx_reference_type (reference_type),
  INDEX idx_client_id (client_id),
  INDEX idx_reversed (is_reversed),
  INDEX idx_archived (is_archived),
  INDEX idx_date (date),
  INDEX idx_deleted (deleted_at),
  INDEX idx_ref_active (reference_id, is_reversed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

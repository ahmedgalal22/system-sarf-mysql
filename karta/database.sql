-- ═══════════════════════════════════════════════════════════════
-- Karta ERP — Phase 1: Users & Auth
-- MySQL 5.7+ / MariaDB 10.3+
-- ═══════════════════════════════════════════════════════════════

CREATE DATABASE IF NOT EXISTS karta_erp
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE karta_erp;

-- ───────────────────────────────────────────────────────────────
-- Users table
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid          CHAR(36)     NOT NULL,
  username      VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','accountant') NOT NULL DEFAULT 'accountant',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at DATETIME     DEFAULT NULL,

  UNIQUE INDEX idx_username (username),
  UNIQUE INDEX idx_uuid (uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────
-- Seed users
-- Passwords: admin123 / accountant123
-- Generated with: password_hash('...', PASSWORD_BCRYPT)
-- ───────────────────────────────────────────────────────────────

INSERT INTO users (uuid, username, password_hash, role, is_active) VALUES
  (UUID(), 'admin',      '$2y$10$8K5x5J3Q5Z5Z5Z5Z5Z5Z5OvKgLpK5q5q5q5q5q5q5q5q5q5q5q5q', 'admin',      1),
  (UUID(), 'accountant', '$2y$10$8K5x5J3Q5Z5Z5Z5Z5Z5Z5OvKgLpK5q5q5q5q5q5q5q5q5q5q5q5q', 'accountant', 1);

-- NOTE: The hashes above are PLACEHOLDERS.
-- The bootstrap.php script will re-hash with proper bcrypt on first run.
-- Or you can generate real hashes via: php -r "echo password_hash('admin123', PASSWORD_BCRYPT);"

-- Karta ERP — Phase 2: Complete Archive Schema Removal (existing databases)
-- Run ONCE in maintenance window AFTER application code is deployed.
-- Pre-condition: verified zero archived rows (see step 0).
-- MySQL DDL causes implicit COMMIT — this script is NOT transactional.
-- Rollback = restore pre-migration backup (see below). No UNDO for DROP.

USE karta_erp_v2;

-- Step 0 (manual, read-only — run first, abort if any count > 0 or schema mismatch):
-- SELECT COUNT(*) FROM archive_batches;
-- SELECT COUNT(*) FROM financial_snapshots;
-- SELECT COUNT(*) FROM receipts WHERE is_archived=1 OR archive_batch_id IS NOT NULL OR archived_at IS NOT NULL;
-- SELECT COUNT(*) FROM treasury WHERE is_archived=1 OR archive_batch_id IS NOT NULL OR archived_at IS NOT NULL;
-- SELECT COUNT(*) FROM vehicle_ledger WHERE is_archived=1 OR archive_batch_id IS NOT NULL OR archived_at IS NOT NULL;
-- SELECT COUNT(*) FROM main_capital_treasury WHERE is_archived=1 OR archive_batch_id IS NOT NULL OR archived_at IS NOT NULL;
-- SHOW TABLES LIKE 'archive_%';
-- SHOW COLUMNS FROM receipts LIKE 'is_archived';  -- repeat ×4
-- SHOW INDEX FROM receipts LIKE 'idx_archived';  -- repeat ×4
-- SELECT * FROM data_versions WHERE entity_name='archive_batches';

-- Step 1: Drop archive tables
DROP TABLE IF EXISTS financial_snapshots;
DROP TABLE IF EXISTS archive_batches;

-- Step 2: Drop archive columns + indexes (one ALTER per table)
ALTER TABLE receipts DROP INDEX idx_archived, DROP COLUMN is_archived, DROP COLUMN archive_batch_id, DROP COLUMN archived_at;
ALTER TABLE treasury DROP INDEX idx_archived, DROP COLUMN is_archived, DROP COLUMN archive_batch_id, DROP COLUMN archived_at;
ALTER TABLE vehicle_ledger DROP INDEX idx_archived, DROP COLUMN is_archived, DROP COLUMN archive_batch_id, DROP COLUMN archived_at;
ALTER TABLE main_capital_treasury DROP INDEX idx_archived, DROP COLUMN is_archived, DROP COLUMN archive_batch_id, DROP COLUMN archived_at;

-- Step 3: Remove orphaned sync seed
DELETE FROM data_versions WHERE entity_name = 'archive_batches';

-- Step 4 (verification, read-only):
-- SHOW TABLES LIKE 'archive_batches';  -- expect empty
-- SHOW COLUMNS FROM receipts LIKE 'is_archived';  -- expect empty (repeat ×4)
-- SELECT * FROM data_versions WHERE entity_name='archive_batches';  -- expect empty

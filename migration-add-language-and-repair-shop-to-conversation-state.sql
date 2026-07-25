-- =============================================================================
-- CoolCare — Migration: Add language & repair_shop_id to conversation_state
-- Fixes: column "language" of relation "conversation_state" does not exist
--        (PostgreSQL error 42703) in WhatsApp API
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards).
-- =============================================================================

-- 1. Add language column for i18n support (en, hi, ta, ar)
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';

-- 2. Backfill any rows where language is still NULL
UPDATE conversation_state SET language = 'en' WHERE language IS NULL;

-- 3. Set NOT NULL now that all rows have a value
ALTER TABLE conversation_state ALTER COLUMN language SET NOT NULL;
ALTER TABLE conversation_state ALTER COLUMN language SET DEFAULT 'en';

-- 4. Add repair_shop_id column for multi-tenancy
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;

-- 5. Index for tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_conv_state_shop ON conversation_state(repair_shop_id);

-- =============================================================================
-- Done
-- =============================================================================

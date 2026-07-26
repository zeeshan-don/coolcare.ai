-- =============================================================================
-- CoolCare — Migration: Add is_demo column to repair_shops
-- Fixes: column "is_demo" of relation "repair_shops" does not exist
--        (PostgreSQL error 42703) when clicking "Demo Login"
-- Safe to re-run (uses IF NOT EXISTS guards throughout).
-- =============================================================================

BEGIN;

-- 1. Add is_demo column
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Add index for fast demo shop lookups (used by isDemoShop() helper)
CREATE INDEX IF NOT EXISTS idx_repair_shops_is_demo ON repair_shops(is_demo);

-- 3. Ensure existing demo shop (if any) has is_demo = TRUE
UPDATE repair_shops SET is_demo = true WHERE email = 'demo@coolcare.demo';

-- =============================================================================
-- Done
-- =============================================================================

COMMIT;

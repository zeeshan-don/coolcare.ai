-- =============================================================================
-- CoolCare — Migration: Password Reset + Missing Columns Fix
-- Adds password_reset_tokens table and ensures all required columns exist.
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards throughout).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PASSWORD RESET TOKENS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL,
  user_type        TEXT NOT NULL DEFAULT 'shop'
                   CHECK (user_type IN ('user', 'shop')),
  token_hash       TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_expires ON password_reset_tokens(expires_at);

-- -----------------------------------------------------------------------------
-- 2. ENSURE repair_shops HAS ALL REQUIRED COLUMNS
-- -----------------------------------------------------------------------------
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'shop';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Fix role constraint (expand to include all roles)
DO $$
BEGIN
  ALTER TABLE repair_shops DROP CONSTRAINT IF EXISTS repair_shops_role_check;
  ALTER TABLE repair_shops ADD CONSTRAINT repair_shops_role_check
    CHECK (role IN (
      'shop','owner','manager','editor','receptionist','technician',
      'admin','super_admin'
    ));
EXCEPTION WHEN others THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 3. CLEAN UP EXPIRED RESET TOKENS (maintenance)
-- -----------------------------------------------------------------------------
DELETE FROM password_reset_tokens WHERE expires_at < now();

-- -----------------------------------------------------------------------------
-- Done
-- -----------------------------------------------------------------------------

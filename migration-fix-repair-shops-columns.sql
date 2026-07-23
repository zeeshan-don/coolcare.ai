-- =============================================================================
-- CoolCare — Missing columns fix for repair_shops
-- The SaaS upgrade migration was never applied to production.
-- This adds ONLY the missing columns the application requires.
-- Safe to re-run (all use IF NOT EXISTS guards).
-- =============================================================================

-- role: required by login, signup, admin check
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'shop';

-- Remove old CHECK constraint if it exists, then add proper one
DO $$
BEGIN
  ALTER TABLE repair_shops DROP CONSTRAINT IF EXISTS repair_shops_role_check;
  ALTER TABLE repair_shops ADD CONSTRAINT repair_shops_role_check
    CHECK (role IN ('shop','admin','super_admin'));
EXCEPTION WHEN others THEN NULL;
END $$;

-- subscription_status: required by webhook, admin dashboard
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';

-- suspended_at / suspension_reason: required by admin suspend/activate
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

-- =============================================================================
-- CoolCare — Migration: Repair Shop Auth System
-- Run this once in your Neon SQL console.
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards throughout).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Ensure bookings.address exists (may have been dropped in production)
-- -----------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS address TEXT;

-- -----------------------------------------------------------------------------
-- 2. Create repair_shops table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repair_shops (
  id               SERIAL PRIMARY KEY,
  shop_name        TEXT NOT NULL,
  owner_name       TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  mobile           TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  address          TEXT,
  city             TEXT,
  service_areas    TEXT[],          -- e.g. ARRAY['Indiranagar','Koramangala']
  services_offered TEXT[],          -- e.g. ARRAY['AC','Refrigerator','Geyser']
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_repair_shops_email  ON repair_shops(email);
CREATE INDEX IF NOT EXISTS idx_repair_shops_mobile ON repair_shops(mobile);

-- -----------------------------------------------------------------------------
-- 3. Add repair_shop_id FK to bookings (nullable so existing rows are safe)
-- -----------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_shop ON bookings(repair_shop_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. Extend bookings with job-management columns
-- -----------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS technician_name  TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS technician_notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS estimated_cost   NUMERIC(10,2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_cost       NUMERIC(10,2);

-- Richer status set for shop job management
-- Existing CHECK constraint must be dropped first if it exists
DO $$
BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
  ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
      'open',
      'accepted',
      'rejected',
      'assigned',
      'on_the_way',
      'arrived',
      'completed',
      'cancelled'
    ));
EXCEPTION WHEN others THEN
  -- If the constraint already uses the new values, do nothing
  NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 5. JWT token denylist (for logout / token invalidation)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jwt_denylist (
  id         SERIAL PRIMARY KEY,
  jti        TEXT NOT NULL UNIQUE,   -- JWT ID claim
  expires_at TIMESTAMPTZ NOT NULL,   -- clean up expired tokens
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jwt_denylist_jti     ON jwt_denylist(jti);
CREATE INDEX IF NOT EXISTS idx_jwt_denylist_expires ON jwt_denylist(expires_at);

-- Auto-clean expired tokens (call this periodically or from a cron)
-- DELETE FROM jwt_denylist WHERE expires_at < now();

-- -----------------------------------------------------------------------------
-- Done
-- -----------------------------------------------------------------------------

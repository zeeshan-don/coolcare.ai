-- migration-technician-roster.sql
-- Technician Roster Management
-- Ensures the `technicians` table has every column needed for full CRUD by
-- shop owners (Add / Edit / Suspend / Delete technicians), plus supporting
-- indexes. Safe to run repeatedly (IF NOT EXISTS everywhere).
--
-- Run: node scripts/run-migration.js migration-technician-roster.sql
--   or paste into the Neon SQL console.

-- Tenant scoping (may already exist from migration-combined.sql)
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS specialization TEXT[];

-- Timestamps for the roster UI
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_technicians_shop ON technicians(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_technicians_shop_active ON technicians(repair_shop_id, active);
CREATE INDEX IF NOT EXISTS idx_bookings_technician ON bookings(technician_id);

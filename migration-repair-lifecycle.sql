-- =============================================================================
-- CoolCare AI — REPAIR LIFECYCLE MANAGEMENT (migration-repair-lifecycle.sql)
-- =============================================================================
-- Extends the EXISTING booking model with the full repair lifecycle:
--
--   Statuses (extended):
--     open          → Pending
--     accepted      → Accepted
--     rejected      → Rejected
--     assigned      → Assigned
--     on_the_way    → Technician On The Way
--     arrived       → Technician Arrived
--     in_progress   → Repair In Progress        (NEW)
--     waiting_parts → Waiting For Parts         (NEW)
--     completed     → Completed
--     cancelled     → Cancelled
--     payment_received → Payment Received       (NEW — optional terminal step)
--
-- The repair timeline is stored in the EXISTING booking_timeline table
-- (booking_id, action, old_value, new_value, actor_type, actor_id, notes,
--  created_at) — no duplicate tables are created.
--
-- Safe to run multiple times: ALL operations use IF NOT EXISTS / IF EXISTS
-- guards throughout. Run with:
--   DATABASE_URL=postgres://... node scripts/run-migration.js migration-repair-lifecycle.sql
-- =============================================================================

-- 1. Extend the bookings status CHECK constraint with the lifecycle statuses
DO $$
BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
  ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
      'open','accepted','rejected','assigned','on_the_way','arrived',
      'in_progress','waiting_parts','completed','cancelled','payment_received'
    ));
EXCEPTION WHEN others THEN NULL;
END $$;

-- 2. Link technician user accounts (users.role = 'technician') to a roster
--    record in the technicians table so the Technician Dashboard can scope
--    jobs to the individual technician. Optional — NULL falls back to the
--    shop-wide active job list.
ALTER TABLE users ADD COLUMN IF NOT EXISTS technician_id INTEGER
  REFERENCES technicians(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_technician ON users(technician_id)
  WHERE technician_id IS NOT NULL;

-- 3. Timeline lookup performance (booking + timestamp order is the common
--    access pattern for the repair timeline + analytics).
CREATE INDEX IF NOT EXISTS idx_timeline_booking_created
  ON booking_timeline(booking_id, created_at ASC);

-- 4. Analytic support: look up when a booking first reached 'assigned'
--    (technician response time) and when it reached 'completed'
--    (completion time) from the timeline.
CREATE INDEX IF NOT EXISTS idx_timeline_new_value
  ON booking_timeline(new_value, created_at)
  WHERE new_value IN ('assigned','completed','payment_received');


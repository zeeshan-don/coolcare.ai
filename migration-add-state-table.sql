-- Migration: upgrade conversation_state table for the new state machine
-- Run this in your Neon SQL console if you already have the old table.

-- 1. Add status column (replaces the old 'step' column)
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS booking_id TEXT;

-- 2. Backfill status from old 'step' values
UPDATE conversation_state SET status = 'COLLECTING_APPLIANCE' WHERE step = 'appliance'  AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_ISSUE'     WHERE step = 'issue'      AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_NAME'      WHERE step = 'name'       AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_ADDRESS'   WHERE step = 'address'    AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_LOCALITY'  WHERE step = 'area'       AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_DATE'      WHERE step = 'urgency'    AND status IS NULL;
UPDATE conversation_state SET status = 'CONFIRMATION_PENDING' WHERE step = 'confirm'    AND status IS NULL;
-- Catch-all for any remaining rows
UPDATE conversation_state SET status = 'COLLECTING_APPLIANCE' WHERE status IS NULL;

-- 3. Set NOT NULL now that all rows have a value
ALTER TABLE conversation_state ALTER COLUMN status SET NOT NULL;
ALTER TABLE conversation_state ALTER COLUMN status SET DEFAULT 'COLLECTING_APPLIANCE';

-- 4. Clear all in-progress conversations so users start fresh with the new flow
--    (Comment this out if you want to preserve existing sessions)
DELETE FROM conversation_state WHERE status NOT IN ('BOOKED', 'CANCELLED');

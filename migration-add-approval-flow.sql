-- =============================================================================
-- CoolCare — Migration: Add approval flow to repair_shops
-- Implements: payment → pending approval → super admin approve/reject → AI activated
-- Safe to re-run (uses IF NOT EXISTS guards).
-- =============================================================================

-- 1. Add approval_status column
-- Values: 'pending' (after payment, awaiting admin), 'approved', 'rejected'
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'none';
ALTER TABLE repair_shops ALTER COLUMN approval_status SET DEFAULT 'none';

-- 2. Approval metadata
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS approved_by INTEGER;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- 3. Backfill: existing active shops should be marked as approved
UPDATE repair_shops SET approval_status = 'approved', approved_at = now()
WHERE subscription_status = 'active' AND (approval_status IS NULL OR approval_status = 'none');

-- =============================================================================
-- Done
-- =============================================================================

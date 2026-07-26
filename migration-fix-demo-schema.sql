-- =============================================================================
-- CoolCare — Migration: Fix Missing Columns for Demo Seeder
--
-- The demo seeder in api/auth.js inserts into several tables using columns
-- that were added by incremental migrations but may be missing from production.
--
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards throughout).
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. bookings — missing columns
-- =============================================================================

-- updated_at: Only exists in schema.sql CREATE TABLE, NOT in any migration.
-- The demo seeder always inserts this column.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- address: Added by migration-repair-shop-auth.sql and schema.sql, but
-- repeated here for safety since api/bookings.js inserts into it.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS address TEXT;

-- These were added by migration-saas-upgrade.sql / migration-repair-shop-auth.sql
-- but not every production database has run those successfully.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reschedule_date TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS estimated_arrival TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS photo_urls TEXT[];
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS technician_name TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS technician_notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(10,2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_cost NUMERIC(10,2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;

-- Fix status check constraint: the demo seeder uses status values like
-- 'accepted', 'on_the_way', 'arrived' which need the expanded constraint.
DO $$
BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
  ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
      'open','accepted','rejected','assigned','on_the_way','arrived','completed','cancelled'
    ));
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bookings_shop ON bookings(repair_shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_shop_status_created
  ON bookings(repair_shop_id, status, created_at DESC);

-- =============================================================================
-- 2. subscriptions — missing columns (added by migration-create-missing-tables)
-- =============================================================================
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';

-- =============================================================================
-- 3. technicians — missing columns
-- =============================================================================
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS specialization TEXT[];

CREATE INDEX IF NOT EXISTS idx_technicians_shop ON technicians(repair_shop_id);

-- =============================================================================
-- 4. conversation_state — missing columns (referenced by demo WhatsApp flow)
-- =============================================================================
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';

CREATE INDEX IF NOT EXISTS idx_conv_state_shop ON conversation_state(repair_shop_id);

-- =============================================================================
-- 5. repair_shops — ensure all demo-referenced columns exist
-- =============================================================================
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'shop';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'none';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS approved_by INTEGER;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS referred_by TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS discount_balance NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS gst_number TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Asia/Kolkata';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS business_hours JSONB DEFAULT '{}';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS pincode TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS selected_country TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS selected_currency TEXT;

-- Fix role constraint
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

-- Fix approval_status constraint
DO $$
BEGIN
  ALTER TABLE repair_shops DROP CONSTRAINT IF EXISTS repair_shops_approval_status_check;
  ALTER TABLE repair_shops ADD CONSTRAINT repair_shops_approval_status_check
    CHECK (approval_status IN ('none','pending','approved','rejected'));
EXCEPTION WHEN others THEN NULL;
END $$;

-- =============================================================================
-- 6. ai_settings — ensure the table and its columns exist
-- =============================================================================
CREATE TABLE IF NOT EXISTS ai_settings (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  greeting_message TEXT DEFAULT '',
  business_hours   JSONB DEFAULT '{}',
  working_days     TEXT[] DEFAULT ARRAY['mon','tue','wed','thu','fri','sat'],
  supported_services TEXT[] DEFAULT '{}',
  knowledge_base   TEXT DEFAULT '',
  fallback_response TEXT DEFAULT 'I apologize, but I am unable to help with that right now. A team member will get back to you shortly.',
  transfer_to_human BOOLEAN NOT NULL DEFAULT true,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(repair_shop_id)
);

-- =============================================================================
-- 7. whatsapp_conversations — ensure we have booking_id column
-- =============================================================================
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS booking_id INTEGER
  REFERENCES bookings(id) ON DELETE SET NULL;

-- =============================================================================
-- 8. Ensure subscription_plans has 'pro' plan that the demo seeder uses
-- =============================================================================
INSERT INTO subscription_plans (name, display_name, price_monthly_usd, price_yearly_usd, max_bookings, max_technicians, features, description, trial_days, currency)
VALUES
  ('pro', 'CoolCare Pro', 20.00, 192.00, NULL, NULL,
   '{"whatsapp_bot": true, "dashboard": true, "notifications": true, "analytics": true, "priority_support": true, "custom_ai": true, "unlimited_bookings": true}',
   'Everything you need to run your repair shop with AI-powered automation.', 14, 'USD')
ON CONFLICT (name) DO NOTHING;

-- Set quarterly/half-yearly prices for pro plan
UPDATE subscription_plans SET price_quarterly_usd = price_monthly_usd * 3 * 0.9
WHERE name = 'pro' AND price_quarterly_usd IS NULL AND price_monthly_usd IS NOT NULL;

UPDATE subscription_plans SET price_halfyearly_usd = price_monthly_usd * 6 * 0.85
WHERE name = 'pro' AND price_halfyearly_usd IS NULL AND price_monthly_usd IS NOT NULL;

-- =============================================================================
-- Done
-- =============================================================================
COMMIT;

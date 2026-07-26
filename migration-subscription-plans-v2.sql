-- =============================================================================
-- CoolCare AI — Migration: Subscription Plans v2
-- Adds: active column to subscription_plan_prices for enable/disable per currency
-- Adds: selected_country column to repair_shops for storing user's country
-- Seeds: Exact pricing for all currencies per the new pricing table
-- Safe to re-run (IF NOT EXISTS / ON CONFLICT guards throughout)
-- =============================================================================

-- ─── 1. Add active column to subscription_plan_prices ───────────────────────
ALTER TABLE subscription_plan_prices ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- ─── 2. Add selected_country to repair_shops ────────────────────────────────
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS selected_country TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS selected_currency TEXT;

-- ─── 3. Ensure currency exists in CURRENCIES (add if missing) ────────────
-- The supported currencies are: USD, INR, AED, KWD

-- ─── 4. Seed or update exact pricing for the 'pro' plan ─────────────────────
-- Uses the exact pricing from the user's requirements
-- INR: Monthly: 1299, Quarterly: 3156, Half-Yearly: 6625, Yearly: 12470
-- USD: Monthly: 20, Quarterly: 54, Half-Yearly: 102, Yearly: 192
-- AED: Monthly: 75, Quarterly: 202.5, Half-Yearly: 382.5, Yearly: 720
-- KWD: Monthly: 6, Quarterly: 16.2, Half-Yearly: 30.6, Yearly: 57.6

-- First ensure the 'pro' plan exists with proper settings
INSERT INTO subscription_plans (name, display_name, price_monthly_usd, price_yearly_usd, features, description, trial_days, currency, is_active)
VALUES ('pro', 'CoolCare Pro', 20.00, 192.00,
  '{"whatsapp_bot": true, "dashboard": true, "notifications": true, "analytics": true, "priority_support": true, "custom_ai": true, "unlimited_bookings": true}',
  'Everything you need to run your repair shop with AI-powered automation.',
  0, 'USD', true)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  price_monthly_usd = EXCLUDED.price_monthly_usd,
  price_yearly_usd = EXCLUDED.price_yearly_usd,
  is_active = true;

-- Seed/update pricing for all supported currencies
INSERT INTO subscription_plan_prices (plan_id, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly, active)
SELECT sp.id, v.currency, v.price_monthly, v.price_quarterly, v.price_halfyearly, v.price_yearly, true
FROM subscription_plans sp
CROSS JOIN (VALUES
  ('INR', 1299.00, 3156.00, 6625.00, 12470.00),
  ('USD', 20.00, 54.00, 102.00, 192.00),
  ('AED', 75.00, 202.50, 382.50, 720.00),
  ('KWD', 6.00, 16.20, 30.60, 57.60)
) AS v(currency, price_monthly, price_quarterly, price_halfyearly, price_yearly)
WHERE sp.name = 'pro'
ON CONFLICT (plan_id, currency) DO UPDATE SET
  price_monthly = EXCLUDED.price_monthly,
  price_quarterly = EXCLUDED.price_quarterly,
  price_halfyearly = EXCLUDED.price_halfyearly,
  price_yearly = EXCLUDED.price_yearly,
  active = true,
  updated_at = now();

-- ─── 5. Index for faster lookups ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_active
  ON subscription_plan_prices(active) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_lookup
  ON subscription_plan_prices(plan_id, currency)
  WHERE active = true;

-- Done

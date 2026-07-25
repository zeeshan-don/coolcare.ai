-- =============================================================================
-- CoolCare — Migration: Payment & Subscription System v2
-- Adds: payment_gateways, invoices, subscription_history, payment_logs
-- Expands subscriptions billing_cycle constraint.
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards throughout).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PAYMENT GATEWAYS — configurable from admin dashboard
--    Secrets are AES-256 encrypted; never stored in plaintext.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_gateways (
  id               SERIAL PRIMARY KEY,
  provider         TEXT NOT NULL UNIQUE
                   CHECK (provider IN ('razorpay','stripe','paypal','phonepe','cashfree')),
  display_name     TEXT NOT NULL,
  is_enabled       BOOLEAN NOT NULL DEFAULT false,
  is_test_mode     BOOLEAN NOT NULL DEFAULT true,
  -- Encrypted credential blobs (AES-256-GCM, key from GATEWAY_ENCRYPT_KEY env)
  key_id           TEXT,              -- encrypted public key / key ID
  key_secret       TEXT,              -- encrypted secret key
  webhook_secret   TEXT,              -- encrypted webhook secret
  extra_config     JSONB DEFAULT '{}', -- any provider-specific settings
  priority         INTEGER NOT NULL DEFAULT 0, -- lower = tried first
  last_tested_at   TIMESTAMPTZ,
  updated_by       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_gateways_enabled ON payment_gateways(is_enabled) WHERE is_enabled = true;

-- Seed Razorpay gateway (disabled by default, admin must configure)
INSERT INTO payment_gateways (provider, display_name, is_enabled, is_test_mode, priority)
VALUES ('razorpay', 'Razorpay', false, true, 1)
ON CONFLICT (provider) DO NOTHING;

INSERT INTO payment_gateways (provider, display_name, is_enabled, is_test_mode, priority)
VALUES ('stripe', 'Stripe', false, true, 2)
ON CONFLICT (provider) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. EXPAND subscriptions billing_cycle constraint
--    Old: ('monthly','yearly')
--    New: ('monthly','quarterly','halfyearly','yearly')
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_billing_cycle_check;
  ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_billing_cycle_check
    CHECK (billing_cycle IN ('monthly','quarterly','halfyearly','yearly'));
EXCEPTION WHEN others THEN NULL;
END $$;

-- Add amount_paid and currency to subscriptions for tracking
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_payment_id INTEGER;

-- -----------------------------------------------------------------------------
-- 3. INVOICES — generated on each successful payment
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id               SERIAL PRIMARY KEY,
  invoice_number   TEXT NOT NULL UNIQUE,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  subscription_id  INTEGER REFERENCES subscriptions(id),
  payment_id       INTEGER REFERENCES payments(id),
  -- Invoice details
  plan_name        TEXT NOT NULL,
  billing_cycle    TEXT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  subtotal         NUMERIC(12,2) NOT NULL,
  tax_rate         NUMERIC(5,2) DEFAULT 0,
  tax_amount       NUMERIC(12,2) DEFAULT 0,
  total            NUMERIC(12,2) NOT NULL,
  -- Business info snapshot (at time of invoice)
  business_name    TEXT,
  business_address TEXT,
  business_gst     TEXT,
  -- Status
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','issued','paid','void','refunded')),
  issued_at        TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  due_date         TIMESTAMPTZ,
  notes            TEXT,
  pdf_url          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_shop ON invoices(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. SUBSCRIPTION HISTORY — audit trail for all subscription state changes
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_history (
  id               SERIAL PRIMARY KEY,
  subscription_id  INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  action           TEXT NOT NULL
                   CHECK (action IN (
                     'created','activated','renewed','expired','cancelled',
                     'reactivated','plan_changed','extended','suspended','unsuspended'
                   )),
  old_status       TEXT,
  new_status       TEXT,
  old_plan         TEXT,
  new_plan         TEXT,
  old_expiry       TIMESTAMPTZ,
  new_expiry       TIMESTAMPTZ,
  amount           NUMERIC(12,2),
  currency         TEXT,
  billing_cycle    TEXT,
  gateway          TEXT,
  notes            TEXT,
  actor_type       TEXT DEFAULT 'system'
                   CHECK (actor_type IN ('system','shop','admin','webhook')),
  actor_id         INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_history_shop ON subscription_history(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_sub_history_sub ON subscription_history(subscription_id);
CREATE INDEX IF NOT EXISTS idx_sub_history_created ON subscription_history(created_at DESC);

-- -----------------------------------------------------------------------------
-- 5. PAYMENT LOGS — detailed processing log for every payment attempt
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_logs (
  id               SERIAL PRIMARY KEY,
  payment_id       INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  repair_shop_id   INTEGER REFERENCES repair_shops(id) ON DELETE SET NULL,
  gateway          TEXT NOT NULL,
  event_type       TEXT NOT NULL,  -- checkout_created, webhook_received, signature_verified, etc.
  severity         TEXT NOT NULL DEFAULT 'info'
                   CHECK (severity IN ('debug','info','warning','error','critical')),
  message          TEXT NOT NULL,
  request_data     JSONB DEFAULT '{}',
  response_data    JSONB DEFAULT '{}',
  error_message    TEXT,
  ip_address       TEXT,
  idempotency_key  TEXT,          -- prevent duplicate webhook processing
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_logs_payment ON payment_logs(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_shop ON payment_logs(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_gateway ON payment_logs(gateway);
CREATE INDEX IF NOT EXISTS idx_payment_logs_event ON payment_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_payment_logs_created ON payment_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_logs_idempotency ON payment_logs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 6. PLATFORM SETTINGS — add payment_settings entry
-- -----------------------------------------------------------------------------
INSERT INTO platform_settings (key, value) VALUES
  ('payment_settings', '{
    "business_name": "CoolCare",
    "business_address": "",
    "business_gst": "",
    "tax_rate": 0,
    "invoice_prefix": "INV",
    "renewal_reminder_days": [7, 3, 1],
    "auto_expire": true
  }')
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 7. UPDATE subscription_plans — seed CoolCare Pro (single plan)
-- -----------------------------------------------------------------------------
INSERT INTO subscription_plans (name, display_name, price_monthly_usd, price_yearly_usd, max_bookings, max_technicians, features, description, max_staff, whatsapp_conversations, ai_credits, trial_days, currency)
VALUES ('pro', 'CoolCare Pro', 20.00, 192.00, NULL, NULL,
  '{"whatsapp_bot": true, "dashboard": true, "notifications": true, "analytics": true, "priority_support": true, "custom_ai": true, "unlimited_bookings": true}',
  'Everything you need to run your repair shop with AI-powered automation.',
  NULL, NULL, NULL, 14, 'USD')
ON CONFLICT (name) DO NOTHING;

-- Seed CoolCare Pro pricing for all currencies
INSERT INTO subscription_plan_prices (plan_id, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly)
SELECT sp.id, v.currency, v.price_monthly, v.price_quarterly, v.price_halfyearly, v.price_yearly
FROM subscription_plans sp
CROSS JOIN (VALUES
  ('INR', 1299.00, 3156.00, 6625.00, 12470.00),
  ('USD', 20.00, 54.00, 102.00, 192.00),
  ('AED', 75.00, 202.50, 382.50, 720.00),
  ('KWD', 6.00, 16.20, 30.60, 57.60)
) AS v(currency, price_monthly, price_quarterly, price_halfyearly, price_yearly)
WHERE sp.name = 'pro'
ON CONFLICT (plan_id, currency) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Done
-- -----------------------------------------------------------------------------

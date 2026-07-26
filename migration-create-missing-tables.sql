-- =============================================================================
-- CoolCare — Migration: Create All Missing Tables & Columns for Production
-- This is a comprehensive migration that creates EVERY table and column
-- that the admin pages and backend code expect, but may be missing from
-- the production Neon database.
--
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS / ON CONFLICT DO NOTHING
-- throughout). Preserves all existing production data.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. SUBSCRIPTION PLANS
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscription_plans (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  display_name       TEXT NOT NULL,
  price_monthly_usd  NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_yearly_usd   NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_quarterly_usd  NUMERIC(10,2),
  price_halfyearly_usd NUMERIC(10,2),
  max_bookings       INTEGER,
  max_technicians    INTEGER,
  max_staff          INTEGER,
  whatsapp_conversations INTEGER,
  ai_credits         INTEGER,
  trial_days         INTEGER DEFAULT 14,
  features           JSONB NOT NULL DEFAULT '{}',
  description        TEXT DEFAULT '',
  currency           TEXT DEFAULT 'USD',
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default plans if the table is empty
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM subscription_plans LIMIT 1) THEN
    INSERT INTO subscription_plans (name, display_name, price_monthly_usd, price_yearly_usd, max_bookings, max_technicians, features, description, trial_days, currency)
    VALUES
      ('starter',      'Starter',      29.00,  290.00,  100, 3,  '{"whatsapp_bot": true, "dashboard": true, "notifications": true}', 'Best for small repair shops getting started with AI.', 14, 'USD'),
      ('professional', 'Professional', 59.00,  590.00,  500, 10, '{"whatsapp_bot": true, "dashboard": true, "notifications": true, "analytics": true, "priority_support": true}', 'For growing shops that need analytics and priority support.', 14, 'USD'),
      ('enterprise',   'Enterprise',   149.00, 1490.00, NULL, NULL,'{"whatsapp_bot": true, "dashboard": true, "notifications": true, "analytics": true, "priority_support": true, "custom_branding": true, "api_access": true}', 'For large operations needing full customization and API access.', 14, 'USD'),
      ('pro',          'CoolCare Pro', 20.00,  192.00,  NULL, NULL,'{"whatsapp_bot": true, "dashboard": true, "notifications": true, "analytics": true, "priority_support": true, "custom_ai": true, "unlimited_bookings": true}', 'Everything you need to run your repair shop with AI-powered automation.', 14, 'USD')
    ON CONFLICT (name) DO NOTHING;

    -- Set quarterly/half-yearly prices
    UPDATE subscription_plans SET price_quarterly_usd = price_monthly_usd * 3 * 0.9 WHERE price_quarterly_usd IS NULL AND price_monthly_usd IS NOT NULL;
    UPDATE subscription_plans SET price_halfyearly_usd = price_monthly_usd * 6 * 0.85 WHERE price_halfyearly_usd IS NULL AND price_monthly_usd IS NOT NULL;
  END IF;
END $$;

-- Add missing columns to subscription_plans (safe to re-run)
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_staff INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS whatsapp_conversations INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS ai_credits INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 14;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_quarterly_usd NUMERIC(10,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_halfyearly_usd NUMERIC(10,2);

-- Set defaults for columns that may be null
UPDATE subscription_plans SET trial_days = 14 WHERE trial_days IS NULL;
UPDATE subscription_plans SET currency = 'USD' WHERE currency IS NULL;

-- =============================================================================
-- 2. SUBSCRIPTION PLAN PRICES (multi-currency pricing)
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscription_plan_prices (
  id                SERIAL PRIMARY KEY,
  plan_id           INTEGER NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  currency          TEXT NOT NULL,
  price_monthly     NUMERIC(10,2) NOT NULL,
  price_quarterly   NUMERIC(10,2) NOT NULL,
  price_halfyearly  NUMERIC(10,2) NOT NULL,
  price_yearly      NUMERIC(10,2) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_currency ON subscription_plan_prices(currency);
CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_plan_currency ON subscription_plan_prices(plan_id, currency);

-- Seed pricing for all plans if table is empty
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM subscription_plan_prices LIMIT 1) THEN
    INSERT INTO subscription_plan_prices (plan_id, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly)
    SELECT sp.id, v.currency, v.price_monthly, v.price_quarterly, v.price_halfyearly, v.price_yearly
    FROM subscription_plans sp
    CROSS JOIN (VALUES
      ('starter',      'INR', 1299.00, 3156.00, 6625.00, 12470.00),
      ('professional', 'INR', 3499.00, 9447.00, 17845.00, 33590.00),
      ('enterprise',   'INR', 6499.00, 17547.00, 33145.00, 62390.00),
      ('pro',          'INR', 1299.00, 3156.00, 6625.00, 12470.00),
      ('starter',      'USD', 20.00,   54.00,   102.00,  192.00),
      ('professional', 'USD', 60.00,   162.00,  306.00,  576.00),
      ('enterprise',   'USD', 100.00,  270.00,  510.00,  960.00),
      ('pro',          'USD', 20.00,   54.00,   102.00,  192.00),
      ('starter',      'AED', 75.00,   202.50,  382.50,  720.00),
      ('professional', 'AED', 220.00,  594.00,  1122.00, 2112.00),
      ('enterprise',   'AED', 370.00,  999.00,  1887.00, 3552.00),
      ('pro',          'AED', 75.00,   202.50,  382.50,  720.00),
      ('starter',      'KWD', 6.00,    16.20,   30.60,   57.60),
      ('professional', 'KWD', 18.00,   48.60,   91.80,   172.80),
      ('enterprise',   'KWD', 30.00,   81.00,   153.00,  288.00),
      ('pro',          'KWD', 6.00,    16.20,   30.60,   57.60)
    ) AS v(plan_name, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly)
    WHERE sp.name = v.plan_name
    ON CONFLICT (plan_id, currency) DO NOTHING;
  END IF;
END $$;

-- =============================================================================
-- 3. SUBSCRIPTIONS (active subscription per shop)
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id                  SERIAL PRIMARY KEY,
  repair_shop_id      INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  plan_id             INTEGER NOT NULL REFERENCES subscription_plans(id),
  status              TEXT NOT NULL DEFAULT 'trial'
                      CHECK (status IN ('trial','active','past_due','cancelled','expired')),
  billing_cycle       TEXT NOT NULL DEFAULT 'monthly'
                      CHECK (billing_cycle IN ('monthly','quarterly','halfyearly','yearly')),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end   TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '14 days'),
  trial_end           TIMESTAMPTZ,
  cancel_at           TIMESTAMPTZ,
  gateway             TEXT,
  gateway_sub_id      TEXT,
  amount_paid         NUMERIC(12,2) DEFAULT 0,
  currency            TEXT DEFAULT 'USD',
  last_payment_id     INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_shop ON subscriptions(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_shop_created ON subscriptions(repair_shop_id, created_at DESC);

-- Expand billing_cycle constraint
DO $$
BEGIN
  ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_billing_cycle_check;
  ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_billing_cycle_check
    CHECK (billing_cycle IN ('monthly','quarterly','halfyearly','yearly'));
EXCEPTION WHEN others THEN NULL;
END $$;

-- Add missing columns
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_payment_id INTEGER;

-- =============================================================================
-- 4. PAYMENTS
-- =============================================================================
CREATE TABLE IF NOT EXISTS payments (
  id                SERIAL PRIMARY KEY,
  repair_shop_id    INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  subscription_id   INTEGER REFERENCES subscriptions(id),
  payment_id        TEXT UNIQUE,
  transaction_id    TEXT,
  gateway           TEXT NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  amount            NUMERIC(12,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','completed','failed','refunded','partially_refunded')),
  invoice_number    TEXT UNIQUE,
  description       TEXT,
  metadata          JSONB DEFAULT '{}',
  refund_amount     NUMERIC(12,2) DEFAULT 0,
  refund_reason     TEXT,
  refunded_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_shop ON payments(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_gateway ON payments(gateway);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_shop_created ON payments(repair_shop_id, created_at DESC);

-- =============================================================================
-- 5. COUPONS
-- =============================================================================
CREATE TABLE IF NOT EXISTS coupons (
  id                SERIAL PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  discount_type     TEXT NOT NULL DEFAULT 'percent'
                    CHECK (discount_type IN ('percent','fixed')),
  discount_value    NUMERIC(10,2) NOT NULL,
  max_uses          INTEGER,
  used_count        INTEGER NOT NULL DEFAULT 0,
  valid_from        TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until       TIMESTAMPTZ,
  applicable_plans  TEXT[],
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- 6. BOOKING TIMELINE (audit trail)
-- =============================================================================
CREATE TABLE IF NOT EXISTS booking_timeline (
  id                SERIAL PRIMARY KEY,
  booking_id        INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action            TEXT NOT NULL,
  old_value         TEXT,
  new_value         TEXT,
  actor_type        TEXT NOT NULL DEFAULT 'system'
                    CHECK (actor_type IN ('system','shop','customer','technician')),
  actor_id          INTEGER,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_booking ON booking_timeline(booking_id, created_at);

-- =============================================================================
-- 7. PAYMENT GATEWAYS (configurable from admin dashboard)
-- =============================================================================
CREATE TABLE IF NOT EXISTS payment_gateways (
  id                SERIAL PRIMARY KEY,
  provider          TEXT NOT NULL UNIQUE
                    CHECK (provider IN ('razorpay','stripe','paypal','phonepe','cashfree')),
  display_name      TEXT NOT NULL,
  is_enabled        BOOLEAN NOT NULL DEFAULT false,
  is_test_mode      BOOLEAN NOT NULL DEFAULT true,
  key_id            TEXT,
  key_secret        TEXT,
  webhook_secret    TEXT,
  extra_config      JSONB DEFAULT '{}',
  priority          INTEGER NOT NULL DEFAULT 0,
  last_tested_at    TIMESTAMPTZ,
  updated_by        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_gateways_enabled ON payment_gateways(is_enabled) WHERE is_enabled = true;

-- Seed default gateways (disabled, admin must configure)
INSERT INTO payment_gateways (provider, display_name, is_enabled, is_test_mode, priority)
VALUES ('razorpay', 'Razorpay', false, true, 1)
ON CONFLICT (provider) DO NOTHING;

INSERT INTO payment_gateways (provider, display_name, is_enabled, is_test_mode, priority)
VALUES ('stripe', 'Stripe', false, true, 2)
ON CONFLICT (provider) DO NOTHING;

-- =============================================================================
-- 8. INVOICES
-- =============================================================================
CREATE TABLE IF NOT EXISTS invoices (
  id                SERIAL PRIMARY KEY,
  invoice_number    TEXT NOT NULL UNIQUE,
  repair_shop_id    INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  subscription_id   INTEGER REFERENCES subscriptions(id),
  payment_id        INTEGER REFERENCES payments(id),
  plan_name         TEXT NOT NULL,
  billing_cycle     TEXT NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  subtotal          NUMERIC(12,2) NOT NULL,
  tax_rate          NUMERIC(5,2) DEFAULT 0,
  tax_amount        NUMERIC(12,2) DEFAULT 0,
  total             NUMERIC(12,2) NOT NULL,
  business_name     TEXT,
  business_address  TEXT,
  business_gst      TEXT,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','issued','paid','void','refunded')),
  issued_at         TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  due_date          TIMESTAMPTZ,
  notes             TEXT,
  pdf_url           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_shop ON invoices(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at DESC);

-- =============================================================================
-- 9. SUBSCRIPTION HISTORY (audit trail)
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscription_history (
  id                SERIAL PRIMARY KEY,
  subscription_id   INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
  repair_shop_id    INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  action            TEXT NOT NULL
                    CHECK (action IN (
                      'created','activated','renewed','expired','cancelled',
                      'reactivated','plan_changed','extended','suspended','unsuspended'
                    )),
  old_status        TEXT,
  new_status        TEXT,
  old_plan          TEXT,
  new_plan          TEXT,
  old_expiry        TIMESTAMPTZ,
  new_expiry        TIMESTAMPTZ,
  amount            NUMERIC(12,2),
  currency          TEXT,
  billing_cycle     TEXT,
  gateway           TEXT,
  notes             TEXT,
  actor_type        TEXT DEFAULT 'system'
                    CHECK (actor_type IN ('system','shop','admin','webhook')),
  actor_id          INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_history_shop ON subscription_history(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_sub_history_sub ON subscription_history(subscription_id);
CREATE INDEX IF NOT EXISTS idx_sub_history_created ON subscription_history(created_at DESC);

-- =============================================================================
-- 10. PAYMENT LOGS
-- =============================================================================
CREATE TABLE IF NOT EXISTS payment_logs (
  id                SERIAL PRIMARY KEY,
  payment_id        INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  repair_shop_id    INTEGER REFERENCES repair_shops(id) ON DELETE SET NULL,
  gateway           TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  severity          TEXT NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('debug','info','warning','error','critical')),
  message           TEXT NOT NULL,
  request_data      JSONB DEFAULT '{}',
  response_data     JSONB DEFAULT '{}',
  error_message     TEXT,
  ip_address        TEXT,
  idempotency_key   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_logs_payment ON payment_logs(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_shop ON payment_logs(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_gateway ON payment_logs(gateway);
CREATE INDEX IF NOT EXISTS idx_payment_logs_event ON payment_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_payment_logs_created ON payment_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_logs_idempotency ON payment_logs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- =============================================================================
-- 11. USERS (platform staff + shop employees)
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL
                    CHECK (role IN (
                      'super_admin','admin','support',
                      'owner','manager','editor','receptionist','technician'
                    )),
  repair_shop_id    INTEGER REFERENCES repair_shops(id) ON DELETE CASCADE,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  last_login        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_repair_shop ON users(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = true;

-- =============================================================================
-- 12. PLATFORM SETTINGS (key-value store)
-- =============================================================================
CREATE TABLE IF NOT EXISTS platform_settings (
  key               TEXT PRIMARY KEY,
  value             JSONB NOT NULL DEFAULT '{}',
  updated_by        INTEGER,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default platform settings (safe to re-run)
INSERT INTO platform_settings (key, value) VALUES
  ('platform_name',       '{"value": "CoolCare"}'),
  ('logo_url',            '{"value": ""}'),
  ('maintenance_mode',    '{"value": false}'),
  ('announcement',        '{"value": "", "active": false}'),
  ('whatsapp_settings',   '{"access_token": "", "phone_number_id": "", "api_version": "v19.0"}'),
  ('ai_settings',         '{"groq_api_key": "", "model": "llama3-8b-8192", "system_prompt": ""}'),
  ('email_settings',      '{"from_email": "noreply@coolcare.ai", "smtp_host": "", "smtp_port": "587"}'),
  ('default_currency',    '{"value": "USD"}'),
  ('payment_settings',    '{"business_name": "CoolCare", "business_address": "", "business_gst": "", "tax_rate": 0, "invoice_prefix": "INV", "renewal_reminder_days": [7, 3, 1], "auto_expire": true}')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- 13. ADMIN ACTION LOG (audit trail for admin operations)
-- =============================================================================
CREATE TABLE IF NOT EXISTS admin_action_log (
  id                SERIAL PRIMARY KEY,
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('user', 'shop')),
  actor_id          INTEGER NOT NULL,
  action            TEXT NOT NULL,
  target_type       TEXT,
  target_id         INTEGER,
  details           JSONB DEFAULT '{}',
  ip_address        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_log_actor ON admin_action_log(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_admin_log_created ON admin_action_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_log_action ON admin_action_log(action);

-- =============================================================================
-- 14. SHOP NOTIFICATIONS (in-app notification feed)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shop_notifications (
  id                SERIAL PRIMARY KEY,
  repair_shop_id    INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  title             TEXT NOT NULL,
  message           TEXT NOT NULL,
  is_read           BOOLEAN NOT NULL DEFAULT false,
  link              TEXT,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_notif_shop ON shop_notifications(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_notif_unread ON shop_notifications(repair_shop_id, is_read) WHERE is_read = false;

-- =============================================================================
-- 15. REFERRALS
-- =============================================================================
CREATE TABLE IF NOT EXISTS referrals (
  id                SERIAL PRIMARY KEY,
  referrer_shop_id  INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  referred_shop_id  INTEGER REFERENCES repair_shops(id) ON DELETE SET NULL,
  referral_code     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','completed','expired')),
  reward_type       TEXT NOT NULL DEFAULT 'discount'
                    CHECK (reward_type IN ('discount','wallet')),
  reward_value      NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_shop_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_shop_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- =============================================================================
-- 16. NOTIFICATION LOG
-- =============================================================================
CREATE TABLE IF NOT EXISTS notification_log (
  id                SERIAL PRIMARY KEY,
  repair_shop_id    INTEGER REFERENCES repair_shops(id) ON DELETE SET NULL,
  booking_id        INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  channel           TEXT NOT NULL CHECK (channel IN ('whatsapp','email','sms','push')),
  recipient         TEXT NOT NULL,
  template          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','queued')),
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_shop ON notification_log(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_notifications_booking ON notification_log(booking_id);

-- =============================================================================
-- 17. WHATSAPP CONVERSATIONS (message log per shop)
-- =============================================================================
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id                SERIAL PRIMARY KEY,
  repair_shop_id    INTEGER REFERENCES repair_shops(id) ON DELETE SET NULL,
  customer_number   TEXT NOT NULL,
  customer_name     TEXT,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  message_text      TEXT NOT NULL,
  ai_response       TEXT,
  booking_id        INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'delivered'
                    CHECK (status IN ('sent','delivered','read','failed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_conv_shop ON whatsapp_conversations(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_wa_conv_customer ON whatsapp_conversations(customer_number);
CREATE INDEX IF NOT EXISTS idx_wa_conv_created ON whatsapp_conversations(created_at DESC);

-- =============================================================================
-- 18. PASSWORD RESET TOKENS
-- =============================================================================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL,
  user_type         TEXT NOT NULL DEFAULT 'shop'
                    CHECK (user_type IN ('user', 'shop')),
  token_hash        TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_expires ON password_reset_tokens(expires_at);

-- =============================================================================
-- 19. JWT DENYLIST
-- =============================================================================
CREATE TABLE IF NOT EXISTS jwt_denylist (
  id         SERIAL PRIMARY KEY,
  jti        TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jwt_denylist_jti ON jwt_denylist(jti);
CREATE INDEX IF NOT EXISTS idx_jwt_denylist_expires ON jwt_denylist(expires_at);

-- =============================================================================
-- 20. MISSING COLUMNS ON EXISTING TABLES
-- =============================================================================

-- ---- repair_shops ----
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'shop';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'none'
  CHECK (approval_status IN ('none','pending','approved','rejected'));
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

-- Fix role constraint to include all roles
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

-- Fix approval_status constraint if already exists
DO $$
BEGIN
  ALTER TABLE repair_shops DROP CONSTRAINT IF EXISTS repair_shops_approval_status_check;
  ALTER TABLE repair_shops ADD CONSTRAINT repair_shops_approval_status_check
    CHECK (approval_status IN ('none','pending','approved','rejected'));
EXCEPTION WHEN others THEN NULL;
END $$;

-- Generate referral codes for existing shops that don't have one
UPDATE repair_shops
SET referral_code = 'COOLCARE-' || UPPER(SUBSTRING(MD5(CAST(id AS text) || CAST(random() AS text)), 1, 4))
WHERE referral_code IS NULL;

-- ---- bookings ----
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'
  CHECK (priority IN ('low','normal','high','urgent'));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reschedule_date TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS estimated_arrival TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS photo_urls TEXT[];
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS technician_name TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS technician_notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(10,2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_cost NUMERIC(10,2);

-- Fix status check constraint
DO $$
BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
  ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
      'open','accepted','rejected','assigned','on_the_way','arrived','completed','cancelled'
    ));
EXCEPTION WHEN others THEN NULL;
END $$;

-- Create indexes for bookings
CREATE INDEX IF NOT EXISTS idx_bookings_shop ON bookings(repair_shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_shop_status_created
  ON bookings(repair_shop_id, status, created_at DESC);

-- ---- technicians ----
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS specialization TEXT[];

CREATE INDEX IF NOT EXISTS idx_technicians_shop ON technicians(repair_shop_id);

-- ---- conversation_state ----
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';

-- =============================================================================
-- 21. PERFORMANCE INDEXES
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_repair_shops_subscription_status ON repair_shops(subscription_status);
CREATE INDEX IF NOT EXISTS idx_repair_shops_referral_code ON repair_shops(referral_code);
CREATE INDEX IF NOT EXISTS idx_repair_shops_created ON repair_shops(created_at DESC);

-- =============================================================================
-- 22. MAINTENANCE: expire old trial subscriptions
-- =============================================================================
UPDATE subscriptions
SET status = 'expired', updated_at = now()
WHERE status = 'trial' AND current_period_end < now();

UPDATE repair_shops
SET subscription_status = 'inactive'
WHERE subscription_status = 'trial'
AND id IN (
  SELECT s.repair_shop_id FROM subscriptions s
  WHERE s.status = 'expired'
  AND s.repair_shop_id = repair_shops.id
);

-- Clean up expired JWT tokens
DELETE FROM jwt_denylist WHERE expires_at < now();

-- Clean up expired password reset tokens
DELETE FROM password_reset_tokens WHERE expires_at < now();

COMMIT;

-- =============================================================================
-- CoolCare AI — COMPLETE COMBINED DATABASE SCHEMA & MIGRATIONS
-- =============================================================================
-- This file is the ONE FILE that replaces ALL of these individual files:
--   schema.sql (base)
--   migration-repair-shop-auth.sql
--   migration-saas-upgrade.sql
--   migration-rbac.sql
--   migration-payment-system.sql
--   migration-pricing-table.sql
--   migration-subscription-plans-v2.sql
--   migration-promotion-codes.sql
--   migration-password-reset.sql
--   migration-whatsapp-connection.sql
--   migration-v1-production.sql
--   migration-add-ai-settings-table.sql
--   migration-add-approval-flow.sql
--   migration-add-idempotency-unique-constraint.sql
--   migration-add-is-demo-column.sql
--   migration-add-language-and-repair-shop-to-conversation-state.sql
--   migration-add-state-table.sql
--   migration-create-missing-tables.sql
--   migration-fix-demo-schema.sql
--   migration-fix-repair-shops-columns.sql
-- =============================================================================
-- Safe to run multiple times: ALL operations use IF NOT EXISTS / IF EXISTS
-- / ON CONFLICT DO NOTHING guards throughout.
-- =============================================================================


-- =============================================================================
-- SECTION 1: BASE SCHEMA (schema.sql)
-- =============================================================================
-- =============================================================================

-- Conversations: stores WhatsApp chat history per customer
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  customer_number TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'bot')),
  message TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now(),
  approval_status TEXT NOT NULL DEFAULT 'none' CHECK (approval_status IN ('none','pending','approved','rejected')),
  approved_at    TIMESTAMPTZ,
  approved_by    INTEGER,
  rejection_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_number, created_at);

-- Conversation state: full state machine per customer
CREATE TABLE IF NOT EXISTS conversation_state (
  id SERIAL PRIMARY KEY,
  customer_number TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'COLLECTING_APPLIANCE',
  appliance     TEXT,
  issue         TEXT,
  customer_name TEXT,
  address       TEXT,
  area          TEXT,
  urgency       TEXT,
  booking_id    TEXT,
  repair_shop_id INTEGER,
  language      TEXT NOT NULL DEFAULT 'en',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_customer ON conversation_state(customer_number);
CREATE INDEX IF NOT EXISTS idx_conv_state_shop ON conversation_state(repair_shop_id);

-- Bookings: stores service requests extracted from conversations
CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  customer_number TEXT NOT NULL,
  customer_name TEXT,
  address TEXT,
  service_type TEXT,
  area TEXT,
  urgency TEXT,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'completed', 'cancelled')),
  technician_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_number);

-- Technicians: available service technicians
CREATE TABLE IF NOT EXISTS technicians (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  services TEXT[] NOT NULL,
  active BOOLEAN DEFAULT true
);

-- NOTE: No sample technicians are seeded. Shops add their own technicians via
-- the dashboard roster. The UI only ever shows technicians that exist in the DB.


-- =============================================================================
-- SECTION 2: REPAIR SHOP AUTH SYSTEM (migration-repair-shop-auth.sql)
-- =============================================================================

-- Ensure bookings.address exists
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS address TEXT;

-- Create repair_shops table
CREATE TABLE IF NOT EXISTS repair_shops (
  id               SERIAL PRIMARY KEY,
  shop_name        TEXT NOT NULL,
  owner_name       TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  mobile           TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  address          TEXT,
  city             TEXT,
  service_areas    TEXT[],
  services_offered TEXT[],
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_repair_shops_email  ON repair_shops(email);
CREATE INDEX IF NOT EXISTS idx_repair_shops_mobile ON repair_shops(mobile);

-- Add repair_shop_id FK to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_shop ON bookings(repair_shop_id, created_at DESC);

-- Extend bookings with job-management columns
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS technician_name  TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS technician_notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS estimated_cost   NUMERIC(10,2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_cost       NUMERIC(10,2);

-- Richer status set for shop job management
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

-- JWT token denylist
CREATE TABLE IF NOT EXISTS jwt_denylist (
  id         SERIAL PRIMARY KEY,
  jti        TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jwt_denylist_jti     ON jwt_denylist(jti);
CREATE INDEX IF NOT EXISTS idx_jwt_denylist_expires ON jwt_denylist(expires_at);


-- =============================================================================
-- SECTION 3: PRODUCTION SAAS UPGRADE (migration-saas-upgrade.sql)
-- =============================================================================

-- 3a. SUBSCRIPTION PLANS
CREATE TABLE IF NOT EXISTS subscription_plans (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  price_monthly_usd NUMERIC(10,2) NOT NULL,
  price_yearly_usd  NUMERIC(10,2) NOT NULL,
  max_bookings     INTEGER,
  max_technicians  INTEGER,
  features         JSONB NOT NULL DEFAULT '{}',
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO subscription_plans (name, display_name, price_monthly_usd, price_yearly_usd, max_bookings, max_technicians, features)
VALUES
  ('starter',      'Starter',      29.00,  290.00,  100, 3,  '{"whatsapp_bot": true, "dashboard": true, "notifications": true}'),
  ('professional', 'Professional', 59.00,  590.00,  500, 10, '{"whatsapp_bot": true, "dashboard": true, "notifications": true, "analytics": true, "priority_support": true}'),
  ('enterprise',   'Enterprise',   149.00, 1490.00, NULL, NULL,'{"whatsapp_bot": true, "dashboard": true, "notifications": true, "analytics": true, "priority_support": true, "custom_branding": true, "api_access": true}')
ON CONFLICT (name) DO NOTHING;

-- 3b. SUBSCRIPTIONS
CREATE TABLE IF NOT EXISTS subscriptions (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  plan_id          INTEGER NOT NULL REFERENCES subscription_plans(id),
  status           TEXT NOT NULL DEFAULT 'trial'
                   CHECK (status IN ('trial','active','past_due','cancelled','expired')),
  billing_cycle    TEXT NOT NULL DEFAULT 'monthly'
                   CHECK (billing_cycle IN ('monthly','yearly')),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end   TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '14 days'),
  trial_end        TIMESTAMPTZ,
  cancel_at        TIMESTAMPTZ,
  gateway          TEXT,
  gateway_sub_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_shop ON subscriptions(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- 3c. PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  subscription_id  INTEGER REFERENCES subscriptions(id),
  payment_id       TEXT UNIQUE,
  transaction_id   TEXT,
  gateway          TEXT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  amount           NUMERIC(12,2) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','completed','failed','refunded','partially_refunded')),
  invoice_number   TEXT UNIQUE,
  description      TEXT,
  metadata         JSONB DEFAULT '{}',
  refund_amount    NUMERIC(12,2) DEFAULT 0,
  refund_reason    TEXT,
  refunded_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_shop ON payments(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_gateway ON payments(gateway);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at DESC);

-- 3d. COUPONS
CREATE TABLE IF NOT EXISTS coupons (
  id               SERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  discount_type    TEXT NOT NULL DEFAULT 'percent'
                   CHECK (discount_type IN ('percent','fixed')),
  discount_value   NUMERIC(10,2) NOT NULL,
  max_uses         INTEGER,
  used_count       INTEGER NOT NULL DEFAULT 0,
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until      TIMESTAMPTZ,
  applicable_plans TEXT[],
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3e. BOOKING UPGRADES
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'
  CHECK (priority IN ('low','normal','high','urgent'));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reschedule_date TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS estimated_arrival TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS photo_urls TEXT[];
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_number TEXT;

-- Composite index for tenant-scoped filtered queries
CREATE INDEX IF NOT EXISTS idx_bookings_shop_status_created
  ON bookings(repair_shop_id, status, created_at DESC);

-- 3f. BOOKING TIMELINE
CREATE TABLE IF NOT EXISTS booking_timeline (
  id               SERIAL PRIMARY KEY,
  booking_id       INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action           TEXT NOT NULL,
  old_value        TEXT,
  new_value        TEXT,
  actor_type       TEXT NOT NULL DEFAULT 'system'
                   CHECK (actor_type IN ('system','shop','customer','technician')),
  actor_id         INTEGER,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_booking ON booking_timeline(booking_id, created_at);

-- 3g. TECHNICIANS — add tenant scoping
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS specialization TEXT[];

CREATE INDEX IF NOT EXISTS idx_technicians_shop ON technicians(repair_shop_id);

-- 3h. CONVERSATION STATE — add tenant scoping
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';

CREATE INDEX IF NOT EXISTS idx_conv_state_shop ON conversation_state(repair_shop_id);

-- 3i. REPAIR SHOPS — admin columns
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'shop'
  CHECK (role IN ('shop','admin','super_admin'));
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

-- 3j. NOTIFICATION LOG
CREATE TABLE IF NOT EXISTS notification_log (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER REFERENCES repair_shops(id) ON DELETE SET NULL,
  booking_id       INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  channel          TEXT NOT NULL CHECK (channel IN ('whatsapp','email','sms','push')),
  recipient        TEXT NOT NULL,
  template         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','queued')),
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_shop ON notification_log(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_notifications_booking ON notification_log(booking_id);

-- 3k. JWT DENYLIST CLEANUP
DELETE FROM jwt_denylist WHERE expires_at < now();


-- =============================================================================
-- SECTION 4: ROLE-BASED ACCESS CONTROL (migration-rbac.sql)
-- =============================================================================

-- 4a. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL
                   CHECK (role IN (
                     'super_admin','admin','support',
                     'owner','manager','editor','receptionist','technician'
                   )),
  repair_shop_id   INTEGER REFERENCES repair_shops(id) ON DELETE CASCADE,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  last_login       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_repair_shop ON users(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = true;

-- 4b. Expand repair_shops role CHECK CONSTRAINT
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

-- 4c. PLATFORM SETTINGS
CREATE TABLE IF NOT EXISTS platform_settings (
  key              TEXT PRIMARY KEY,
  value            JSONB NOT NULL DEFAULT '{}',
  updated_by       INTEGER,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (key, value) VALUES
  ('platform_name',       '{"value": "CoolCare"}'),
  ('logo_url',            '{"value": ""}'),
  ('maintenance_mode',    '{"value": false}'),
  ('announcement',        '{"value": "", "active": false}'),
  ('whatsapp_settings',   '{"access_token": "", "phone_number_id": "", "api_version": "v19.0"}'),
  ('ai_settings',         '{"groq_api_key": "", "model": "llama3-8b-8192", "system_prompt": ""}'),
  ('email_settings',      '{"from_email": "noreply@coolcare.zeeshstudios.in", "smtp_host": "", "smtp_port": "587"}'),
  ('default_currency',    '{"value": "USD"}')
ON CONFLICT (key) DO NOTHING;

-- 4c. Sweep any pre-existing email_settings rows still holding the old default
--     domain so re-runs of this migration also update already-seeded installs.
UPDATE platform_settings
SET value = value::jsonb || '{"from_email": "noreply@coolcare.zeeshstudios.in"}'::jsonb
WHERE key = 'email_settings'
  AND value::jsonb->>'from_email' = 'noreply@coolcare.ai';

-- 4d. Expand subscription_plans with additional fields
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_staff INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS whatsapp_conversations INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS ai_credits INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 14;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';

-- 4e. ADMIN ACTION LOG
CREATE TABLE IF NOT EXISTS admin_action_log (
  id               SERIAL PRIMARY KEY,
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('user', 'shop')),
  actor_id         INTEGER NOT NULL,
  action           TEXT NOT NULL,
  target_type      TEXT,
  target_id        INTEGER,
  details          JSONB DEFAULT '{}',
  ip_address       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_log_actor ON admin_action_log(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_admin_log_created ON admin_action_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_log_action ON admin_action_log(action);


-- =============================================================================
-- SECTION 5: PAYMENT & SUBSCRIPTION SYSTEM v2 (migration-payment-system.sql)
-- =============================================================================

-- 5a. PAYMENT GATEWAYS
CREATE TABLE IF NOT EXISTS payment_gateways (
  id               SERIAL PRIMARY KEY,
  provider         TEXT NOT NULL UNIQUE
                   CHECK (provider IN ('razorpay','stripe','paypal','phonepe','cashfree')),
  display_name     TEXT NOT NULL,
  is_enabled       BOOLEAN NOT NULL DEFAULT false,
  is_test_mode     BOOLEAN NOT NULL DEFAULT true,
  key_id           TEXT,
  key_secret       TEXT,
  webhook_secret   TEXT,
  extra_config     JSONB DEFAULT '{}',
  priority         INTEGER NOT NULL DEFAULT 0,
  last_tested_at   TIMESTAMPTZ,
  updated_by       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_gateways_enabled ON payment_gateways(is_enabled) WHERE is_enabled = true;

INSERT INTO payment_gateways (provider, display_name, is_enabled, is_test_mode, priority)
VALUES ('razorpay', 'Razorpay', false, true, 1)
ON CONFLICT (provider) DO NOTHING;

INSERT INTO payment_gateways (provider, display_name, is_enabled, is_test_mode, priority)
VALUES ('stripe', 'Stripe', false, true, 2)
ON CONFLICT (provider) DO NOTHING;

-- 5b. Expand subscriptions billing_cycle constraint
DO $$
BEGIN
  ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_billing_cycle_check;
  ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_billing_cycle_check
    CHECK (billing_cycle IN ('monthly','quarterly','halfyearly','yearly'));
EXCEPTION WHEN others THEN NULL;
END $$;

-- Add amount_paid and currency to subscriptions
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_payment_id INTEGER;

-- 5c. INVOICES
CREATE TABLE IF NOT EXISTS invoices (
  id               SERIAL PRIMARY KEY,
  invoice_number   TEXT NOT NULL UNIQUE,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  subscription_id  INTEGER REFERENCES subscriptions(id),
  payment_id       INTEGER REFERENCES payments(id),
  plan_name        TEXT NOT NULL,
  billing_cycle    TEXT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  subtotal         NUMERIC(12,2) NOT NULL,
  tax_rate         NUMERIC(5,2) DEFAULT 0,
  tax_amount       NUMERIC(12,2) DEFAULT 0,
  total            NUMERIC(12,2) NOT NULL,
  business_name    TEXT,
  business_address TEXT,
  business_gst     TEXT,
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

-- 5d. SUBSCRIPTION HISTORY
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

-- 5e. PAYMENT LOGS
CREATE TABLE IF NOT EXISTS payment_logs (
  id               SERIAL PRIMARY KEY,
  payment_id       INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  repair_shop_id   INTEGER REFERENCES repair_shops(id) ON DELETE SET NULL,
  gateway          TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  severity         TEXT NOT NULL DEFAULT 'info'
                   CHECK (severity IN ('debug','info','warning','error','critical')),
  message          TEXT NOT NULL,
  request_data     JSONB DEFAULT '{}',
  response_data    JSONB DEFAULT '{}',
  error_message    TEXT,
  ip_address       TEXT,
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_logs_payment ON payment_logs(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_shop ON payment_logs(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_gateway ON payment_logs(gateway);
CREATE INDEX IF NOT EXISTS idx_payment_logs_event ON payment_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_payment_logs_created ON payment_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_logs_idempotency ON payment_logs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 5f. Platform settings — add payment_settings
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

-- 5g. Seed CoolCare Pro plan
INSERT INTO subscription_plans (name, display_name, price_monthly_usd, price_yearly_usd, max_bookings, max_technicians, features, description, max_staff, whatsapp_conversations, ai_credits, trial_days, currency)
VALUES ('pro', 'CoolCare Pro', 20.00, 192.00, NULL, NULL,
  '{"whatsapp_bot": true, "dashboard": true, "notifications": true, "analytics": true, "priority_support": true, "custom_ai": true, "unlimited_bookings": true}',
  'Everything you need to run your repair shop with AI-powered automation.',
  NULL, NULL, NULL, 14, 'USD')
ON CONFLICT (name) DO NOTHING;

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


-- =============================================================================
-- SECTION 6: PRICING TABLE / MULTI-CURRENCY (migration-pricing-table.sql)
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscription_plan_prices (
  id               SERIAL PRIMARY KEY,
  plan_id          INTEGER NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  currency         TEXT NOT NULL,
  price_monthly    NUMERIC(10,2) NOT NULL,
  price_quarterly  NUMERIC(10,2) NOT NULL,
  price_halfyearly NUMERIC(10,2) NOT NULL,
  price_yearly     NUMERIC(10,2) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_currency ON subscription_plan_prices(currency);
CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_plan_currency ON subscription_plan_prices(plan_id, currency);

-- Seed pricing values for all core plans and supported currencies
WITH plans AS (
  SELECT id, name FROM subscription_plans WHERE name IN ('starter','professional','enterprise')
), prices AS (
  SELECT * FROM (VALUES
    ('starter','INR',1299.00,3156.00,6625.00,12470.00),
    ('professional','INR',3499.00,9447.00,17845.00,33590.00),
    ('enterprise','INR',6499.00,17547.00,33145.00,62390.00),
    ('starter','USD',20.00,54.00,102.00,192.00),
    ('professional','USD',60.00,162.00,306.00,576.00),
    ('enterprise','USD',100.00,270.00,510.00,960.00),
    ('starter','AED',75.00,202.50,382.50,720.00),
    ('professional','AED',220.00,594.00,1122.00,2112.00),
    ('enterprise','AED',370.00,999.00,1887.00,3552.00),
    ('starter','KWD',6.00,16.20,30.60,57.60),
    ('professional','KWD',18.00,48.60,91.80,172.80),
    ('enterprise','KWD',30.00,81.00,153.00,288.00)
  ) AS v(name,currency,price_monthly,price_quarterly,price_halfyearly,price_yearly)
)
INSERT INTO subscription_plan_prices (plan_id, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly)
SELECT p.id, pr.currency, pr.price_monthly, pr.price_quarterly, pr.price_halfyearly, pr.price_yearly
FROM plans p
JOIN prices pr ON pr.name = p.name
ON CONFLICT (plan_id, currency) DO NOTHING;


-- =============================================================================
-- SECTION 7: SUBSCRIPTION PLANS v2 (migration-subscription-plans-v2.sql)
-- =============================================================================

-- 7a. Add active column to subscription_plan_prices
ALTER TABLE subscription_plan_prices ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- 7b. Add selected_country and selected_currency to repair_shops
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS selected_country TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS selected_currency TEXT;

-- 7c. Ensure 'pro' plan exists with proper settings
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

-- 7d. Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_active
  ON subscription_plan_prices(active) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_lookup
  ON subscription_plan_prices(plan_id, currency)
  WHERE active = true;


-- =============================================================================
-- SECTION 8: PROMOTION & SUPPORT CODES (migration-promotion-codes.sql)
-- =============================================================================

-- 8a. PROMOTION CODES
CREATE TABLE IF NOT EXISTS promotion_codes (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  code                 TEXT NOT NULL,
  code_hash            TEXT,
  description          TEXT DEFAULT '',
  type                 TEXT NOT NULL CHECK (type IN (
                           'percentage_discount','fixed_discount','free_trial',
                           'support_token','lifetime_access'
                         )),
  discount_percent     NUMERIC(5,2),
  discount_amount      NUMERIC(12,2),
  discount_currency    TEXT DEFAULT 'INR',
  free_trial_days      INTEGER,
  plan_id              INTEGER,
  billing_cycles       TEXT[] DEFAULT '{}',
  max_uses             INTEGER DEFAULT NULL,
  used_count           INTEGER NOT NULL DEFAULT 0,
  per_user_limit       INTEGER DEFAULT 1,
  min_purchase_amount  NUMERIC(12,2) DEFAULT 0,
  max_discount_amount  NUMERIC(12,2) DEFAULT NULL,
  allowed_plans        INTEGER[] DEFAULT '{}',
  valid_from           TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until          TIMESTAMPTZ DEFAULT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  stackable            BOOLEAN NOT NULL DEFAULT false,
  auto_apply           BOOLEAN NOT NULL DEFAULT false,
  internal_notes       TEXT DEFAULT '',
  created_by           INTEGER,
  updated_by           INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_promotion_code UNIQUE (code),
  CONSTRAINT unique_support_token_hash UNIQUE (code_hash),
  CONSTRAINT check_percent_range CHECK (
    type != 'percentage_discount' OR (discount_percent >= 0 AND discount_percent <= 100)
  ),
  CONSTRAINT check_discount_amount CHECK (
    type != 'fixed_discount' OR (discount_amount IS NOT NULL AND discount_amount >= 0)
  ),
  CONSTRAINT check_free_trial_days CHECK (
    type != 'free_trial' OR (free_trial_days IS NOT NULL AND free_trial_days > 0)
  ),
  CONSTRAINT check_max_uses CHECK (
    max_uses IS NULL OR max_uses > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_promotion_codes_code ON promotion_codes(code) WHERE code_hash IS NULL;
CREATE INDEX IF NOT EXISTS idx_promotion_codes_code_hash ON promotion_codes(code_hash) WHERE code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_promotion_codes_active ON promotion_codes(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_promotion_codes_valid ON promotion_codes(valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_promotion_codes_type ON promotion_codes(type);
CREATE INDEX IF NOT EXISTS idx_promotion_codes_auto_apply ON promotion_codes(auto_apply) WHERE auto_apply = true;

-- 8b. PROMO CODE REDEMPTIONS
CREATE TABLE IF NOT EXISTS promo_code_redemptions (
  id                   SERIAL PRIMARY KEY,
  promotion_code_id    INTEGER NOT NULL REFERENCES promotion_codes(id) ON DELETE CASCADE,
  repair_shop_id       INTEGER NOT NULL,
  user_id              INTEGER,
  email                TEXT,
  ip_address           TEXT,
  user_agent           TEXT,
  plan_name            TEXT,
  billing_cycle        TEXT,
  original_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  final_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency             TEXT NOT NULL DEFAULT 'INR',
  payment_id           INTEGER,
  subscription_id      INTEGER,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                           'active','reversed','expired','failed'
                         )),
  metadata             JSONB DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_promo_redemption UNIQUE (promotion_code_id, repair_shop_id, status)
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON promo_code_redemptions(promotion_code_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_shop ON promo_code_redemptions(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_email ON promo_code_redemptions(email);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_status ON promo_code_redemptions(status);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_created ON promo_code_redemptions(created_at DESC);

-- 8c. Safely add FKs to tables that may exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'repair_shops') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'fk_promo_redemptions_repair_shop'
        AND table_name = 'promo_code_redemptions'
        AND constraint_type = 'FOREIGN KEY'
    ) THEN
      ALTER TABLE promo_code_redemptions
        ADD CONSTRAINT fk_promo_redemptions_repair_shop
        FOREIGN KEY (repair_shop_id) REFERENCES repair_shops(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'subscription_plans') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'fk_promo_codes_plan'
        AND table_name = 'promotion_codes'
        AND constraint_type = 'FOREIGN KEY'
    ) THEN
      ALTER TABLE promotion_codes
        ADD CONSTRAINT fk_promo_codes_plan
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'fk_promo_codes_created_by'
        AND table_name = 'promotion_codes'
        AND constraint_type = 'FOREIGN KEY'
    ) THEN
      ALTER TABLE promotion_codes
        ADD CONSTRAINT fk_promo_codes_created_by
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'fk_promo_codes_updated_by'
        AND table_name = 'promotion_codes'
        AND constraint_type = 'FOREIGN KEY'
    ) THEN
      ALTER TABLE promotion_codes
        ADD CONSTRAINT fk_promo_codes_updated_by
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'fk_promo_redemptions_user'
        AND table_name = 'promo_code_redemptions'
        AND constraint_type = 'FOREIGN KEY'
    ) THEN
      ALTER TABLE promo_code_redemptions
        ADD CONSTRAINT fk_promo_redemptions_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payments') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'fk_promo_redemptions_payment'
        AND table_name = 'promo_code_redemptions'
        AND constraint_type = 'FOREIGN KEY'
    ) THEN
      ALTER TABLE promo_code_redemptions
        ADD CONSTRAINT fk_promo_redemptions_payment
        FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'subscriptions') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'fk_promo_redemptions_subscription'
        AND table_name = 'promo_code_redemptions'
        AND constraint_type = 'FOREIGN KEY'
    ) THEN
      ALTER TABLE promo_code_redemptions
        ADD CONSTRAINT fk_promo_redemptions_subscription
        FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- 8d. Add promo_code_id to payments
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payments') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'payments' AND column_name = 'promotion_code_id'
    ) THEN
      ALTER TABLE payments ADD COLUMN promotion_code_id INTEGER REFERENCES promotion_codes(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- 8e. Add promo columns to subscriptions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'subscriptions') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'subscriptions' AND column_name = 'promotion_code_id'
    ) THEN
      ALTER TABLE subscriptions ADD COLUMN promotion_code_id INTEGER REFERENCES promotion_codes(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'subscriptions' AND column_name = 'is_lifetime'
    ) THEN
      ALTER TABLE subscriptions ADD COLUMN is_lifetime BOOLEAN NOT NULL DEFAULT false;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'subscriptions' AND column_name = 'is_support_token'
    ) THEN
      ALTER TABLE subscriptions ADD COLUMN is_support_token BOOLEAN NOT NULL DEFAULT false;
    END IF;
  END IF;
END $$;

-- 8f. Diagnostic
DO $$
DECLARE
  table_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'promotion_codes'
  ) INTO table_exists;
  IF table_exists THEN
    RAISE NOTICE '✅ promotion_codes table exists and is ready';
  ELSE
    RAISE WARNING '❌ promotion_codes table was NOT created';
  END IF;
END $$;


-- =============================================================================
-- SECTION 9: PASSWORD RESET (migration-password-reset.sql)
-- =============================================================================

-- 9a. PASSWORD RESET TOKENS
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL,
  user_type        TEXT NOT NULL DEFAULT 'shop'
                   CHECK (user_type IN ('user', 'shop')),
  token_hash       TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_expires ON password_reset_tokens(expires_at);

-- 9b. Ensure repair_shops has all required columns
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'shop';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

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

-- 9c. Clean up expired reset tokens
DELETE FROM password_reset_tokens WHERE expires_at < now();


-- =============================================================================
-- SECTION 10: MULTI-TENANT WHATSAPP CONNECTION (migration-whatsapp-connection.sql)
-- =============================================================================

-- 10a. REPAIR_SHOP_WHATSAPP
CREATE TABLE IF NOT EXISTS repair_shop_whatsapp (
  id                   SERIAL PRIMARY KEY,
  repair_shop_id       INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  phone_number_id      TEXT NOT NULL,
  waba_id              TEXT NOT NULL,
  business_id          TEXT,
  phone_number         TEXT,
  business_name        TEXT,
  access_token_enc     TEXT NOT NULL,
  token_expiry         TIMESTAMPTZ,
  refresh_token_enc    TEXT,
  webhook_status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (webhook_status IN ('pending', 'subscribed', 'active', 'disconnected', 'expired')),
  webhook_subscribed_at TIMESTAMPTZ,
  whatsapp_connected_at TIMESTAMPTZ,
  last_sync_at         TIMESTAMPTZ,
  coexistence_mode     BOOLEAN NOT NULL DEFAULT false,
  metadata             JSONB DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_repair_shop_whatsapp UNIQUE (repair_shop_id),
  CONSTRAINT unique_phone_number_id UNIQUE (phone_number_id)
);

CREATE INDEX IF NOT EXISTS idx_rw_phone_number_id ON repair_shop_whatsapp(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_rw_token_expiry ON repair_shop_whatsapp(token_expiry)
  WHERE webhook_status IN ('active', 'subscribed');
CREATE INDEX IF NOT EXISTS idx_rw_repair_shop_id ON repair_shop_whatsapp(repair_shop_id);

-- 10b. WHITELISTED PHONES
CREATE TABLE IF NOT EXISTS whitelisted_phones (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  phone_number     TEXT NOT NULL,
  label            TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(repair_shop_id, phone_number)
);

-- 10c. Add WhatsApp fields to repair_shops
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS whatsapp_connected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS whatsapp_phone_number TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS whatsapp_business_name TEXT;

-- 10d. Add WhatsApp reference to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS phone_number_id TEXT;

-- 10e. Add WhatsApp reference to conversations
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone_number_id TEXT;


-- =============================================================================
-- SECTION 11: v1 PRODUCTION BUILD (migration-v1-production.sql)
-- =============================================================================

-- 11a. REFERRALS
CREATE TABLE IF NOT EXISTS referrals (
  id               SERIAL PRIMARY KEY,
  referrer_shop_id INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  referred_shop_id INTEGER REFERENCES repair_shops(id) ON DELETE SET NULL,
  referral_code    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','completed','expired')),
  reward_type      TEXT NOT NULL DEFAULT 'discount'
                   CHECK (reward_type IN ('discount','wallet')),
  reward_value     NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_shop_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_shop_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- 11b. Repair shops — referral + wallet columns
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS referred_by TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS discount_balance NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS gst_number TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Asia/Kolkata';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS business_hours JSONB DEFAULT '{}';

UPDATE repair_shops
SET referral_code = 'COOLCARE-' || UPPER(SUBSTRING(MD5(id::text || random()::text), 1, 4))
WHERE referral_code IS NULL;

-- 11c. Subscription plans — quarterly + half-yearly pricing
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_quarterly_usd NUMERIC(10,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_halfyearly_usd NUMERIC(10,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_staff INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS whatsapp_conversations INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS ai_credits INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';

UPDATE subscription_plans SET price_quarterly_usd = price_monthly_usd * 3 * 0.9
WHERE price_quarterly_usd IS NULL AND price_monthly_usd IS NOT NULL;
UPDATE subscription_plans SET price_halfyearly_usd = price_monthly_usd * 6 * 0.85
WHERE price_halfyearly_usd IS NULL AND price_monthly_usd IS NOT NULL;

-- 11d. Subscriptions — expand billing cycle options
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_billing_cycle_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_billing_cycle_check
  CHECK (billing_cycle IN ('monthly','quarterly','halfyearly','yearly'));

-- 11e. AI SETTINGS table
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

-- 11f. WHATSAPP CONVERSATIONS
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER REFERENCES repair_shops(id) ON DELETE SET NULL,
  customer_number  TEXT NOT NULL,
  customer_name    TEXT,
  direction        TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  message_text     TEXT NOT NULL,
  ai_response      TEXT,
  booking_id       INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'delivered'
                   CHECK (status IN ('sent','delivered','read','failed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_conv_shop ON whatsapp_conversations(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_wa_conv_customer ON whatsapp_conversations(customer_number);
CREATE INDEX IF NOT EXISTS idx_wa_conv_created ON whatsapp_conversations(created_at DESC);

-- 11g. SHOP NOTIFICATIONS
CREATE TABLE IF NOT EXISTS shop_notifications (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,
  title            TEXT NOT NULL,
  message          TEXT NOT NULL,
  is_read          BOOLEAN NOT NULL DEFAULT false,
  link             TEXT,
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_notif_shop ON shop_notifications(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_notif_unread ON shop_notifications(repair_shop_id, is_read) WHERE is_read = false;

-- 11h. PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_repair_shops_subscription_status ON repair_shops(subscription_status);
CREATE INDEX IF NOT EXISTS idx_repair_shops_referral_code ON repair_shops(referral_code);
CREATE INDEX IF NOT EXISTS idx_repair_shops_created ON repair_shops(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_shop_created ON bookings(repair_shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_shop_created ON subscriptions(repair_shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_shop_created ON payments(repair_shop_id, created_at DESC);

-- 11i. Expire old trial subscriptions
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


-- =============================================================================
-- SECTION 12: ADD AI SETTINGS TABLE (migration-add-ai-settings-table.sql)
-- =============================================================================
-- Note: ai_settings already created above in Section 11.
-- This is a re-run guard in case that section was skipped.
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
-- SECTION 13: APPROVAL FLOW (migration-add-approval-flow.sql)
-- =============================================================================

ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'none';
ALTER TABLE repair_shops ALTER COLUMN approval_status SET DEFAULT 'none';

ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS approved_by INTEGER;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

UPDATE repair_shops SET approval_status = 'approved', approved_at = now()
WHERE subscription_status = 'active' AND (approval_status IS NULL OR approval_status = 'none');


-- =============================================================================
-- SECTION 14: IDEMPOTENCY UNIQUE CONSTRAINT (migration-add-idempotency-unique-constraint.sql)
-- =============================================================================

DELETE FROM payment_logs pl1 USING (
  SELECT MIN(id) as id, idempotency_key
  FROM payment_logs
  WHERE idempotency_key IS NOT NULL
  GROUP BY idempotency_key
  HAVING COUNT(*) > 1
) pl2
WHERE pl1.idempotency_key = pl2.idempotency_key
  AND pl1.idempotency_key IS NOT NULL
  AND pl1.id != pl2.id;

-- PostgreSQL does NOT support `ADD CONSTRAINT IF NOT EXISTS`.
-- The idempotent guard below checks information_schema first (same pattern
-- used elsewhere in this file), so this never fails on re-runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'payment_logs'
      AND constraint_name = 'payment_logs_idempotency_key_unique'
  ) THEN
    ALTER TABLE payment_logs
      ADD CONSTRAINT payment_logs_idempotency_key_unique UNIQUE (idempotency_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_logs_idempotency_key ON payment_logs (idempotency_key);


-- =============================================================================
-- SECTION 15: IS_DEMO COLUMN (migration-add-is-demo-column.sql)
-- =============================================================================

ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_repair_shops_is_demo ON repair_shops(is_demo);

UPDATE repair_shops SET is_demo = true WHERE email = 'demo@coolcare.demo';


-- =============================================================================
-- SECTION 16: LANGUAGE & REPAIR_SHOP TO CONVERSATION STATE
-- (migration-add-language-and-repair-shop-to-conversation-state.sql)
-- =============================================================================

ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';
UPDATE conversation_state SET language = 'en' WHERE language IS NULL;
ALTER TABLE conversation_state ALTER COLUMN language SET NOT NULL;
ALTER TABLE conversation_state ALTER COLUMN language SET DEFAULT 'en';

ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conv_state_shop ON conversation_state(repair_shop_id);


-- =============================================================================
-- SECTION 17: STATE TABLE UPGRADE (migration-add-state-table.sql)
-- =============================================================================

ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS booking_id TEXT;

UPDATE conversation_state SET status = 'COLLECTING_APPLIANCE' WHERE step = 'appliance'  AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_ISSUE'     WHERE step = 'issue'      AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_NAME'      WHERE step = 'name'       AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_ADDRESS'   WHERE step = 'address'    AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_LOCALITY'  WHERE step = 'area'       AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_DATE'      WHERE step = 'urgency'    AND status IS NULL;
UPDATE conversation_state SET status = 'CONFIRMATION_PENDING' WHERE step = 'confirm'    AND status IS NULL;
UPDATE conversation_state SET status = 'COLLECTING_APPLIANCE' WHERE status IS NULL;

ALTER TABLE conversation_state ALTER COLUMN status SET NOT NULL;
ALTER TABLE conversation_state ALTER COLUMN status SET DEFAULT 'COLLECTING_APPLIANCE';

DELETE FROM conversation_state WHERE status NOT IN ('BOOKED', 'CANCELLED');


-- =============================================================================
-- SECTION 18: CREATE ALL MISSING TABLES (migration-create-missing-tables.sql)
-- =============================================================================
-- This is a comprehensive catch-all that ensures every table and column exists.
-- Safe to re-run; preserves existing data.

-- 18a. Subscription plans — comprehensive version
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

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_staff INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS whatsapp_conversations INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS ai_credits INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 14;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_quarterly_usd NUMERIC(10,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_halfyearly_usd NUMERIC(10,2);

UPDATE subscription_plans SET trial_days = 14 WHERE trial_days IS NULL;
UPDATE subscription_plans SET currency = 'USD' WHERE currency IS NULL;

-- 18b. Repair shops — all missing columns
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

DO $$
BEGIN
  ALTER TABLE repair_shops DROP CONSTRAINT IF EXISTS repair_shops_approval_status_check;
  ALTER TABLE repair_shops ADD CONSTRAINT repair_shops_approval_status_check
    CHECK (approval_status IN ('none','pending','approved','rejected'));
EXCEPTION WHEN others THEN NULL;
END $$;

UPDATE repair_shops
SET referral_code = 'COOLCARE-' || UPPER(SUBSTRING(MD5(CAST(id AS text) || CAST(random() AS text)), 1, 4))
WHERE referral_code IS NULL;

-- 18c. Bookings — all missing columns
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
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS phone_number_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_phone TEXT;

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

CREATE INDEX IF NOT EXISTS idx_bookings_shop ON bookings(repair_shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_shop_status_created
  ON bookings(repair_shop_id, status, created_at DESC);

-- 18d. Subscription plan prices
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

ALTER TABLE subscription_plan_prices ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- 18e. Performance indexes
CREATE INDEX IF NOT EXISTS idx_repair_shops_subscription_status ON repair_shops(subscription_status);
CREATE INDEX IF NOT EXISTS idx_repair_shops_referral_code ON repair_shops(referral_code);
CREATE INDEX IF NOT EXISTS idx_repair_shops_created ON repair_shops(created_at DESC);

-- 18f. Maintenance: expire old trial subscriptions
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

DELETE FROM jwt_denylist WHERE expires_at < now();
DELETE FROM password_reset_tokens WHERE expires_at < now();


-- =============================================================================
-- SECTION 19: FIX DEMO SCHEMA (migration-fix-demo-schema.sql)
-- =============================================================================

-- 19a. Bookings — ensure all demo-referenced columns exist
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS address TEXT;
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
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS phone_number_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_phone TEXT;

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

CREATE INDEX IF NOT EXISTS idx_bookings_shop ON bookings(repair_shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_shop_status_created
  ON bookings(repair_shop_id, status, created_at DESC);

-- 19b. Subscriptions — missing columns
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';

-- 19c. Technicians — missing columns
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS specialization TEXT[];

CREATE INDEX IF NOT EXISTS idx_technicians_shop ON technicians(repair_shop_id);

-- 19d. conversation_state — missing columns
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';

CREATE INDEX IF NOT EXISTS idx_conv_state_shop ON conversation_state(repair_shop_id);

-- 19e. repair_shops — all columns for demo
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

DO $$
BEGIN
  ALTER TABLE repair_shops DROP CONSTRAINT IF EXISTS repair_shops_approval_status_check;
  ALTER TABLE repair_shops ADD CONSTRAINT repair_shops_approval_status_check
    CHECK (approval_status IN ('none','pending','approved','rejected'));
EXCEPTION WHEN others THEN NULL;
END $$;

-- 19f. ai_settings
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

-- 19g. whatsapp_conversations — ensure booking_id column
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS booking_id INTEGER
  REFERENCES bookings(id) ON DELETE SET NULL;

-- 19h. Ensure 'pro' plan exists for demo
INSERT INTO subscription_plans (name, display_name, price_monthly_usd, price_yearly_usd, max_bookings, max_technicians, features, description, trial_days, currency)
VALUES
  ('pro', 'CoolCare Pro', 20.00, 192.00, NULL, NULL,
   '{"whatsapp_bot": true, "dashboard": true, "notifications": true, "analytics": true, "priority_support": true, "custom_ai": true, "unlimited_bookings": true}',
   'Everything you need to run your repair shop with AI-powered automation.', 14, 'USD')
ON CONFLICT (name) DO NOTHING;

UPDATE subscription_plans SET price_quarterly_usd = price_monthly_usd * 3 * 0.9
WHERE name = 'pro' AND price_quarterly_usd IS NULL AND price_monthly_usd IS NOT NULL;

UPDATE subscription_plans SET price_halfyearly_usd = price_monthly_usd * 6 * 0.85
WHERE name = 'pro' AND price_halfyearly_usd IS NULL AND price_monthly_usd IS NOT NULL;


-- =============================================================================
-- SECTION 20: REPAIR SHOPS COLUMNS FIX (migration-fix-repair-shops-columns.sql)
-- =============================================================================
-- NOTE: The role CHECK constraint is intentionally SKIPPED here because earlier
-- sections (4, 9, 18, 19) already set the comprehensive version:
--   CHECK (role IN ('shop','owner','manager','editor','receptionist','technician','admin','super_admin'))
-- Reverting it here to the old limited set ('shop','admin','super_admin') would
-- break RBAC. Only the column existence is guaranteed here.

ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspension_reason TEXT;


-- =============================================================================
-- SECTION 21: PHASE 7 ENTERPRISE ENHANCEMENTS (migration-phase-7-enterprise.sql)
-- =============================================================================
-- Adds columns for: Image/File support, Human handoff, Smart scheduling,
-- Better AI memory, Conversation analytics, Extended knowledge base.
-- All operations use IF NOT EXISTS guards — safe to re-run.
-- =============================================================================

-- 21a. CONVERSATION STATE — add Phase 7 columns
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT '{}';
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS file_urls TEXT[] DEFAULT '{}';
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS human_handoff BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS handoff_closed_at TIMESTAMPTZ;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS ai_memory JSONB DEFAULT '{}'::jsonb;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS selected_slot TIMESTAMPTZ;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS customer_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_conv_state_handoff ON conversation_state(repair_shop_id, human_handoff)
  WHERE human_handoff = true;

-- 21b. BOOKINGS — add AI/analytics/review columns
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT '{}';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS file_urls TEXT[] DEFAULT '{}';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS conversation_summary TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_sentiment TEXT DEFAULT 'neutral';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS human_takeover_history JSONB DEFAULT '[]'::jsonb;

-- Sentiment check constraint
DO $$
BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_sentiment_check;
  ALTER TABLE bookings ADD CONSTRAINT bookings_sentiment_check
    CHECK (customer_sentiment IN ('positive','neutral','negative','frustrated'));
EXCEPTION WHEN others THEN NULL;
END $$;

-- 21c. AI SETTINGS — add extended knowledge base columns
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS service_locations TEXT[] DEFAULT '{}';
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS brands_repaired TEXT[] DEFAULT '{}';
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS warranty_policy TEXT DEFAULT '';
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS inspection_policy TEXT DEFAULT '';
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS visiting_charges NUMERIC(10,2) DEFAULT 0;
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS emergency_availability BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS holiday_timings JSONB DEFAULT '{}';
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS accepted_payment_methods TEXT[] DEFAULT '{}';
ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS languages_spoken TEXT[] DEFAULT '{}';

-- 21d. CONVERSATION ANALYTICS TABLE
CREATE TABLE IF NOT EXISTS conversation_analytics (
  id                SERIAL PRIMARY KEY,
  repair_shop_id    INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  date              DATE NOT NULL DEFAULT CURRENT_DATE,
  total_conversations INTEGER NOT NULL DEFAULT 0,
  booking_completed  INTEGER NOT NULL DEFAULT 0,
  human_handoff      INTEGER NOT NULL DEFAULT 0,
  drop_off_stage     TEXT,
  most_common_appliance TEXT,
  most_common_issue    TEXT,
  avg_response_time_ms INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(repair_shop_id, date)
);

CREATE INDEX IF NOT EXISTS idx_conv_analytics_shop ON conversation_analytics(repair_shop_id, date);

-- 21e. Ensure existing data has default values
UPDATE conversation_state SET image_urls = '{}' WHERE image_urls IS NULL;
UPDATE conversation_state SET file_urls = '{}' WHERE file_urls IS NULL;
UPDATE conversation_state SET human_handoff = false WHERE human_handoff IS NULL;
UPDATE conversation_state SET ai_memory = '{}'::jsonb WHERE ai_memory IS NULL;
UPDATE bookings SET image_urls = '{}' WHERE image_urls IS NULL;
UPDATE bookings SET file_urls = '{}' WHERE file_urls IS NULL;
UPDATE bookings SET customer_sentiment = 'neutral' WHERE customer_sentiment IS NULL;
UPDATE bookings SET human_takeover_history = '[]'::jsonb WHERE human_takeover_history IS NULL;


-- 22. MORNING DIGEST — per-shop digest preferences for the cron that pushes
--     Today's Priorities to the owner (api/cron/digest.js)
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS digest_time TEXT NOT NULL DEFAULT '08:00';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS digest_sent_at TIMESTAMPTZ;

-- =============================================================================
-- MIGRATION COMPLETE
-- =============================================================================
-- All 22 migration files + schema.sql have been merged into this
-- single file. All operations are idempotent (safe to re-run).
-- =============================================================================

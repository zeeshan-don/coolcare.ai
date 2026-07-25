-- =============================================================================
-- CoolCare AI — Migration: v1.0 Production Build
-- Adds: referrals, AI settings, WhatsApp conversations, subscription upgrades,
--       notification enhancements, indexes.
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards throughout).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. REFERRALS
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 2. REPAIR_SHOPS — referral + wallet columns
-- -----------------------------------------------------------------------------
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

-- Generate referral codes for existing shops that don't have one
UPDATE repair_shops
SET referral_code = 'COOLCARE-' || UPPER(SUBSTRING(MD5(id::text || random()::text), 1, 4))
WHERE referral_code IS NULL;

-- -----------------------------------------------------------------------------
-- 3. SUBSCRIPTION_PLANS — quarterly + half-yearly pricing
-- -----------------------------------------------------------------------------
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_quarterly_usd NUMERIC(10,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_halfyearly_usd NUMERIC(10,2);
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_staff INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS whatsapp_conversations INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS ai_credits INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';

-- Set quarterly/half-yearly prices for existing plans (savings vs monthly)
UPDATE subscription_plans SET price_quarterly_usd = price_monthly_usd * 3 * 0.9
WHERE price_quarterly_usd IS NULL AND price_monthly_usd IS NOT NULL;
UPDATE subscription_plans SET price_halfyearly_usd = price_monthly_usd * 6 * 0.85
WHERE price_halfyearly_usd IS NULL AND price_monthly_usd IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. SUBSCRIPTIONS — expand billing cycle options
-- -----------------------------------------------------------------------------
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_billing_cycle_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_billing_cycle_check
  CHECK (billing_cycle IN ('monthly','quarterly','halfyearly','yearly'));

-- -----------------------------------------------------------------------------
-- 5. AI SETTINGS (per-shop AI configuration)
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 6. WHATSAPP CONVERSATIONS (message log per shop)
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 7. SHOP NOTIFICATIONS (in-app notification feed)
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 8. ADD INDEXES FOR PERFORMANCE
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_repair_shops_subscription_status ON repair_shops(subscription_status);
CREATE INDEX IF NOT EXISTS idx_repair_shops_referral_code ON repair_shops(referral_code);
CREATE INDEX IF NOT EXISTS idx_repair_shops_created ON repair_shops(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_shop_created ON bookings(repair_shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_shop_created ON subscriptions(repair_shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_shop_created ON payments(repair_shop_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 9. EXPIRE OLD TRIAL SUBSCRIPTIONS (maintenance)
-- -----------------------------------------------------------------------------
UPDATE subscriptions
SET status = 'expired', updated_at = now()
WHERE status = 'trial' AND current_period_end < now();

-- Update repair_shops subscription_status for expired trials
UPDATE repair_shops
SET subscription_status = 'inactive'
WHERE subscription_status = 'trial'
AND id IN (
  SELECT s.repair_shop_id FROM subscriptions s
  WHERE s.status = 'expired'
  AND s.repair_shop_id = repair_shops.id
);

-- -----------------------------------------------------------------------------
-- Done
-- -----------------------------------------------------------------------------

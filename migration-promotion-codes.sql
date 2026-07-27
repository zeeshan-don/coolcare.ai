-- CoolCare AI — Migration: Promotion & Support Code Management System
-- Adds: promotion_codes, promo_code_redemptions
-- Supports: Percentage Discount, Fixed Amount Discount, Free Trial,
--           Support Token, Lifetime Access
-- Security: support tokens stored hashed, idempotency via UNIQUE constraint
--           on (code_type, code_hash) for support tokens
--
-- SAFE TO RE-RUN: All operations use IF NOT EXISTS / IF EXISTS guards.
-- SELF-CONTAINED: Creates promotion_codes WITHOUT inline FK dependencies.
--   FKs to subscription_plans, users, payments, subscriptions are added
--   separately via ALTER TABLE inside safety-wrapped DO blocks.
--   This prevents the ENTIRE migration from rolling back when those
--   dependent tables don't exist yet (common when migration order is
--   undefined across 19+ migration files).

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. PROMOTION CODES
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS promotion_codes (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,                    -- Internal name/label
  code                 TEXT NOT NULL,                    -- The actual promo code (uppercase)
  code_hash            TEXT,                             -- SHA-256 hash (for support tokens only)
  description          TEXT DEFAULT '',
  type                 TEXT NOT NULL CHECK (type IN (
                           'percentage_discount',
                           'fixed_discount',
                           'free_trial',
                           'support_token',
                           'lifetime_access'
                         )),
  discount_percent     NUMERIC(5,2),                     -- For percentage_discount (0-100)
  discount_amount      NUMERIC(12,2),                    -- For fixed_discount
  discount_currency    TEXT DEFAULT 'INR',               -- Currency for fixed discount
  free_trial_days      INTEGER,                          -- For free_trial

  -- NOTE: plan_id FK is added via ALTER TABLE below (Section 5) to avoid
  -- dependency on subscription_plans table which may not exist yet.
  plan_id              INTEGER,

  billing_cycles       TEXT[] DEFAULT '{}',               -- Which billing cycles apply: monthly, quarterly, halfyearly, yearly
                                                          -- Empty array = all billing cycles

  -- Support token fields
  max_uses             INTEGER DEFAULT NULL,              -- NULL = unlimited
  used_count           INTEGER NOT NULL DEFAULT 0,
  per_user_limit       INTEGER DEFAULT 1,                 -- How many times one user can redeem (default 1)
                                                          -- NULL = unlimited per user

  -- Advanced options
  min_purchase_amount  NUMERIC(12,2) DEFAULT 0,           -- Minimum cart value for discount (0 = no minimum)
  max_discount_amount  NUMERIC(12,2) DEFAULT NULL,        -- Cap on discount amount (NULL = no cap)

  -- Eligibility & timing
  allowed_plans        INTEGER[] DEFAULT '{}',             -- Specific plan IDs allowed (empty = all)
  valid_from           TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until          TIMESTAMPTZ DEFAULT NULL,           -- NULL = never expires
  is_active            BOOLEAN NOT NULL DEFAULT true,

  -- Stacking & automation
  stackable            BOOLEAN NOT NULL DEFAULT false,     -- Can be combined with other codes
  auto_apply           BOOLEAN NOT NULL DEFAULT false,     -- Auto-apply to eligible checkouts

  -- Internal
  internal_notes       TEXT DEFAULT '',

  -- NOTE: created_by and updated_by FKs are added via ALTER TABLE below (Section 5)
  created_by           INTEGER,
  updated_by           INTEGER,

  -- Timestamps
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Uniqueness: support tokens use code_hash, others use plain code
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

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_promotion_codes_code ON promotion_codes(code) WHERE code_hash IS NULL;
CREATE INDEX IF NOT EXISTS idx_promotion_codes_code_hash ON promotion_codes(code_hash) WHERE code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_promotion_codes_active ON promotion_codes(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_promotion_codes_valid ON promotion_codes(valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_promotion_codes_type ON promotion_codes(type);
CREATE INDEX IF NOT EXISTS idx_promotion_codes_auto_apply ON promotion_codes(auto_apply) WHERE auto_apply = true;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. PROMO CODE REDEMPTIONS (audit trail)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS promo_code_redemptions (
  id                   SERIAL PRIMARY KEY,
  promotion_code_id    INTEGER NOT NULL REFERENCES promotion_codes(id) ON DELETE CASCADE,
  repair_shop_id       INTEGER NOT NULL,

  -- NOTE: user_id FK is added via ALTER TABLE below (Section 5)
  user_id              INTEGER,

  email                TEXT,                              -- Customer/owner email at time of redemption
  ip_address           TEXT,                              -- Redeemer's IP address
  user_agent           TEXT,                              -- Browser user agent

  -- Context at redemption time
  plan_name            TEXT,
  billing_cycle        TEXT,                              -- monthly, quarterly, halfyearly, yearly
  original_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,  -- Price before discount
  discount_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,  -- Actual discount applied
  final_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,  -- Price after discount
  currency             TEXT NOT NULL DEFAULT 'INR',

  -- Reference to payment/subscription (FKs added via ALTER TABLE below)
  payment_id           INTEGER,
  subscription_id      INTEGER,

  -- Status tracking
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                           'active',     -- Successfully applied
                           'reversed',   -- Payment was refunded
                           'expired',    -- Code expired before use
                           'failed'      -- Validation failed at redemption
                         )),

  -- Metadata for debugging
  metadata             JSONB DEFAULT '{}',

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prevent duplicate redemption (same code + same shop)
  CONSTRAINT unique_promo_redemption UNIQUE (promotion_code_id, repair_shop_id, status)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON promo_code_redemptions(promotion_code_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_shop ON promo_code_redemptions(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_email ON promo_code_redemptions(email);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_status ON promo_code_redemptions(status);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_created ON promo_code_redemptions(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. SAFELY ADD FK TO repair_shops (if repair_shops table exists)
-- ═══════════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. ADD FKs TO TABLES THAT MAY EXIST (safe to skip)
--    Uses DO blocks with IF EXISTS checks so the migration never fails
--    even if dependent tables haven't been created yet.
-- ═══════════════════════════════════════════════════════════════════════════════

-- plan_id → subscription_plans
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

-- created_by → users
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
  END IF;
END $$;

-- updated_by → users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'promotion_codes'
        AND constraint_name = 'fk_promo_codes_updated_by'
        AND constraint_type = 'FOREIGN KEY'
    ) THEN
      ALTER TABLE promotion_codes
        ADD CONSTRAINT fk_promo_codes_updated_by
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- user_id in promo_code_redemptions → users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
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

-- payment_id in promo_code_redemptions → payments
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

-- subscription_id in promo_code_redemptions → subscriptions
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. ADD promo_code_id to payments table (optional FK for tracking)
--    Safe — only adds if both payments table AND the column don't exist yet
-- ═══════════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. ADD promo code columns to subscriptions table (track how subscription started)
--    Safe — only adds if subscriptions table exists
-- ═══════════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. DIAGNOSTIC: Log table creation result to PostgreSQL logs
-- ═══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  table_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'promotion_codes'
  ) INTO table_exists;

  IF table_exists THEN
    RAISE NOTICE '✅ migration-promotion-codes: promotion_codes table exists and is ready';
  ELSE
    RAISE WARNING '❌ migration-promotion-codes: promotion_codes table was NOT created — investigate!';
  END IF;
END $$;

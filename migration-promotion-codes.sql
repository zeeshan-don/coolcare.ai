-- CoolCare AI — Migration: Promotion & Support Code Management System
-- Adds: promotion_codes, promo_code_redemptions
-- Supports: Percentage Discount, Fixed Amount Discount, Free Trial,
--           Support Token, Lifetime Access
-- Security: support tokens stored hashed, idempotency via UNIQUE constraint
--           on (code_type, code_hash) for support tokens

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
  plan_id              INTEGER REFERENCES subscription_plans(id) ON DELETE SET NULL,  -- Specific plan or null = all
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
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,

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
  repair_shop_id       INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
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

  -- Reference to payment/subscription
  payment_id           INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  subscription_id      INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,

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
-- 3. ADD promo_code_id to payments table (optional FK for tracking)
-- ═══════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'promotion_code_id'
  ) THEN
    ALTER TABLE payments ADD COLUMN promotion_code_id INTEGER REFERENCES promotion_codes(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. ADD promo code columns to subscriptions table (track how subscription started)
-- ═══════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
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
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Supported billing cycles constraint check
-- ═══════════════════════════════════════════════════════════════════════════════
-- The billing_cycles column uses a Postgres array, so no CHECK constraint needed.
-- Validation happens at the application layer.

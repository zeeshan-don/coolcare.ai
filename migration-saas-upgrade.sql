-- =============================================================================
-- CoolCare — Migration: Production SaaS Upgrade
-- Phases: Multi-tenancy, Booking upgrades, Payments, Subscriptions, Admin
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards throughout).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. SUBSCRIPTION PLANS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_plans (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,          -- starter, professional, enterprise
  display_name     TEXT NOT NULL,
  price_monthly_usd NUMERIC(10,2) NOT NULL,
  price_yearly_usd  NUMERIC(10,2) NOT NULL,
  max_bookings     INTEGER,                        -- NULL = unlimited
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

-- -----------------------------------------------------------------------------
-- 2. SUBSCRIPTIONS (active subscription per shop)
-- -----------------------------------------------------------------------------
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
  gateway          TEXT,                           -- stripe, razorpay, tap, myfatoorah
  gateway_sub_id   TEXT,                           -- external subscription ID
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_shop ON subscriptions(repair_shop_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- -----------------------------------------------------------------------------
-- 3. PAYMENTS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  subscription_id  INTEGER REFERENCES subscriptions(id),
  payment_id       TEXT UNIQUE,                    -- gateway payment ID
  transaction_id   TEXT,                           -- gateway transaction ID
  gateway          TEXT NOT NULL,                  -- stripe, razorpay, tap, myfatoorah
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

-- -----------------------------------------------------------------------------
-- 4. COUPON CODES
-- -----------------------------------------------------------------------------
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
  applicable_plans TEXT[],                         -- NULL = all plans
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 5. BOOKING UPGRADES (Phase 5)
-- -----------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'
  CHECK (priority IN ('low','normal','high','urgent'));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reschedule_date TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS estimated_arrival TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS photo_urls TEXT[];
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_number TEXT;

-- Composite index for tenant-scoped filtered queries (Phase 4)
CREATE INDEX IF NOT EXISTS idx_bookings_shop_status_created
  ON bookings(repair_shop_id, status, created_at DESC);

-- -----------------------------------------------------------------------------
-- 6. BOOKING TIMELINE (audit trail)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_timeline (
  id               SERIAL PRIMARY KEY,
  booking_id       INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action           TEXT NOT NULL,                  -- status_change, note_added, assigned, etc.
  old_value        TEXT,
  new_value        TEXT,
  actor_type       TEXT NOT NULL DEFAULT 'system'
                   CHECK (actor_type IN ('system','shop','customer','technician')),
  actor_id         INTEGER,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_booking ON booking_timeline(booking_id, created_at);

-- -----------------------------------------------------------------------------
-- 7. TECHNICIANS — ADD TENANT SCOPING (Phase 3)
-- -----------------------------------------------------------------------------
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS specialization TEXT[];

CREATE INDEX IF NOT EXISTS idx_technicians_shop ON technicians(repair_shop_id);

-- -----------------------------------------------------------------------------
-- 8. CONVERSATION STATE — ADD TENANT SCOPING
-- -----------------------------------------------------------------------------
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';

CREATE INDEX IF NOT EXISTS idx_conv_state_shop ON conversation_state(repair_shop_id);

-- -----------------------------------------------------------------------------
-- 9. SUPER ADMIN
-- -----------------------------------------------------------------------------
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'shop'
  CHECK (role IN ('shop','admin','super_admin'));
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

-- Create super admin account if ADMIN_EMAIL is set (handled in code)
-- INSERT INTO repair_shops ... ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 10. NOTIFICATION LOG
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 11. JWT DENYLIST CLEANUP (auto-clean expired tokens)
-- -----------------------------------------------------------------------------
DELETE FROM jwt_denylist WHERE expires_at < now();

-- -----------------------------------------------------------------------------
-- Done
-- -----------------------------------------------------------------------------

-- =============================================================================
-- CoolCare — Migration: Role-Based Access Control (RBAC)
-- Adds users table, platform_settings, and expands role constraints.
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards throughout).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. USERS TABLE — platform staff + shop employees
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 2. EXPAND repair_shops.role CHECK CONSTRAINT
--    Old: ('shop','admin','super_admin')
--    New: ('shop','owner','manager','editor','receptionist','technician','admin','super_admin')
-- -----------------------------------------------------------------------------
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

-- Backfill: any existing repair_shops with role='shop' keep it (backward compat)
-- New signups will get role='owner'

-- -----------------------------------------------------------------------------
-- 3. PLATFORM SETTINGS (key-value store for admin config)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
  key              TEXT PRIMARY KEY,
  value            JSONB NOT NULL DEFAULT '{}',
  updated_by       INTEGER,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
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
  ('default_currency',    '{"value": "USD"}')
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. EXPAND subscription_plans with additional fields for plan management
-- -----------------------------------------------------------------------------
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_staff INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS whatsapp_conversations INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS ai_credits INTEGER;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 14;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';

-- -----------------------------------------------------------------------------
-- 5. ADMIN ACTION LOG (audit trail for admin operations)
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- Done
-- -----------------------------------------------------------------------------

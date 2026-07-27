-- =============================================================================
-- CoolCare — Migration: Multi-tenant WhatsApp Connection
-- Adds per-shop WhatsApp Business account linking via Meta Embedded Signup.
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards throughout).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. REPAIR_SHOP_WHATSAPP: per-shop WhatsApp credentials
-- Each repair shop can connect their OWN WhatsApp Business Account (WABA).
-- Credentials are AES-256-GCM encrypted before storage.
-- phone_number_id is globally unique to enable webhook routing.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repair_shop_whatsapp (
  id                   SERIAL PRIMARY KEY,
  repair_shop_id       INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,

  -- Meta Cloud API identifiers
  phone_number_id      TEXT NOT NULL,              -- Meta's phone number ID (scoped to WABA)
  waba_id              TEXT NOT NULL,              -- WhatsApp Business Account ID
  business_id          TEXT,                       -- Meta Business ID (optional, from signup)
  phone_number         TEXT,                       -- Display phone number (e.g. +15551234567)
  business_name        TEXT,                       -- Business display name from Meta

  -- Authentication
  access_token_enc     TEXT NOT NULL,              -- AES-256-GCM encrypted access token
  token_expiry         TIMESTAMPTZ,                -- Access token expiration timestamp
  refresh_token_enc    TEXT,                       -- Encrypted refresh token (if provided)

  -- Webhook & connection status
  webhook_status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (webhook_status IN ('pending', 'subscribed', 'active', 'disconnected', 'expired')),
  webhook_subscribed_at TIMESTAMPTZ,               -- When webhook was subscribed on Meta
  whatsapp_connected_at TIMESTAMPTZ,               -- First successful connection
  last_sync_at         TIMESTAMPTZ,                -- Last token refresh / health check

  -- Coexistence mode (Meta allows existing WABA providers to coexist)
  coexistence_mode     BOOLEAN NOT NULL DEFAULT false,

  -- Metadata
  metadata             JSONB DEFAULT '{}',         -- Extensible: waba_currency, timezone_id, etc.
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT unique_repair_shop_whatsapp UNIQUE (repair_shop_id),
  CONSTRAINT unique_phone_number_id UNIQUE (phone_number_id)
);

-- Index for fast webhook routing: identify shop by phone_number_id
CREATE INDEX IF NOT EXISTS idx_rw_phone_number_id
  ON repair_shop_whatsapp(phone_number_id);

-- Index for listing connected shops and expiry checks
CREATE INDEX IF NOT EXISTS idx_rw_token_expiry
  ON repair_shop_whatsapp(token_expiry)
  WHERE webhook_status IN ('active', 'subscribed');

-- Index for shop lookup
CREATE INDEX IF NOT EXISTS idx_rw_repair_shop_id
  ON repair_shop_whatsapp(repair_shop_id);

-- -----------------------------------------------------------------------------
-- 2. WHITELISTED_PHONE: phone numbers allowed to access shop features
-- (Optional: for SMS/phone-based staff access, etc.)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whitelisted_phones (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  phone_number     TEXT NOT NULL,
  label            TEXT,                            -- e.g. "Front Desk", "Manager"
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(repair_shop_id, phone_number)
);

-- -----------------------------------------------------------------------------
-- 3. ADD WHATSAPP FIELDS TO REPAIR_SHOPS (for status at-a-glance)
-- -----------------------------------------------------------------------------
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS whatsapp_connected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS whatsapp_phone_number TEXT;  -- cached for fast display
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS whatsapp_business_name TEXT;  -- cached for fast display

-- -----------------------------------------------------------------------------
-- 4. ADD WHATSAPP REFERENCE TO BOOKINGS (for per-shop message routing)
-- The bookings table already has repair_shop_id. Add phone_number_id for
-- direct mapping back to the WhatsApp connection used for this booking.
-- -----------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS phone_number_id TEXT;

-- -----------------------------------------------------------------------------
-- 5. ADD WHATSAPP REFERENCE TO CONVERSATIONS (for per-shop context)
-- -----------------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS repair_shop_id INTEGER
  REFERENCES repair_shops(id) ON DELETE SET NULL;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone_number_id TEXT;

-- -----------------------------------------------------------------------------
-- Done
-- -----------------------------------------------------------------------------

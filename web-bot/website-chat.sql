-- =============================================================================
-- CoolCare Website Live Chat — Database Migration
-- Adds a second communication channel (🌐 Website) beside (💬 WhatsApp).
--
-- One database. One AI engine. One dashboard. Two channels.
-- Run this once in the Neon SQL console (idempotent — safe to re-run).
-- =============================================================================

-- ─── 1. conversations: tag every message with its source channel ────────────
-- WhatsApp messages keep 'whatsapp'; website widget messages use 'website'.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'website'));

CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations(channel, created_at);

-- ─── 2. conversation_state: track which channel owns the session ─────────────
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'website'));

CREATE INDEX IF NOT EXISTS idx_conv_state_channel
  ON conversation_state(channel);

-- ─── 3. bookings: remember where the booking came from ───────────────────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (source IN ('whatsapp', 'website'));

CREATE INDEX IF NOT EXISTS idx_bookings_source
  ON bookings(source, created_at DESC);

-- ─── 4. whatsapp_conversations: unified message log shows both channels ──────
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'website'));

CREATE INDEX IF NOT EXISTS idx_wa_conv_channel
  ON whatsapp_conversations(channel, created_at DESC);

-- ─── 5. widget_settings: per-shop website chat branding & behavior ───────────
CREATE TABLE IF NOT EXISTS widget_settings (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  business_name    TEXT,                       -- overrides shop_name in widget
  welcome_message  TEXT DEFAULT '',            -- shown when chat opens
  offline_message  TEXT DEFAULT '',
  primary_color    TEXT NOT NULL DEFAULT '#22c55e',
  widget_position  TEXT NOT NULL DEFAULT 'bottom-right'
                   CHECK (widget_position IN ('bottom-right', 'bottom-left')),
  logo_url         TEXT DEFAULT '',
  theme            TEXT NOT NULL DEFAULT 'auto'
                   CHECK (theme IN ('light', 'dark', 'auto')),
  show_avatar      BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_widget_settings_shop UNIQUE (repair_shop_id)
);

CREATE INDEX IF NOT EXISTS idx_widget_settings_shop ON widget_settings(repair_shop_id);

-- ─── 6. Default widget settings row for every existing shop ──────────────────
INSERT INTO widget_settings (repair_shop_id, enabled, business_name)
  SELECT rs.id, false, rs.shop_name
  FROM repair_shops rs
  WHERE NOT EXISTS (SELECT 1 FROM widget_settings ws WHERE ws.repair_shop_id = rs.id);

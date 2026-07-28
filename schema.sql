-- CoolCare database schema for Neon Postgres
-- Run this once in the Neon SQL console to set up all tables.

-- Conversations: stores WhatsApp chat history per customer
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  customer_number TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'bot')),
  message TEXT NOT NULL,  created_at     TIMESTAMPTZ DEFAULT now(),
  approval_status TEXT NOT NULL DEFAULT 'none' CHECK (approval_status IN ('none','pending','approved','rejected')),
  approved_at    TIMESTAMPTZ,
  approved_by    INTEGER,
  rejection_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_number, created_at);

-- Conversation state: full state machine per customer
-- One row per customer. status drives the state machine; all collected fields stored here.
CREATE TABLE IF NOT EXISTS conversation_state (
  id SERIAL PRIMARY KEY,
  customer_number TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'COLLECTING_APPLIANCE',
  -- Possible statuses:
  --   COLLECTING_APPLIANCE, COLLECTING_ISSUE, COLLECTING_NAME,
  --   COLLECTING_ADDRESS, COLLECTING_LOCALITY, COLLECTING_DATE,
  --   CONFIRMATION_PENDING, BOOKED, CANCELLED, HUMAN_HANDOFF
  appliance     TEXT,   -- e.g. "Geyser", "Refrigerator", "AC"
  issue         TEXT,   -- e.g. "No hot water", "Not cooling"
  customer_name TEXT,
  address       TEXT,
  area          TEXT,
  urgency       TEXT,   -- e.g. "Today", "Tomorrow morning"
  booking_id    TEXT,   -- FK to bookings.id once confirmed
  repair_shop_id INTEGER, -- FK to repair_shops.id for multi-tenancy
  language      TEXT NOT NULL DEFAULT 'en', -- language preference: en, hi, ta, ar
  -- NEW COLUMNS for Phase 7 improvements
  image_urls    TEXT[] DEFAULT '{}',      -- WhatsApp images attached to conversation
  file_urls     TEXT[] DEFAULT '{}',      -- PDFs, invoices, warranty cards attached
  human_handoff BOOLEAN NOT NULL DEFAULT false, -- true when human takeover requested
  handoff_closed_at TIMESTAMPTZ,         -- when human closed the handoff
  ai_memory     JSONB DEFAULT '{}'::jsonb, -- persistent AI memory across messages
  selected_slot TIMESTAMPTZ,             -- reserved appointment slot
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_customer ON conversation_state(customer_number);
CREATE INDEX IF NOT EXISTS idx_conv_state_shop ON conversation_state(repair_shop_id);

-- Migration helper: if you already have the old table with a 'step' column, run this:
-- ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'COLLECTING_APPLIANCE';
-- ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS booking_id TEXT;
-- UPDATE conversation_state SET status = 'COLLECTING_' || upper(step) WHERE status = 'COLLECTING_APPLIANCE' AND step IS NOT NULL;

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
  -- NEW COLUMNS for Phase 7
  image_urls TEXT[] DEFAULT '{}',        -- Customer-submitted images
  file_urls  TEXT[] DEFAULT '{}',        -- PDF invoices, warranty cards, bills
  conversation_summary TEXT,             -- AI-generated summary of conversation
  customer_sentiment TEXT DEFAULT 'neutral', -- positive, neutral, negative, frustrated
  human_takeover_history JSONB DEFAULT '[]'::jsonb, -- array of human takeover events
  technician_name TEXT,
  technician_notes TEXT,
  estimated_cost NUMERIC(10,2),
  final_cost NUMERIC(10,2),
  priority TEXT DEFAULT 'normal',
  customer_notes TEXT,
  invoice_number TEXT,
  repair_shop_id INTEGER,
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

-- AI settings: per-shop AI assistant configuration
CREATE TABLE IF NOT EXISTS ai_settings (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  greeting_message TEXT DEFAULT '',
  business_hours   JSONB DEFAULT '{}',        -- e.g. {"mon":{"open":"09:00","close":"18:00"}, ...}
  working_days     TEXT[] DEFAULT ARRAY['mon','tue','wed','thu','fri','sat'],
  supported_services TEXT[] DEFAULT '{}',
  knowledge_base   TEXT DEFAULT '',             -- General knowledge about the shop
  fallback_response TEXT DEFAULT 'I apologize, but I am unable to help with that right now. A team member will get back to you shortly.',
  transfer_to_human BOOLEAN NOT NULL DEFAULT true,
  -- NEW COLUMNS for Phase 7: Shop Knowledge Base
  service_locations TEXT[] DEFAULT '{}',        -- Areas/localities served
  brands_repaired  TEXT[] DEFAULT '{}',         -- "Samsung, LG, Whirlpool, ..."
  warranty_policy  TEXT DEFAULT '',             -- e.g. "30-day warranty on all repairs"
  inspection_policy TEXT DEFAULT '',            -- e.g. "Free inspection, ₹299 visit charge"
  visiting_charges NUMERIC(10,2) DEFAULT 0,    -- Visit/diagnosis charge
  emergency_availability BOOLEAN NOT NULL DEFAULT false,
  holiday_timings  JSONB DEFAULT '{}',         -- Special holiday hours
  accepted_payment_methods TEXT[] DEFAULT '{}', -- "Cash, UPI, Card, Net Banking"
  languages_spoken TEXT[] DEFAULT '{}',         -- "English, Hindi, Kannada, Tamil"
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(repair_shop_id)
);

-- Sample technicians (edit with real names/numbers before going live)
INSERT INTO technicians (name, phone, active, services) VALUES
  ('Rajesh Kumar', '+919876543210', true, ARRAY['AC no cooling', 'AC installation', 'AC service', 'Refrigerator not cooling', 'Refrigerator repair']),
  ('Amit Singh',   '+919876543211', true, ARRAY['Geyser repair', 'Geyser no hot water', 'Washing machine not spinning', 'Washing machine repair']),
  ('Vijay Sharma', '+919876543212', true, ARRAY['Microwave not heating', 'TV repair', 'RO not working', 'Fan repair'])
ON CONFLICT DO NOTHING;

-- =============================================================================
-- PER-SHOP WHATSAPP CONNECTION
-- Each repair shop can connect their OWN WhatsApp Business Account via
-- Meta Embedded Signup. See migration-whatsapp-connection.sql for details.
-- =============================================================================
-- Conversation analytics: track bot performance metrics
CREATE TABLE IF NOT EXISTS conversation_analytics (
  id                SERIAL PRIMARY KEY,
  repair_shop_id    INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  date              DATE NOT NULL DEFAULT CURRENT_DATE,
  total_conversations INTEGER NOT NULL DEFAULT 0,
  booking_completed  INTEGER NOT NULL DEFAULT 0,
  human_handoff      INTEGER NOT NULL DEFAULT 0,
  drop_off_stage     TEXT,                     -- Stage where users most frequently drop off
  most_common_appliance TEXT,
  most_common_issue    TEXT,
  avg_response_time_ms INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(repair_shop_id, date)
);

CREATE INDEX IF NOT EXISTS idx_conv_analytics_shop ON conversation_analytics(repair_shop_id, date);

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
CREATE INDEX IF NOT EXISTS idx_rw_token_expiry ON repair_shop_whatsapp(token_expiry) WHERE webhook_status IN ('active', 'subscribed');
CREATE INDEX IF NOT EXISTS idx_rw_repair_shop_id ON repair_shop_whatsapp(repair_shop_id);

-- Whitelisted phone numbers per shop (optional access control)
CREATE TABLE IF NOT EXISTS whitelisted_phones (
  id               SERIAL PRIMARY KEY,
  repair_shop_id   INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
  phone_number     TEXT NOT NULL,
  label            TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(repair_shop_id, phone_number)
);

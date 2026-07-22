-- CoolCare database schema for Neon Postgres
-- Run this once in the Neon SQL console to set up all tables.

-- Conversations: stores WhatsApp chat history per customer
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  customer_number TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'bot')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
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
  --   CONFIRMATION_PENDING, BOOKED, CANCELLED
  appliance     TEXT,   -- e.g. "Geyser", "Refrigerator", "AC"
  issue         TEXT,   -- e.g. "No hot water", "Not cooling"
  customer_name TEXT,
  address       TEXT,
  area          TEXT,
  urgency       TEXT,   -- e.g. "Today", "Tomorrow morning"
  booking_id    TEXT,   -- FK to bookings.id once confirmed
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_customer ON conversation_state(customer_number);

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

-- Demo requests: landing page demo form submissions
CREATE TABLE IF NOT EXISTS demo_requests (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  business_name TEXT,
  whatsapp_number TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Sample technicians (edit with real names/numbers before going live)
INSERT INTO technicians (name, phone, active, services) VALUES
  ('Rajesh Kumar', '+919876543210', true, ARRAY['AC no cooling', 'AC installation', 'AC service', 'Refrigerator not cooling', 'Refrigerator repair']),
  ('Amit Singh',   '+919876543211', true, ARRAY['Geyser repair', 'Geyser no hot water', 'Washing machine not spinning', 'Washing machine repair']),
  ('Vijay Sharma', '+919876543212', true, ARRAY['Microwave not heating', 'TV repair', 'RO not working', 'Fan repair'])
ON CONFLICT DO NOTHING;

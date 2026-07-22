-- Migration: Add conversation_state table
-- Run this in your Neon SQL console to fix the conversation state bug.

CREATE TABLE IF NOT EXISTS conversation_state (
  id SERIAL PRIMARY KEY,
  customer_number TEXT NOT NULL UNIQUE,
  step TEXT NOT NULL DEFAULT 'appliance',  -- Current step: appliance, issue, name, address, area, urgency, confirm
  appliance TEXT,                          -- Extracted appliance name
  issue TEXT,                              -- Extracted issue description
  customer_name TEXT,                      -- Extracted customer name
  address TEXT,                            -- Extracted address
  area TEXT,                               -- Extracted area/locality
  urgency TEXT,                            -- Extracted urgency/time preference
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_customer ON conversation_state(customer_number);

-- Optional: Clear old broken conversation history to start fresh
-- TRUNCATE TABLE conversations;
-- (Uncomment the line above if you want to delete all old chat logs)

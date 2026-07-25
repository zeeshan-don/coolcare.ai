-- =============================================================================
-- CoolCare — Migration: Add ai_settings table
-- Fixes: 500 Internal Server Error when saving AI settings
--        (relation "ai_settings" does not exist)
-- Safe to re-run (uses IF NOT EXISTS guards).
-- =============================================================================

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

-- =============================================================================
-- Done
-- =============================================================================

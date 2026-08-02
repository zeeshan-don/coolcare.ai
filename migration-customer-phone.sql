-- =============================================================================
-- CoolCare — customer_phone columns (Website Chat phone collection fix)
-- =============================================================================
-- WHY THIS FILE EXISTS
-- -------------------
-- The shared conversation engine (api/_lib/conversation-engine.js) collects the
-- customer's phone number on BOTH channels:
--   💬 WhatsApp → auto-fills the sender's number (changeable)
--   🌐 Website  → asks for it during the booking flow (COLLECTING_PHONE step)
--
-- The engine persists the phone in TWO places:
--   1. conversation_state.customer_phone — the WORKING copy stored on the
--      per-customer state-machine row while the booking flow is in progress.
--      The engine reads it to render the booking summary and to decide whether
--      to show the auto-filled WhatsApp number or ask for one on the website.
--   2. bookings.customer_phone — the DURABLE copy copied over at booking
--      confirmation (createBooking()), so the technician has a call-back
--      number even after the state row is reset/deleted.
--
-- This column is SHARED by both channels — it is not website-only, which is why
-- the Website Chat migration (web-bot/website-chat.sql) must be supplemented by
-- this file: running only website-chat.sql left conversation_state without the
-- column, producing:
--     column "customer_phone" of relation "conversation_state" does not exist
--
-- SAFE TO RE-RUN: all statements use IF NOT EXISTS.
-- NO hardcoded values: the columns are plain nullable TEXT — no data backfill.
-- =============================================================================

-- Working copy: collected during the booking state machine (COLLECTING_PHONE).
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS customer_phone TEXT;

-- Durable copy: stored on the confirmed booking so the technician can call back.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS customer_phone TEXT;

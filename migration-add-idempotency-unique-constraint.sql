-- migration-add-idempotency-unique-constraint.sql
-- Add unique constraint on payment_logs.idempotency_key
-- This enables atomic INSERT ... ON CONFLICT DO NOTHING for webhook idempotency
-- eliminating the TOCTOU race condition between SELECT + INSERT.

-- First, clean up any duplicate idempotency_key values that may exist
-- (keep the earliest one, delete duplicates)
DELETE FROM payment_logs pl1 USING (
  SELECT MIN(id) as id, idempotency_key
  FROM payment_logs
  WHERE idempotency_key IS NOT NULL
  GROUP BY idempotency_key
  HAVING COUNT(*) > 1
) pl2
WHERE pl1.idempotency_key = pl2.idempotency_key
  AND pl1.idempotency_key IS NOT NULL
  AND pl1.id != pl2.id;

-- Now add the unique constraint
ALTER TABLE payment_logs ADD CONSTRAINT payment_logs_idempotency_key_unique UNIQUE (idempotency_key);

-- Create an index to speed up idempotency lookups
CREATE INDEX IF NOT EXISTS idx_payment_logs_idempotency_key ON payment_logs (idempotency_key);

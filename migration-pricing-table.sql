-- =============================================================================
-- CoolCare AI — Migration: Pricing Table for Multi-Currency Plans
-- Adds: subscription_plan_prices table for distinct currency pricing values.
-- Safe to re-run using IF NOT EXISTS / ON CONFLICT guards.
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscription_plan_prices (
  id               SERIAL PRIMARY KEY,
  plan_id          INTEGER NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  currency         TEXT NOT NULL,
  price_monthly    NUMERIC(10,2) NOT NULL,
  price_quarterly  NUMERIC(10,2) NOT NULL,
  price_halfyearly NUMERIC(10,2) NOT NULL,
  price_yearly     NUMERIC(10,2) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_currency ON subscription_plan_prices(currency);
CREATE INDEX IF NOT EXISTS idx_subscription_plan_prices_plan_currency ON subscription_plan_prices(plan_id, currency);

-- Seed pricing values for all core plans and supported currencies.
WITH plans AS (
  SELECT id, name FROM subscription_plans WHERE name IN ('starter','professional','enterprise')
), prices AS (
  SELECT * FROM (VALUES
    ('starter','INR',1299.00,3156.00,6625.00,12470.00),
    ('professional','INR',3499.00,9447.00,17845.00,33590.00),
    ('enterprise','INR',6499.00,17547.00,33145.00,62390.00),
    ('starter','USD',20.00,54.00,102.00,192.00),
    ('professional','USD',60.00,162.00,306.00,576.00),
    ('enterprise','USD',100.00,270.00,510.00,960.00),
    ('starter','AED',75.00,202.50,382.50,720.00),
    ('professional','AED',220.00,594.00,1122.00,2112.00),
    ('enterprise','AED',370.00,999.00,1887.00,3552.00),
    ('starter','KWD',6.00,16.20,30.60,57.60),
    ('professional','KWD',18.00,48.60,91.80,172.80),
    ('enterprise','KWD',30.00,81.00,153.00,288.00)
  ) AS v(name,currency,price_monthly,price_quarterly,price_halfyearly,price_yearly)
)
INSERT INTO subscription_plan_prices (plan_id, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly)
SELECT p.id, pr.currency, pr.price_monthly, pr.price_quarterly, pr.price_halfyearly, pr.price_yearly
FROM plans p
JOIN prices pr ON pr.name = p.name
ON CONFLICT (plan_id, currency) DO NOTHING;

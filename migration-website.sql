-- =============================================================================
-- COOLCARE — HOSTED SHOP WEBSITES + SUBSCRIPTION-BASED WEBSITE ACCESS
-- (migration-website.sql)
-- =============================================================================
-- What this does (safe to re-run):
--   1. Adds `slug` (unique website URL path) to repair_shops
--   2. Adds `website_enabled` feature flag to repair_shops
--   3. Backfills a slug for every existing shop
--   4. Sets Starter ($20/mo) and Pro ($25/mo) plan pricing + feature flags
--      (website is a Pro-only feature)
--   5. Seeds a permanent "Test Shop" (slug: testshop) for end-to-end testing
--   6. Ensures the Test Shop has ai_settings + widget_settings rows
-- =============================================================================

-- ─── 1. Slug + website_enabled feature flag ─────────────────────────────────
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE repair_shops ADD COLUMN IF NOT EXISTS website_enabled BOOLEAN NOT NULL DEFAULT false;

-- Backfill slugs for shops created before this migration (shop name → slug)
UPDATE repair_shops
SET slug = LOWER(REGEXP_REPLACE(TRIM(shop_name), '[^a-z0-9]+', '-', 'g'))
WHERE slug IS NULL
  AND shop_name IS NOT NULL
  AND LOWER(REGEXP_REPLACE(TRIM(shop_name), '[^a-z0-9]+', '-', 'g')) <> '';

-- Guarantee uniqueness on the backfilled slugs
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id, slug,
           ROW_NUMBER() OVER (PARTITION BY slug ORDER BY id) AS rn
    FROM repair_shops
    WHERE slug IS NOT NULL
  LOOP
    IF r.rn > 1 THEN
      UPDATE repair_shops
      SET slug = r.slug || '-' || r.rn
      WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_shops_slug ON repair_shops(slug);

-- =============================================================================
-- 2. STARTER ($20) & PRO ($25) PLANS
-- =============================================================================
-- Starter — Dashboard, WhatsApp AI, Technician Management, Analytics,
--           Business Timeline, Repair Lifecycle. NO hosted website.
UPDATE subscription_plans SET
  display_name      = 'Starter',
  price_monthly_usd = 20.00,
  price_yearly_usd  = 192.00,
  description       = 'Dashboard, WhatsApp AI, technician management, analytics, business timeline and repair lifecycle.',
  features          = '{
    "dashboard": true,
    "whatsapp_ai": true,
    "technician_management": true,
    "analytics": true,
    "business_timeline": true,
    "repair_lifecycle": true,
    "hosted_website": false,
    "website_chat": false,
    "public_booking_page": false,
    "website_customization": false
  }'::jsonb,
  is_active = true
WHERE name = 'starter';

-- Pro — Everything in Starter plus Hosted Website, Website Chat,
--       Public Booking Page, Website Customization.
UPDATE subscription_plans SET
  display_name      = 'Pro',
  price_monthly_usd = 25.00,
  price_yearly_usd  = 240.00,
  description       = 'Everything in Starter, plus a hosted website, website chat, public booking page and website customization.',
  features          = '{
    "dashboard": true,
    "whatsapp_ai": true,
    "technician_management": true,
    "analytics": true,
    "business_timeline": true,
    "repair_lifecycle": true,
    "hosted_website": true,
    "website_chat": true,
    "public_booking_page": true,
    "website_customization": true
  }'::jsonb,
  is_active = true
WHERE name = 'pro';

-- Legacy plans are no longer sold (kept for historical subscription records)
UPDATE subscription_plans SET is_active = false
WHERE name IN ('professional', 'enterprise');

-- ─── 2b. Multi-currency pricing (subscription_plan_prices) ─────────────────
-- Starter $20 / Pro $25 in USD + aligned regional pricing.
INSERT INTO subscription_plan_prices (plan_id, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly, active)
SELECT sp.id, v.currency, v.price_monthly, v.price_quarterly, v.price_halfyearly, v.price_yearly, true
FROM subscription_plans sp
CROSS JOIN (VALUES
  ('starter', 'USD', 20.00, 54.00, 102.00, 192.00),
  ('starter', 'INR', 1199.00, 3237.00, 6115.00, 11508.00),
  ('starter', 'AED', 75.00, 202.50, 382.50, 720.00),
  ('starter', 'KWD', 6.00, 16.20, 30.60, 57.60),
  ('pro',     'USD', 25.00, 67.50, 127.50, 240.00),
  ('pro',     'INR', 1499.00, 4047.00, 7644.00, 14390.00),
  ('pro',     'AED', 90.00, 243.00, 459.00, 864.00),
  ('pro',     'KWD', 7.50, 20.25, 38.25, 72.00)
) AS v(name, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly)
WHERE sp.name = v.name
ON CONFLICT (plan_id, currency) DO UPDATE SET
  price_monthly    = EXCLUDED.price_monthly,
  price_quarterly  = EXCLUDED.price_quarterly,
  price_halfyearly = EXCLUDED.price_halfyearly,
  price_yearly     = EXCLUDED.price_yearly,
  active           = true,
  updated_at       = now();

-- =============================================================================
-- 2c. BACKFILL website_enabled FOR ALREADY-ELIGIBLE SHOPS
-- =============================================================================
-- The website_enabled column defaults to false, so shops that existed BEFORE
-- this migration keep it false even when they are paying Pro customers with an
-- active subscription. Without this, api/website.js serves "Website not
-- available" (404) for those shops forever.
--
-- This restores the flag for any shop whose CURRENT state says it is eligible:
--   • shop.subscription_status = 'active'   (what the website route checks)
--   • an active subscription on a plan whose features include hosted_website
--     (Pro) / website_enabled / website.
--
-- Safe to re-run and only ever sets the flag to true — it never disables an
-- existing website. (A later subscription expiry disables it via api/cron.js.)
UPDATE repair_shops rs
SET website_enabled = true, updated_at = now()
WHERE rs.subscription_status = 'active'
  AND rs.website_enabled = false
  AND EXISTS (
    SELECT 1
    FROM subscriptions s
    JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.repair_shop_id = rs.id
      AND s.status = 'active'
      AND COALESCE(
            (sp.features->>'hosted_website')::boolean,
            (sp.features->>'website_enabled')::boolean,
            (sp.features->>'website')::boolean,
            false
          )
  );

-- =============================================================================
-- 3. PERMANENT TEST SHOP (slug: testshop)
-- =============================================================================
-- Customer-facing website: /testshop
-- Login: test@testshop.demo / TestShop2024!
-- (bcryptjs hash for 'TestShop2024!' — generated with the project's bcryptjs)
INSERT INTO repair_shops
  (shop_name, owner_name, email, mobile, password_hash,
   address, city, service_areas, services_offered, role,
   subscription_status, is_active, referral_code, approval_status,
   logo_url, business_hours, language, timezone,
   selected_country, selected_currency, slug, website_enabled, is_demo)
SELECT
  'Test Shop', 'Test Owner', 'test@testshop.demo', '9000000001',
  '$2a$12$fZkKrivuI3ER/ZcAc77uX.Jo85x0ajOCZt9Xb60NMjgWqOM0tmb22',
  '1, Test Street, Test City', 'Test City',
  ARRAY['Downtown', 'North Side', 'South Side'],
  ARRAY['AC Repair', 'Refrigerator Repair', 'Washing Machine Repair', 'Geyser Repair', 'Microwave Repair', 'RO Purifier Service'],
  'owner', 'active', true, 'TESTSHOP-01', 'approved',
  '', '{"mon":{"open":"09:00","close":"18:00"},"tue":{"open":"09:00","close":"18:00"},"wed":{"open":"09:00","close":"18:00"},"thu":{"open":"09:00","close":"18:00"},"fri":{"open":"09:00","close":"18:00"},"sat":{"open":"10:00","close":"16:00"}}'::jsonb,
  'en', 'Asia/Kolkata', 'IN', 'INR', 'testshop', true, true
WHERE NOT EXISTS (SELECT 1 FROM repair_shops WHERE email = 'test@testshop.demo')
ON CONFLICT (email) DO NOTHING;

-- Subscription + plan record for the Test Shop (Pro plan — website enabled)
INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway, current_period_start, current_period_end, amount_paid, currency)
SELECT rs.id, sp.id, 'active', 'monthly', 'test',
       now() - interval '1 day', now() + interval '30 days', 25.00, 'USD'
FROM repair_shops rs
JOIN subscription_plans sp ON sp.name = 'pro'
WHERE rs.email = 'test@testshop.demo'
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.repair_shop_id = rs.id)
ON CONFLICT DO NOTHING;

-- AI settings (knowledge base drives the website "About" section + chat)
INSERT INTO ai_settings (repair_shop_id, greeting_message, business_hours, working_days,
  supported_services, knowledge_base, fallback_response, transfer_to_human,
  service_locations, brands_repaired, warranty_policy, inspection_policy,
  visiting_charges, accepted_payment_methods, languages_spoken, updated_at, created_at)
SELECT rs.id,
  'Hi, welcome to Test Shop! I am your AI assistant. How can I help you today?',
  rs.business_hours,
  ARRAY['mon','tue','wed','thu','fri','sat'],
  ARRAY['AC Repair', 'Refrigerator Repair', 'Washing Machine Repair', 'Geyser Repair', 'Microwave Repair', 'RO Purifier Service'],
  'Test Shop is a full-service appliance repair business. We repair air conditioners, refrigerators, washing machines, geysers, microwaves and RO purifiers with genuine parts and a service warranty.',
  'I am unable to help with that right now. A team member will get back to you shortly.',
  true,
  ARRAY['Downtown', 'North Side', 'South Side'],
  ARRAY['Samsung', 'LG', 'Whirlpool', 'Voltas', 'Blue Star', 'Havells'],
  '30-day warranty on all repairs.',
  'Free inspection; a visit charge applies for no-show service calls.',
  199,
  ARRAY['Cash', 'UPI', 'Card', 'Net Banking'],
  ARRAY['English', 'Hindi'],
  now(), now()
FROM repair_shops rs
WHERE rs.email = 'test@testshop.demo'
ON CONFLICT (repair_shop_id) DO UPDATE SET
  greeting_message    = EXCLUDED.greeting_message,
  business_hours      = EXCLUDED.business_hours,
  working_days        = EXCLUDED.working_days,
  supported_services  = EXCLUDED.supported_services,
  knowledge_base      = EXCLUDED.knowledge_base,
  service_locations   = EXCLUDED.service_locations,
  brands_repaired     = EXCLUDED.brands_repaired,
  warranty_policy     = EXCLUDED.warranty_policy,
  inspection_policy   = EXCLUDED.inspection_policy,
  visiting_charges    = EXCLUDED.visiting_charges,
  accepted_payment_methods = EXCLUDED.accepted_payment_methods,
  languages_spoken    = EXCLUDED.languages_spoken,
  updated_at          = now();

-- Widget settings (website chat branding for the Test Shop)
INSERT INTO widget_settings (repair_shop_id, enabled, business_name, welcome_message, offline_message,
  primary_color, accent_color, widget_position, logo_url, theme, show_avatar, auto_open, language, updated_at)
SELECT rs.id, true, rs.shop_name,
  'Hi, welcome to Test Shop! How can we help you today?',
  'We have received your request. Our team is currently offline. Your booking has been recorded and a technician will contact you once the business opens.',
  '#2563eb', '#1e40af', 'bottom-right', rs.logo_url, 'auto', true, false, 'en', now()
FROM repair_shops rs
WHERE rs.email = 'test@testshop.demo'
ON CONFLICT (repair_shop_id) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  business_name = EXCLUDED.business_name,
  welcome_message = EXCLUDED.welcome_message,
  offline_message = EXCLUDED.offline_message,
  primary_color = EXCLUDED.primary_color,
  accent_color = EXCLUDED.accent_color,
  widget_position = EXCLUDED.widget_position,
  logo_url = EXCLUDED.logo_url,
  theme = EXCLUDED.theme,
  show_avatar = EXCLUDED.show_avatar,
  auto_open = EXCLUDED.auto_open,
  language = EXCLUDED.language,
  updated_at = now();

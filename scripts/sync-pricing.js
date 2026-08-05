// scripts/sync-pricing.js
// ═══════════════════════════════════════════════════════════════════════════
// Push the SINGLE pricing config (api/_lib/pricing.js) into the database
// mirror (subscription_plan_prices) so the backend, Razorpay, the website
// and the admin panel all read identical numbers.
//
// Run this AFTER editing api/_lib/pricing.js (or just run the migration —
// migration-combined.sql carries the same values).
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/sync-pricing.js
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const { neon } = require("@neondatabase/serverless");
const { PLANS, getAllPricing, getSupportedCurrencies } = require("../api/_lib/pricing");

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  const sql = neon(dbUrl);
  const plans = ["starter", "pro"];
  const currencies = getSupportedCurrencies();
  const prices = getAllPricing();

  console.log("Syncing pricing config (api/_lib/pricing.js) → subscription_plan_prices");
  console.log("Plans:", plans.join(", "), "| Currencies:", currencies.join(", "));

  // 1. Resolve plan ids by NAME (never assume fixed ids).
  const planRows = await sql`SELECT id, name FROM subscription_plans WHERE name IN ('starter','pro')`;
  const planId = {};
  planRows.forEach((r) => { planId[r.name] = r.id; });
  if (!planId.starter || !planId.pro) {
    console.error("Both 'starter' and 'pro' plans must exist in subscription_plans. Run the migration first.");
    process.exit(1);
  }

  // 2. Upsert every price row for both plans × all currencies.
  for (const plan of plans) {
    for (const currency of currencies) {
      const p = prices[plan][currency];
      await sql`
        INSERT INTO subscription_plan_prices
          (plan_id, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly, active)
        VALUES (${planId[plan]}, ${currency}, ${p.monthly}, ${p.quarterly}, ${p.halfyearly}, ${p.yearly}, true)
        ON CONFLICT (plan_id, currency) DO UPDATE SET
          price_monthly = EXCLUDED.price_monthly,
          price_quarterly = EXCLUDED.price_quarterly,
          price_halfyearly = EXCLUDED.price_halfyearly,
          price_yearly = EXCLUDED.price_yearly,
          active = true,
          updated_at = now()
      `;
      console.log(`  ${plan}/${currency}: ${p.monthly}/${p.quarterly}/${p.halfyearly}/${p.yearly}`);
    }
  }

  // 3. Keep the display columns on subscription_plans in sync too.
  const usd = prices.pro.USD;
  await sql`UPDATE subscription_plans SET price_monthly_usd = ${usd.monthly}, price_yearly_usd = ${usd.yearly}, is_active = true WHERE name = 'pro'`;
  const starterUsd = prices.starter.USD;
  await sql`UPDATE subscription_plans SET price_monthly_usd = ${starterUsd.monthly}, price_yearly_usd = ${starterUsd.yearly}, is_active = true WHERE name = 'starter'`;

  // Deactivate legacy plans (no longer sold).
  await sql`UPDATE subscription_plans SET is_active = false WHERE name IN ('professional', 'enterprise')`;

  console.log("\nDone. Run `node scripts/verify-pricing.js` (with DATABASE_URL) to confirm consistency.");
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});

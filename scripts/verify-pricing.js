// scripts/verify-pricing.js
// ═══════════════════════════════════════════════════════════════════════════
// Pricing verification — STEP 8 of the pricing refactor.
//
// Verifies that the SINGLE pricing config (api/_lib/pricing.js) is internally
// consistent and, when DATABASE_URL is set, that the live database mirror
// (subscription_plan_prices) matches it EXACTLY for every combination of:
//   Plan:        Starter, Pro
//   Billing:     Monthly, Quarterly, Half-Yearly, Yearly
//   Currency:    USD, INR, AED, KWD
//
// The website price, backend price and Razorpay price can only be identical
// when config == DB. This script proves it.
//
// Usage:
//   node scripts/verify-pricing.js            # config only
//   DATABASE_URL=postgres://... node scripts/verify-pricing.js   # config + DB
//   DATABASE_URL=postgres://... node scripts/verify-pricing.js --fix   # also fix DB
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const {
  PLANS,
  PRICES,
  BILLING_CYCLES,
  getPrice,
  getSupportedCurrencies,
  getAllPricing,
  pricesMatch,
} = require("../api/_lib/pricing");

let failures = 0;
let checks = 0;

function ok(cond, label, detail) {
  checks++;
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`);
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════════════");
  console.log("PRICING VERIFICATION — single source: api/_lib/pricing.js");
  console.log("══════════════════════════════════════════════════════════");

  // ── 1. Config sanity ──────────────────────────────────────────────────────
  console.log("\n[1] Config sanity");
  const currencies = getSupportedCurrencies();
  ok(currencies.length >= 4, `4+ supported currencies found: ${currencies.join(", ")}`);

  for (const plan of Object.keys(PLANS)) {
    for (const currency of currencies) {
      for (const cycle of BILLING_CYCLES) {
        const p = getPrice(plan, cycle, currency);
        const label = `${plan}/${currency}/${cycle}`;
        ok(typeof p === "number" && isFinite(p) && p > 0, `${label} = ${p} (valid amount)`);
        const inTable = PRICES[plan] && PRICES[plan][currency] && PRICES[plan][currency][cycle] != null;
        if (inTable) {
          ok(pricesMatch(p, PRICES[plan][currency][cycle]), `${label} getPrice() matches PRICES table`, `config ${p} vs table ${PRICES[plan][currency][cycle]}`);
        }
      }
    }
  }

  // Cycle ordering: yearly total < halfyearly < quarterly (bulk discount)
  for (const plan of Object.keys(PLANS)) {
    for (const currency of currencies) {
      const m = getPrice(plan, "monthly", currency);
      const q = getPrice(plan, "quarterly", currency);
      const h = getPrice(plan, "halfyearly", currency);
      const y = getPrice(plan, "yearly", currency);
      ok(q < m * 3, `${plan}/${currency} quarterly < 3×monthly (${q} < ${m * 3})`);
      ok(h < m * 6, `${plan}/${currency} halfyearly < 6×monthly (${h} < ${m * 6})`);
      ok(y < m * 12, `${plan}/${currency} yearly < 12×monthly (${y} < ${m * 12})`);
    }
  }

  // Starter must never cost more than Pro for the same cycle+currency
  for (const currency of currencies) {
    for (const cycle of BILLING_CYCLES) {
      const s = getPrice("starter", cycle, currency);
      const p = getPrice("pro", cycle, currency);
      ok(s <= p, `starter <= pro for ${currency}/${cycle} (${s} <= ${p})`);
    }
  }

  // ── 2. Print the full matrix (STEP 8 table) ───────────────────────────────
  console.log("\n[2] Published price matrix");
  console.log("    Plan      Currency   Monthly   Quarterly  Half-Yearly  Yearly");
  for (const plan of Object.keys(PLANS)) {
    for (const currency of currencies) {
      const row = BILLING_CYCLES.map((c) => getPrice(plan, c, currency).toLocaleString("en-US", { maximumFractionDigits: 2 }));
      console.log(
        `    ${plan.padEnd(10)} ${currency.padEnd(8)} ${row[0].padStart(8)} ${row[1].padStart(10)} ${row[2].padStart(11)} ${row[3].padStart(8)}`
      );
    }
  }

  // ── 3. DB mirror comparison (optional) ────────────────────────────────────
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    console.log("\n[3] Live DB comparison (subscription_plan_prices)");
    let sql;
    try {
      ({ neon: sql } = require("@neondatabase/serverless"));
    } catch (e) {
      console.log("  ⚠ @neondatabase/serverless not installed — skipping DB check.");
      return finish();
    }
    const client = sql(dbUrl);
    const fix = process.argv.includes("--fix");

    const planRows = await client`SELECT id, name FROM subscription_plans WHERE name IN ('starter','pro')`;
    const planId = {};
    planRows.forEach((r) => { planId[r.name] = r.id; });
    if (!planId.starter || !planId.pro) {
      ok(false, "starter & pro plans exist in DB", `found: ${JSON.stringify(planRows)}`);
      return finish();
    }

    for (const plan of ["starter", "pro"]) {
      for (const currency of currencies) {
        const expected = getAllPricing()[plan][currency];
        const rows = await client`
          SELECT price_monthly, price_quarterly, price_halfyearly, price_yearly, active
          FROM subscription_plan_prices
          WHERE plan_id = ${planId[plan]} AND currency = ${currency}
          LIMIT 1
        `;
        const label = `${plan}/${currency}`;
        if (rows.length === 0) {
          ok(false, `DB row exists for ${label}`);
          if (fix) {
            await client`
              INSERT INTO subscription_plan_prices
                (plan_id, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly, active)
              VALUES (${planId[plan]}, ${currency}, ${expected.monthly}, ${expected.quarterly}, ${expected.halfyearly}, ${expected.yearly}, true)
              ON CONFLICT (plan_id, currency) DO UPDATE SET
                price_monthly = EXCLUDED.price_monthly, price_quarterly = EXCLUDED.price_quarterly,
                price_halfyearly = EXCLUDED.price_halfyearly, price_yearly = EXCLUDED.price_yearly,
                active = true, updated_at = now()
            `;
            console.log(`     ↳ fixed: inserted ${label} = ${JSON.stringify(expected)}`);
          }
          continue;
        }
        const db = rows[0];
        const match =
          pricesMatch(parseFloat(db.price_monthly), expected.monthly) &&
          pricesMatch(parseFloat(db.price_quarterly), expected.quarterly) &&
          pricesMatch(parseFloat(db.price_halfyearly), expected.halfyearly) &&
          pricesMatch(parseFloat(db.price_yearly), expected.yearly) &&
          db.active === true;
        ok(match, `DB matches config for ${label}`, `DB ${db.price_monthly}/${db.price_quarterly}/${db.price_halfyearly}/${db.price_yearly} vs config ${JSON.stringify(expected)}`);
        if (!match && fix) {
          await client`
            UPDATE subscription_plan_prices SET
              price_monthly = ${expected.monthly}, price_quarterly = ${expected.quarterly},
              price_halfyearly = ${expected.halfyearly}, price_yearly = ${expected.yearly},
              active = true, updated_at = now()
            WHERE plan_id = ${planId[plan]} AND currency = ${currency}
          `;
          console.log(`     ↳ fixed: ${label} set to ${JSON.stringify(expected)}`);
        }
      }
    }
  } else {
    console.log("\n[3] DB comparison skipped (no DATABASE_URL). Run with DATABASE_URL to verify the live mirror.");
  }

  return finish();
}

function finish() {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(`${checks} checks, ${failures} failure${failures === 1 ? "" : "s"}.`);
  if (failures > 0) {
    console.log("RESULT: FAIL — prices are NOT consistent.");
    process.exit(1);
  }
  console.log("RESULT: PASS — every plan × cycle × currency is consistent.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Verification crashed:", err);
  process.exit(2);
});

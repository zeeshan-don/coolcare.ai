// scripts/verify-website-slug.js
// Hosted-website eligibility tracer — mirrors the EXACT logic in api/website.js
// (loadShopBySlug + the feature gate) against the real database, so you can see
// which condition is failing for a slug that returns "Website not available".
//
// Run: DATABASE_URL=postgres://... node scripts/verify-website-slug.js zshan-shop
// (If DATABASE_URL is already exported, just: node scripts/verify-website-slug.js zshan-shop)

const { neon } = require("@neondatabase/serverless");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is not set.");
    console.error("Run with: DATABASE_URL=postgres://user:pass@host/db node scripts/verify-website-slug.js <slug>");
    process.exit(1);
  }

  const slug = String(process.argv[2] || "").trim().toLowerCase();
  if (!slug) {
    console.error("ERROR: pass a slug as the first argument, e.g. node scripts/verify-website-slug.js zshan-shop");
    process.exit(1);
  }

  const sql = neon(databaseUrl);

  console.log("=".repeat(80));
  console.log(`🔍 WEBSITE ELIGIBILITY TRACE for slug: "${slug}"`);
  console.log("=".repeat(80));

  // ── 1. Slug format check (identical regex to api/website.js loadShopBySlug) ──
  const slugValid = /^[a-z0-9-]+$/.test(slug) && slug.length <= 100;
  console.log(`1. Slug format (^[a-z0-9-]+$, length ≤ 100): ${slugValid ? "✅ valid" : "❌ INVALID"}`);
  if (!slugValid) {
    console.log("   → api/website.js returns null → 404 \"Website not found\".");
    process.exit(0);
  }

  // ── 2. Shop lookup (identical query to api/website.js loadShopBySlug) ────────
  const rows = await sql`
    SELECT id, shop_name, owner_name, email, mobile, city,
           website_enabled, slug, is_active, suspended_at,
           subscription_status, approval_status, created_at, updated_at
    FROM repair_shops
    WHERE LOWER(slug) = ${slug} AND is_active = true
    LIMIT 1
  `;

  if (rows.length === 0) {
    const anyRows = await sql`
      SELECT id, shop_name, is_active, slug, subscription_status, website_enabled
      FROM repair_shops WHERE LOWER(slug) = ${slug} LIMIT 1
    `;
    if (anyRows.length === 0) {
      console.log("2. Shop lookup: ❌ NO shop row has this slug.");
      console.log("   → api/website.js returns 404 \"Website not found\".");
    } else {
      console.log("2. Shop lookup: ❌ a shop with this slug exists but is_active = false.");
      console.log("   Row: " + JSON.stringify({
        id: anyRows[0].id,
        shop_name: anyRows[0].shop_name,
        is_active: anyRows[0].is_active,
        subscription_status: anyRows[0].subscription_status,
        website_enabled: anyRows[0].website_enabled,
      }, null, 2));
      console.log("   → api/website.js returns 404 \"Website not found\".");
    }
    process.exit(0);
  }

  const s = rows[0];
  console.log(`2. Shop lookup: ✅ FOUND — id=${s.id}, name="${s.shop_name}", email=${s.email}`);
  console.log("   ── Gate inputs (what api/website.js sees):");
  console.log(`      website_enabled        = ${s.website_enabled}`);
  console.log(`      subscription_status    = "${s.subscription_status}"`);
  console.log(`      approval_status        = "${s.approval_status || "(none)"}"`);
  console.log(`      is_active              = ${s.is_active}`);
  console.log(`      suspended_at           = ${s.suspended_at || "null"}`);
  console.log(`      created_at             = ${s.created_at}`);
  console.log(`      updated_at             = ${s.updated_at}`);

  // ── 3. Feature gate (identical to api/website.js) ───────────────────────────
  //   if (!shop.website_enabled || shop.subscription_status !== "active") → 404
  const gatePass = !!s.website_enabled && s.subscription_status === "active";
  console.log("3. Feature gate (!website_enabled || subscription_status !== 'active'):");
  console.log(`   website_enabled = ${s.website_enabled} ${s.website_enabled ? "✅" : "❌ FAILS"}`);
  console.log(`   subscription_status = "${s.subscription_status}" ${s.subscription_status === "active" ? "✅" : "❌ FAILS"}`);
  console.log(gatePass
    ? "   → Gate passes → route serves HTTP 200 (full website)."
    : "   → 404 \"Website not available\" is CORRECT per current DB state.");

  // ── 4. Subscription + plan detail (is the shop actually on a website plan?) ──
  try {
    const subs = await sql`
      SELECT s.id, s.status, s.billing_cycle, s.current_period_start, s.current_period_end,
             sp.name AS plan_name, sp.display_name, sp.features
      FROM subscriptions s
      JOIN subscription_plans sp ON sp.id = s.plan_id
      WHERE s.repair_shop_id = ${s.id}
      ORDER BY s.created_at DESC LIMIT 3
    `;
    console.log("4. Subscription / plan records:");
    if (subs.length === 0) console.log("   (none) — the shop has no subscription record.");
    subs.forEach((sub) => {
      const feats = sub.features || {};
      const hasWebsite = !!(feats.hosted_website || feats.website_enabled || feats.website);
      console.log(`   - plan="${sub.plan_name}" (${sub.display_name}) | subscription status="${sub.status}" | ${sub.billing_cycle}`);
      console.log(`     period: ${sub.current_period_start} → ${sub.current_period_end}`);
      console.log(`     plan includes hosted website: ${hasWebsite ? "✅ yes (Pro)" : "❌ no (Starter/other)"}`);
    });
  } catch (e) {
    console.log("4. Subscription / plan records: (query failed) " + e.message);
  }

  // ── 5. Suggested fixes ───────────────────────────────────────────────────────
  console.log("");
  if (gatePass) {
    console.log("VERDICT: ELIGIBLE ✅ — the route should be serving HTTP 200. If it isn't,");
    console.log("         check routing/DNS (vercel.json rewrite /:slug → /api/website).");
  } else {
    console.log("VERDICT: NOT ELIGIBLE ❌ — this 404 is the feature gate doing its job.");
    if (!s.website_enabled) {
      console.log("   Fix: enable website_enabled for this shop (Pro plan only).");
      console.log("        → Admin: POST /api/shop  { action: \"toggle-website\", shopId: X, enabled: true }");
      console.log("        → or re-run migration-combined.sql (now backfills eligible shops),");
      console.log("        → or: UPDATE repair_shops SET website_enabled = true WHERE id = " + s.id + ";");
    }
    if (s.subscription_status !== "active") {
      console.log(`   Fix: subscription_status is "${s.subscription_status}" — must be "active".`);
      console.log("        → Complete payment + admin approval, or renew the expired subscription.");
    }
  }
  console.log("=".repeat(80));
}

main().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});

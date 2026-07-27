// scripts/diagnostic.js
// Database diagnostic tool — queries the actual database and reports findings.
// Run: DATABASE_URL=postgres://... node scripts/diagnostic.js
//
// If DATABASE_URL is already set in the environment, just run:
//   node scripts/diagnostic.js

const { neon } = require("@neondatabase/serverless");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is not set.");
    console.error("Run with: DATABASE_URL=postgres://user:pass@host/db node scripts/diagnostic.js");
    process.exit(1);
  }

  const sql = neon(databaseUrl);

  // Mask for display
  const masked = databaseUrl.substring(0, databaseUrl.indexOf("://") + 3) + "***@" + databaseUrl.substring(databaseUrl.lastIndexOf("@") + 1);
  console.log("=".repeat(80));
  console.log("🔍 DATABASE DIAGNOSTIC");
  console.log("=".repeat(80));
  console.log(`Connected to: ${masked}`);
  console.log("");

  // ── 1. Database identity ────────────────────────────────────────────────
  console.log("─".repeat(80));
  console.log("📋 1. DATABASE IDENTITY");
  console.log("─".repeat(80));
  const identity = await sql`
    SELECT current_database() as db, current_schema() as schema, current_user as "user"
  `;
  console.log(`   Database: ${identity[0]?.db}`);
  console.log(`   Schema:   ${identity[0]?.schema}`);
  console.log(`   User:     ${identity[0]?.user}`);
  console.log("");

  // ── 2. Complete table list ─────────────────────────────────────────────
  console.log("─".repeat(80));
  console.log("📋 2. COMPLETE TABLE LIST (public schema)");
  console.log("─".repeat(80));
  const tables = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;

  if (tables.length === 0) {
    console.log("   ⚠️  NO TABLES FOUND in public schema!");
  } else {
    console.log(`   Found ${tables.length} tables:`);
    tables.forEach(t => {
      console.log(`     - ${t.table_name}`);
    });
  }
  console.log("");

  // ── 3. Check promotion_codes specifically ──────────────────────────────
  console.log("─".repeat(80));
  console.log("📋 3. PROMOTION_CODES TABLE CHECK");
  console.log("─".repeat(80));
  const promoTableInfo = await sql`
    SELECT *
    FROM information_schema.tables
    WHERE table_name = 'promotion_codes'
  `;

  if (promoTableInfo.length === 0) {
    console.log("   ❌ TABLE 'promotion_codes' DOES NOT EXIST");
    console.log("");

    // ── 4. Check if TABLE was ever created ────────────────────────────────
    console.log("─".repeat(80));
    console.log("📋 4. FORENSIC ANALYSIS");
    console.log("─".repeat(80));

    // Check if any migration tracking table exists
    const migrationTables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('migrations', '_migrations', 'schema_migrations', 'migration_history')
    `;
    if (migrationTables.length > 0) {
      console.log("   ✅ Migration tracking table(s) found:");
      migrationTables.forEach(t => console.log(`     - ${t.table_name}`));
    } else {
      console.log("   ℹ️  No migration tracking table found - migrations are run manually via scripts.");
    }
    console.log("");

    // Check if promo_code_redemptions exists (it's created in the same migration)
    const redemptionsExists = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'promo_code_redemptions'
      ) as exists
    `;
    console.log(`   Table 'promo_code_redemptions' exists: ${redemptionsExists[0]?.exists === true ? "✅ YES" : "❌ NO"}`);

    // Check if promotion_codes columns exist in other tables (partial migration?)
    const paymentsCol = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name = 'promotion_code_id'
      ) as exists
    `;
    const subsCol = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'subscriptions' AND column_name = 'promotion_code_id'
      ) as exists
    `;
    console.log(`   Column payments.promotion_code_id exists: ${paymentsCol[0]?.exists === true ? "✅ YES" : "❌ NO"}`);
    console.log(`   Column subscriptions.promotion_code_id exists: ${subsCol[0]?.exists === true ? "✅ YES" : "❌ NO"}`);

    // Check subscription_plans existence
    const plansExist = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'subscription_plans'
      ) as exists
    `;
    const usersExist = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      ) as exists
    `;
    const paymentsExist = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'payments'
      ) as exists
    `;
    const subscriptionsExist = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'subscriptions'
      ) as exists
    `;
    console.log("");
    console.log("   📊 Dependency table status:");  
    console.log(`     subscription_plans: ${plansExist[0]?.exists === true ? "✅" : "❌"}  (referenced by FK fk_promo_codes_plan)`);
    console.log(`     users:              ${usersExist[0]?.exists === true ? "✅" : "❌"}  (referenced by FKs for created_by, updated_by)`);
    console.log(`     payments:           ${paymentsExist[0]?.exists === true ? "✅" : "❌"}  (referenced by FK fk_promo_redemptions_payment)`);
    console.log(`     subscriptions:      ${subscriptionsExist[0]?.exists === true ? "✅" : "❌"}  (referenced by FK fk_promo_redemptions_subscription)`);

  } else {
    console.log(`   ✅ TABLE 'promotion_codes' EXISTS!`);
    console.log(`   Table type: ${promoTableInfo[0]?.table_type}`);
    console.log(`   Table catalog: ${promoTableInfo[0]?.table_catalog}`);
    console.log(`   Table schema: ${promoTableInfo[0]?.table_schema}`);

    // Show columns
    console.log("");
    console.log("   📊 Columns:");
    const columns = await sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'promotion_codes'
      ORDER BY ordinal_position
    `;
    columns.forEach(c => {
      console.log(`     ${c.column_name}: ${c.data_type} (nullable: ${c.is_nullable})`);
    });

    // Show row count
    const count = await sql`SELECT COUNT(*) as count FROM promotion_codes`;
    console.log(`   📊 Row count: ${count[0]?.count}`);

    // Show constraints
    const constraints = await sql`
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_schema = 'public' AND table_name = 'promotion_codes'
    `;
    console.log(`   📊 Constraints (${constraints.length}):`);
    constraints.forEach(c => {
      console.log(`     - ${c.constraint_name} (${c.constraint_type})`);
    });
  }

  console.log("");
  console.log("=".repeat(80));
  console.log("✅ DIAGNOSTIC COMPLETE");
  console.log("=".repeat(80));
}

main().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});

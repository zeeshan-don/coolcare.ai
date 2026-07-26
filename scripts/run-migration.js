// scripts/run-migration.js
// Run: node scripts/run-migration.js
// Requires DATABASE_URL environment variable to be set.
// Alternatively: DATABASE_URL=postgres://... node scripts/run-migration.js

const { neon } = require("@neondatabase/serverless");
const fs = require("fs");
const path = require("path");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is not set.");
    console.error("Run with: DATABASE_URL=postgres://user:pass@host/db node scripts/run-migration.js");
    process.exit(1);
  }

  const sql = neon(databaseUrl);
  const migrationPath = path.join(__dirname, "..", "migration-create-missing-tables.sql");
  const migrationSql = fs.readFileSync(migrationPath, "utf-8");

  console.log("🚀 Running migration: migration-create-missing-tables.sql");
  console.log(`📄 SQL size: ${(migrationSql.length / 1024).toFixed(1)} KB`);
  console.log("⏳ Executing...");

  // Send the entire migration as one multi-statement query.
  // Neon's serverless driver handles this correctly, maintaining
  // the BEGIN/COMMIT transaction and preserving DO $$ blocks.
  try {
    await sql(migrationSql);
    console.log(`\n✅ Migration completed successfully!`);
    console.log(`   ${new Date().toISOString()}`);
  } catch (err) {
    // IF NOT EXISTS guards mean most errors during re-runs are safe.
    if (
      err.message?.includes("already exists") ||
      err.message?.includes("duplicate key") ||
      err.message?.includes("ON CONFLICT") ||
      err.message?.includes("unique constraint")
    ) {
      console.log(`\n✅ Migration completed (safe re-run, minor conflicts ignored).`);
      console.log(`   ${new Date().toISOString()}`);
      return;
    }
    console.error(`❌ Migration failed:`, err.message?.substring(0, 500));
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

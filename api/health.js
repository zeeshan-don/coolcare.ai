// api/health.js
// Health check endpoint — verifies DB connectivity and service status.
// GET /api/health
//
// DIAGNOSTIC MODE: When ?diagnostic=true is passed, returns extended
// database/schema/table info to debug "relation does not exist" errors.

const { neon } = require("@neondatabase/serverless");
const { setSecurityHeaders } = require("./_lib/security");

// ─── Masked DATABASE_URL helper (safe for logging) ──────────────────────────
function maskDatabaseUrl(url) {
  if (!url || typeof url !== "string") return "NOT SET";
  const protocolEnd = url.indexOf("://");
  const atIndex = url.lastIndexOf("@");
  if (protocolEnd === -1 || atIndex === -1) return "*** (malformed)";
  return url.substring(0, protocolEnd + 3) + "***@" + url.substring(atIndex + 1);
}

module.exports = async (request, response) => {
  setSecurityHeaders(response);
  const start = Date.now();

  let dbOk = false;
  let diag = { db: null, schema: null, user: null, tables: {} };
  const isDiagnostic = request.query?.diagnostic === "true";

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Basic connectivity check
    await sql`SELECT 1`;
    dbOk = true;

    // ── Always log: database identity (runs on EVERY health check) ─────────
    const info = await sql`
      SELECT current_database() as db, current_schema() as schema, current_user as "user"
    `;
    diag = { ...diag, ...info[0] };
    console.log("[health] Connected to DB:", info[0]?.db, "| Schema:", info[0]?.schema, "| User:", info[0]?.user);

    // ── Always log: promotion_codes table existence ───────────────────────
    const tableCheck = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'promotion_codes'
      ) as exists
    `;
    const promoTableExists = tableCheck[0]?.exists === true;
    console.log("[health] Table promotion_codes:", promoTableExists ? "EXISTS ✓" : "MISSING ✗");

    // ── Extended diagnostic (only when ?diagnostic=true) ───────────────────
    if (isDiagnostic) {
      const criticalTables = [
        "promotion_codes",
        "promo_code_redemptions",
        "subscription_plans",
        "subscriptions",
        "payments",
        "repair_shops",
        "users",
      ];

      //━━ Complete table list ───────────────────────────────────────
      const allTables = await sql`
        SELECT table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `;
      diag.allTables = allTables.map(t => ({
        name: t.table_name,
        type: t.table_type,
      }));

      console.log("[health/diagnostic] ALL TABLES IN public schema:");
      for (const t of allTables) {
        console.log(`  - ${t.table_name} (${t.table_type})`);
      }

      // Also log the count
      console.log(`[health/diagnostic] Total tables: ${allTables.length}`);

      for (const tableName of criticalTables) {
        const rows = await sql`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = ${tableName}
          ) as exists
        `;
        diag.tables[tableName] = rows[0]?.exists === true;
      }

      console.log("[health/diagnostic] All tables:", JSON.stringify(diag.tables));
      console.log("[health/diagnostic] DATABASE_URL (masked):", maskDatabaseUrl(process.env.DATABASE_URL));
    }
  } catch (err) {
    console.error("[health] DB check failed:", err.message);
  }

  const status = dbOk ? "healthy" : "degraded";
  const statusCode = dbOk ? 200 : 503;

  const responseBody = {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: dbOk ? "ok" : "failed",
      whatsapp: process.env.WHATSAPP_ACCESS_TOKEN ? "configured" : "not_configured",
      stripe: process.env.STRIPE_SECRET_KEY ? "configured" : "not_configured",
      razorpay: process.env.RAZORPAY_KEY_ID ? "configured" : "not_configured",
    },
    responseTime: Date.now() - start,
  };

  if (isDiagnostic) {
    responseBody.diagnostics = {
      database: { db: diag.db, schema: diag.schema, user: diag.user },
      tables: diag.tables,
      databaseUrl: maskDatabaseUrl(process.env.DATABASE_URL),
      nodeVersion: process.version,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
    };
  }

  return response.status(statusCode).json(responseBody);
};

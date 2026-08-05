// api/dashboard.js
// Consolidated public endpoints — dashboard, health check, and currency pricing.
// Merged to stay within the Vercel Hobby plan's serverless function limit (12).
//
// Routes (legacy URLs preserved via rewrites in vercel.json):
//   GET /api/dashboard                  → anonymized recent bookings widget
//   GET /api/health  (→ /api/dashboard?route=health)    → health check + diagnostics
//   GET /api/currency (→ /api/dashboard?route=currency) → currency pricing & rates
//   GET /api/tracker  (→ /api/dashboard?route=tracker)  → customer booking tracker
//
// SECURITY: No auth required (public), but dashboard data is anonymized to
// protect tenant privacy. Only masked names, no phone numbers, limited to 8
// recent non-sensitive records. The tracker only reveals a booking to the
// customer who can prove the phone number used at booking time.

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");

const { CURRENCIES, getExchangeRates, detectCurrency, detectCountry, getCountryCurrency, getPlanPricingFromDB } = require("./_lib/currency");
const {
  PLANS,
  getSupportedCurrencies,
  getCurrencyMeta,
  getPrice,
} = require("./_lib/pricing");

// ─── DASHBOARD (public widget) ─────────────────────────────────────────────
// Mask a name: "Jane Doe" -> "Jane D."
function maskName(name) {
  if (!name) return "Customer";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0) + "***";
  return parts[0] + " " + parts[1].charAt(0) + ".";
}

async function handleDashboard(request, response) {
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT
      b.id,
      b.customer_name,
      b.service_type,
      b.area,
      b.status,
      b.created_at,
      t.name AS technician_name
    FROM bookings b
    LEFT JOIN technicians t ON t.id = b.technician_id
    WHERE b.status IN ('open', 'assigned', 'completed', 'on_the_way')
    ORDER BY b.created_at DESC
    LIMIT 8
  `;

  // Anonymize: mask names, strip phone numbers
  const anonymized = rows.map((r) => ({
    id: r.id,
    customer_name: maskName(r.customer_name),
    customer_number: null, // Never expose phone numbers publicly
    service_type: r.service_type,
    area: r.area,
    status: r.status,
    created_at: r.created_at,
    technician_name: r.technician_name,
  }));

  return response.status(200).json({ enquiries: anonymized });
}

// ─── HEALTH CHECK (was api/health.js) ──────────────────────────────────────
// GET /api/health — verifies DB connectivity and service status.
// DIAGNOSTIC MODE: When ?diagnostic=true is passed, returns extended
// database/schema/table info to debug "relation does not exist" errors.

// Masked DATABASE_URL helper (safe for logging)
function maskDatabaseUrl(url) {
  if (!url || typeof url !== "string") return "NOT SET";
  const protocolEnd = url.indexOf("://");
  const atIndex = url.lastIndexOf("@");
  if (protocolEnd === -1 || atIndex === -1) return "*** (malformed)";
  return url.substring(0, protocolEnd + 3) + "***@" + url.substring(atIndex + 1);
}

async function handleHealth(request, response) {
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
}

// ─── CURRENCY PRICING (was api/currency.js) ────────────────────────────────
// GET /api/currency?currency=INR — get pricing in the requested currency
// GET /api/currency?rates=true — get live exchange rates

async function handleCurrency(request, response) {
  const sql = neon(process.env.DATABASE_URL);
  const requestedCurrency = (request.query?.currency || detectCurrency(request)).toUpperCase();
  const currency = CURRENCIES[requestedCurrency] ? requestedCurrency : (requestedCurrency || "USD");

  // Supported currencies = central config ∪ any currency rows in the DB mirror
  const supportedCodes = new Set(getSupportedCurrencies());
  try {
    const currencyRows = await sql`SELECT DISTINCT currency FROM subscription_plan_prices ORDER BY currency`;
    currencyRows.forEach((row) => { if (row.currency) supportedCodes.add(row.currency.toUpperCase()); });
  } catch (err) {
    console.warn("[currency] Could not load supported currencies from DB:", err.message);
  }

  const supported = [...supportedCodes].sort().map(getCurrencyMeta);

  // Detect country from request
  const reqCountry = detectCountry(request);
  const reqCurrency = reqCountry ? getCountryCurrency(reqCountry) : null;

  // ── Build pricing for EVERY active plan from the same source ─────────────
  // DB mirror first (admin-editable at runtime), central config as fallback.
  let pricing = { starter: null, pro: null };
  let source = "config";
  try {
    const planRows = await sql`SELECT id, name FROM subscription_plans WHERE name IN ('starter','pro') AND is_active = true ORDER BY id`;
    if (planRows.length > 0) {
      for (const plan of Object.keys(PLANS)) {
        const planRow = planRows.find((r) => r.name === plan);
        const planId = planRow ? planRow.id : null;
        if (!planId) {
          pricing[plan] = getPricingForCurrencySafe(plan, currency);
          continue;
        }
        const dbPrices = await getPlanPricingFromDB(sql, planId, currency, plan);
        if (dbPrices) {
          pricing[plan] = dbPrices;
          source = "db";
        } else {
          pricing[plan] = getPricingForCurrencySafe(plan, currency);
        }
      }
    } else {
      // Plans table missing/empty — serve straight from the central config
      pricing = getAllPricingForCurrency(currency);
    }
  } catch (err) {
    console.warn("[currency] DB pricing load failed, using central config:", err.message);
    pricing = getAllPricingForCurrency(currency);
  }

  // Safety: never return null pricing for a plan
  for (const plan of Object.keys(PLANS)) {
    if (!pricing[plan]) pricing[plan] = getPricingForCurrencySafe(plan, currency);
  }

  let rates = null;
  if (request.query?.rates === "true") {
    rates = await getExchangeRates("USD");
  }

  return response.status(200).json({
    currency,
    symbol: getCurrencyMeta(currency).symbol,
    pricing, // { starter: {...}, pro: {...} } — same object the backend charges from
    rates,
    supported,
    source, // "db" | "config" — for debugging the pricing chain
    detectedCountry: reqCountry,
    detectedCurrency: reqCurrency,
  });
}

// Pricing for every currency per plan, from the central config.
function getAllPricingForCurrency(currency) {
  const out = {};
  for (const plan of Object.keys(PLANS)) {
    out[plan] = {
      monthly: getPrice(plan, "monthly", currency),
      quarterly: getPrice(plan, "quarterly", currency),
      halfyearly: getPrice(plan, "halfyearly", currency),
      yearly: getPrice(plan, "yearly", currency),
    };
  }
  return out;
}

function getPricingForCurrencySafe(plan, currency) {
  return {
    monthly: getPrice(plan, "monthly", currency),
    quarterly: getPrice(plan, "quarterly", currency),
    halfyearly: getPrice(plan, "halfyearly", currency),
    yearly: getPrice(plan, "yearly", currency),
  };
}

// ─── ROUTER ────────────────────────────────────────────────────────────────
// Dispatch by ?route= (legacy URLs are rewritten in vercel.json):
//   /api/health   → ?route=health
//   /api/currency → ?route=currency
//   default       → dashboard widget

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);

  const route = request.query?.route;

  // Health check — preserved with its original semantics: no method
  // restriction and no rate limit (uptime monitors may poll it freely).
  if (route === "health") return handleHealth(request, response);

  if (!allowMethods(request, response, "GET")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  if (route === "currency") return handleCurrency(request, response);

  return handleDashboard(request, response);
});

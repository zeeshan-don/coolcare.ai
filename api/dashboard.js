// api/dashboard.js
// Consolidated public endpoints — dashboard, health check, and currency pricing.
// Merged to stay within the Vercel Hobby plan's serverless function limit (12).
//
// Routes (legacy URLs preserved via rewrites in vercel.json):
//   GET /api/dashboard                  → anonymized recent bookings widget
//   GET /api/health  (→ /api/dashboard?route=health)    → health check + diagnostics
//   GET /api/currency (→ /api/dashboard?route=currency) → currency pricing & rates
//
// SECURITY: No auth required (public), but dashboard data is anonymized to
// protect tenant privacy. Only masked names, no phone numbers, limited to 8
// recent non-sensitive records.

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { CURRENCIES, PLAN_PRICING, getExchangeRates, detectCurrency, detectCountry, getCountryCurrency, getPlanPricingFromDB } = require("./_lib/currency");

// ─── DASHBOARD (public widget) ─────────────────────────────────────────────
// Mask a name: "Rajesh Kumar" -> "Rajesh K."
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

const currencyMeta = (code) => ({
  code,
  symbol: CURRENCIES[code]?.symbol || code,
  name: CURRENCIES[code]?.name || code,
});

async function handleCurrency(request, response) {
  const sql = neon(process.env.DATABASE_URL);
  const requestedCurrency = (request.query?.currency || detectCurrency(request)).toUpperCase();
  const currency = CURRENCIES[requestedCurrency] ? requestedCurrency : requestedCurrency || "USD";

  const supportedCodes = new Set(Object.keys(CURRENCIES));
  try {
    const currencyRows = await sql`SELECT DISTINCT currency FROM subscription_plan_prices ORDER BY currency`;
    currencyRows.forEach((row) => { if (row.currency) supportedCodes.add(row.currency.toUpperCase()); });
  } catch (err) {
    console.warn("[currency] Could not load supported currencies from DB:", err.message);
  }

  const supported = [...supportedCodes].sort().map(currencyMeta);

  let pricing = { pro: null };
  let detectedCountry = null;

  // Detect country from request
  const reqCountry = detectCountry(request);
  const reqCurrency = reqCountry ? getCountryCurrency(reqCountry) : null;

  // Try to load pricing from DB first, fall back to PLAN_PRICING constant
  try {
    const planRows = await sql`SELECT id FROM subscription_plans WHERE name = 'pro' AND is_active = true LIMIT 1`;
    if (planRows.length > 0) {
      const planId = planRows[0].id;
      const dbPrices = await getPlanPricingFromDB(sql, planId, currency);
      if (dbPrices) {
        pricing.pro = { ...dbPrices };

        // Also load all supported currencies for the frontend country selector
        const allPrices = await sql`
          SELECT spp.currency, spp.price_monthly, spp.price_quarterly, spp.price_halfyearly, spp.price_yearly
          FROM subscription_plan_prices spp
          JOIN subscription_plans sp ON sp.id = spp.plan_id
          WHERE sp.name = 'pro' AND spp.active = true
          ORDER BY spp.currency
        `;
        if (allPrices.length > 0) {
          pricing.all = {};
          allPrices.forEach(row => {
            pricing.all[row.currency] = {
              monthly: parseFloat(row.price_monthly),
              quarterly: parseFloat(row.price_quarterly),
              halfyearly: parseFloat(row.price_halfyearly),
              yearly: parseFloat(row.price_yearly),
            };
          });
        }
      }
    }
  } catch (err) {
    console.warn("[currency] DB pricing load failed, using fallback:", err.message);
  }

  // Fallback: use PLAN_PRICING constant if DB failed
  if (!pricing.pro) {
    const prices = PLAN_PRICING[currency];
    if (prices) {
      pricing.pro = { ...prices };
    } else {
      // Unknown currency — derive from USD using live exchange rates
      try {
        const { convertPrice } = require("./_lib/currency");
        const usd = PLAN_PRICING.USD;
        const [monthly, quarterly, halfyearly, yearly] = await Promise.all([
          convertPrice(usd.monthly, currency),
          convertPrice(usd.quarterly, currency),
          convertPrice(usd.halfyearly, currency),
          convertPrice(usd.yearly, currency),
        ]);
        pricing.pro = { monthly: monthly.amount, quarterly: quarterly.amount, halfyearly: halfyearly.amount, yearly: yearly.amount };
      } catch (err) {
        console.error("[currency] Conversion failed for unknown currency:", currency, err.message);
        pricing.pro = { ...PLAN_PRICING.USD };
      }
    }
  }

  let rates = null;
  if (request.query?.rates === "true") {
    rates = await getExchangeRates("USD");
  }

  return response.status(200).json({
    currency,
    symbol: CURRENCIES[currency]?.symbol || currency,
    pricing,
    rates,
    supported,
    detectedCountry: reqCountry,
    detectedCurrency: reqCurrency,
  });
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

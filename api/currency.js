// api/currency.js
// Public API for currency pricing and supported currency metadata.
// GET /api/currency?currency=INR — get pricing in the requested currency
// GET /api/currency?rates=true — get live exchange rates

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { CURRENCIES, PLAN_PRICING, getExchangeRates, detectCurrency } = require("./_lib/currency");

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "GET")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  const sql = neon(process.env.DATABASE_URL);
  const requestedCurrency = (request.query?.currency || detectCurrency(request)).toUpperCase();
  const currency = CURRENCIES[requestedCurrency] ? requestedCurrency : requestedCurrency || "USD";

  const currencyMeta = (code) => ({
    code,
    symbol: CURRENCIES[code]?.symbol || code,
    name: CURRENCIES[code]?.name || code,
  });

  const supportedCodes = new Set(Object.keys(CURRENCIES));
  try {
    const currencyRows = await sql`SELECT DISTINCT currency FROM subscription_plan_prices ORDER BY currency`;
    currencyRows.forEach((row) => { if (row.currency) supportedCodes.add(row.currency.toUpperCase()); });
  } catch (err) {
    console.warn("[currency] Could not load supported currencies from DB:", err.message);
  }

  const supported = [...supportedCodes].sort().map(currencyMeta);

  let pricing = { pro: null };

  // Use authoritative pricing from PLAN_PRICING constant — no DB lookup needed.
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
  });
});

// api/currency.js
// Public API for currency pricing and supported currency metadata.
// GET /api/currency?currency=INR — get pricing in the requested currency
// GET /api/currency?rates=true — get live exchange rates

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { CURRENCIES, convertPrice, getExchangeRates, detectCurrency } = require("./_lib/currency");

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

  let pricing = {
    starter: { monthly: null, quarterly: null, halfyearly: null, yearly: null },
    professional: { monthly: null, quarterly: null, halfyearly: null, yearly: null },
    enterprise: { monthly: null, quarterly: null, halfyearly: null, yearly: null },
  };

  try {
    const rows = await sql`
      SELECT sp.name as plan_name,
             sp.price_monthly_usd,
             sp.price_quarterly_usd,
             sp.price_halfyearly_usd,
             sp.price_yearly_usd,
             spp.price_monthly,
             spp.price_quarterly,
             spp.price_halfyearly,
             spp.price_yearly
      FROM subscription_plans sp
      LEFT JOIN subscription_plan_prices spp
        ON sp.id = spp.plan_id AND spp.currency = ${currency}
      WHERE sp.is_active = true
      ORDER BY sp.id
    `;

    for (const row of rows) {
      const plan = row.plan_name;
      if (!plan) continue;
      const hasCustom = row.price_monthly !== null && row.price_monthly !== undefined;
      if (hasCustom) {
        pricing[plan] = {
          monthly: parseFloat(row.price_monthly),
          quarterly: parseFloat(row.price_quarterly),
          halfyearly: parseFloat(row.price_halfyearly),
          yearly: parseFloat(row.price_yearly),
        };
      } else {
        const monthlyUsd = parseFloat(row.price_monthly_usd || 0);
        const quarterlyUsd = parseFloat(row.price_quarterly_usd || monthlyUsd * 3 * 0.9);
        const halfyearlyUsd = parseFloat(row.price_halfyearly_usd || monthlyUsd * 6 * 0.85);
        const yearlyUsd = parseFloat(row.price_yearly_usd || monthlyUsd * 12 * 0.8);
        if (currency === "USD") {
          pricing[plan] = {
            monthly: monthlyUsd,
            quarterly: quarterlyUsd,
            halfyearly: halfyearlyUsd,
            yearly: yearlyUsd,
          };
        } else {
          const [monthly, quarterly, halfyearly, yearly] = await Promise.all([
            convertPrice(monthlyUsd, currency),
            convertPrice(quarterlyUsd, currency),
            convertPrice(halfyearlyUsd, currency),
            convertPrice(yearlyUsd, currency),
          ]).then((results) => results.map((r) => r.amount));
          pricing[plan] = { monthly, quarterly, halfyearly, yearly };
        }
      }
    }
  } catch (err) {
    console.error("[currency] Pricing query failed:", err.message);
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

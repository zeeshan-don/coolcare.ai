// api/currency.js
// Public API for currency exchange rates and pricing.
// GET /api/currency?currency=INR — get pricing in target currency
// GET /api/currency?rates=true — get live exchange rates

const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { CURRENCIES, getPricing, getExchangeRates, detectCurrency } = require("./_lib/currency");

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "GET")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  const currency = (request.query?.currency || detectCurrency(request)).toUpperCase();
  const validCurrency = CURRENCIES[currency] ? currency : "USD";

  // Return pricing for the requested currency
  const pricing = await getPricing(validCurrency);

  // Optionally return rates
  let rates = null;
  if (request.query?.rates === "true") {
    rates = await getExchangeRates("USD");
  }

  return response.status(200).json({
    currency: validCurrency,
    symbol: CURRENCIES[validCurrency]?.symbol || "$",
    pricing,
    rates,
    supported: Object.keys(CURRENCIES),
  });
});

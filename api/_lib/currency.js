// api/_lib/currency.js
// Multi-currency support with live exchange rates.
// Single CoolCare Pro plan with exact per-currency pricing.

const CURRENCIES = {
  USD: { symbol: "$", name: "US Dollar", locale: "en-US" },
  INR: { symbol: "₹", name: "Indian Rupee", locale: "en-IN" },
  KWD: { symbol: "KD", name: "Kuwaiti Dinar", locale: "ar-KW" },
  AED: { symbol: "د.إ", name: "UAE Dirham", locale: "ar-AE" },
};

// CoolCare Pro — exact prices per currency per billing cycle.
// These are the authoritative prices shown to customers.
// Quarterly = monthly × 3 × 0.90, Half-Yearly = × 6 × 0.85, Yearly = × 12 × 0.80
const PLAN_PRICING = {
  USD: { monthly: 20, quarterly: 54, halfyearly: 102, yearly: 192 },
  INR: { monthly: 1299, quarterly: 3156, halfyearly: 6625, yearly: 12470 },
  AED: { monthly: 75, quarterly: 202.5, halfyearly: 382.5, yearly: 720 },
  KWD: { monthly: 6, quarterly: 16.2, halfyearly: 30.6, yearly: 57.6 },
};

// Fallback exchange rates (updated periodically via API)
// These are used if the live rate fetch fails
const FALLBACK_RATES = {
  USD: 1,
  INR: 83.5,
  KWD: 0.31,
  AED: 3.67,
};

// Cache for live rates (in-memory, refreshed every hour)
let rateCache = { rates: null, fetchedAt: 0 };
const RATE_CACHE_TTL = 3600000; // 1 hour

/**
 * Fetch live exchange rates from a free API.
 * Falls back to hardcoded rates if the API fails.
 */
async function getExchangeRates(baseCurrency = "USD") {
  const now = Date.now();
  if (rateCache.rates && now - rateCache.fetchedAt < RATE_CACHE_TTL) {
    return rateCache.rates;
  }

  try {
    const res = await fetch(
      `https://open.er-api.com/v6/latest/${baseCurrency}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.rates) {
        rateCache = { rates: data.rates, fetchedAt: now };
        return data.rates;
      }
    }
  } catch (err) {
    console.warn("[currency] Live rate fetch failed, using fallback:", err.message);
  }

  return FALLBACK_RATES;
}

/**
 * Convert a USD amount to the target currency.
 * @param {number} amountUsd - Amount in USD
 * @param {string} targetCurrency - Target currency code (USD, INR, KWD, AED)
 * @returns {Promise<{ amount: number, formatted: string, rate: number }>}
 */
async function convertPrice(amountUsd, targetCurrency = "USD") {
  const currency = CURRENCIES[targetCurrency] || CURRENCIES.USD;

  if (targetCurrency === "USD") {
    return {
      amount: amountUsd,
      formatted: `$${amountUsd.toFixed(2)}`,
      rate: 1,
    };
  }

  const rates = await getExchangeRates("USD");
  const rate = rates[targetCurrency] || FALLBACK_RATES[targetCurrency] || 1;
  const converted = amountUsd * rate;

  return {
    amount: Math.round(converted * 100) / 100,
    formatted: `${currency.symbol}${converted.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`,
    rate,
  };
}

/**
 * Get CoolCare Pro pricing for a target currency.
 * Returns exact prices from PLAN_PRICING if available, otherwise converts from USD.
 */
async function getPricing(currency = "USD") {
  const prices = PLAN_PRICING[currency];
  if (prices) {
    return { pro: prices };
  }
  // Unknown currency — convert from USD base
  const usd = PLAN_PRICING.USD;
  const converted = {};
  for (const [cycle, amount] of Object.entries(usd)) {
    const result = await convertPrice(amount, currency);
    converted[cycle] = result.amount;
  }
  return { pro: converted };
}

/**
 * Detect user's currency from their country/locale.
 * Falls back to USD.
 */
function detectCurrency(request) {
  // Check explicit header first
  const headerCurrency = request.headers["x-currency"];
  if (headerCurrency && CURRENCIES[headerCurrency.toUpperCase()]) {
    return headerCurrency.toUpperCase();
  }

  // Try to detect from Accept-Language or country headers
  const country = (request.headers["x-vercel-ip-country"] || "").toUpperCase();
  const countryMap = {
    IN: "INR",
    KW: "KWD",
    AE: "AED",
    US: "USD",
    GB: "USD",
    CA: "USD",
    AU: "USD",
  };

  return countryMap[country] || "USD";
}

module.exports = {
  CURRENCIES,
  PLAN_PRICING,
  FALLBACK_RATES,
  getExchangeRates,
  convertPrice,
  getPricing,
  detectCurrency,
};

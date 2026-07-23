// api/_lib/currency.js
// Multi-currency support with live exchange rates.
// Prices stored in USD base, converted dynamically for display.

const CURRENCIES = {
  USD: { symbol: "$", name: "US Dollar", locale: "en-US" },
  INR: { symbol: "₹", name: "Indian Rupee", locale: "en-IN" },
  KWD: { symbol: "KD", name: "Kuwaiti Dinar", locale: "ar-KW" },
  AED: { symbol: "د.إ", name: "UAE Dirham", locale: "ar-AE" },
};

// Base prices in USD — all conversions derive from these
const BASE_PRICES_USD = {
  starter_monthly: 29,
  starter_yearly: 290,
  professional_monthly: 59,
  professional_yearly: 590,
  enterprise_monthly: 149,
  enterprise_yearly: 1490,
  // Legacy single plan
  legacy_monthly: 59,
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
 * Get all pricing plans converted to a target currency.
 */
async function getPricing(currency = "USD") {
  const plans = {};
  for (const [key, usdPrice] of Object.entries(BASE_PRICES_USD)) {
    plans[key] = await convertPrice(usdPrice, currency);
  }
  return plans;
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
  BASE_PRICES_USD,
  FALLBACK_RATES,
  getExchangeRates,
  convertPrice,
  getPricing,
  detectCurrency,
};

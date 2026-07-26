// api/_lib/currency.js
// Multi-currency support with live exchange rates and IP-based country detection.
// Single CoolCare Pro plan with exact per-currency pricing.
// IMPORTANT: Production pricing is read from subscription_plan_prices DB table.
// PLAN_PRICING constant is a fallback only.

// Country → Currency mapping (used for IP-based detection)
const COUNTRY_CURRENCY_MAP = {
  IN: "INR", // India
  AE: "AED", // United Arab Emirates
  KW: "KWD", // Kuwait
  // All other countries → USD
};

// Currency metadata (symbols, names, locales)
const CURRENCIES = {
  USD: { symbol: "$", name: "US Dollar", locale: "en-US" },
  INR: { symbol: "₹", name: "Indian Rupee", locale: "en-IN" },
  KWD: { symbol: "KD", name: "Kuwaiti Dinar", locale: "ar-KW" },
  AED: { symbol: "د.إ", name: "UAE Dirham", locale: "ar-AE" },
};

// Billing cycle discounts (applied to total cycle amounts)
const BILLING_DISCOUNTS = {
  monthly: 0,       // 0% discount (base price)
  quarterly: 10,    // -10%
  halfyearly: 15,   // -15%
  yearly: 20,       // -20%
};

// CoolCare Pro — exact prices per currency per billing cycle.
// These are used as fallback if the DB lookup fails.
// The authoritative source is the subscription_plan_prices table.
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
 * Get currency for a given country code.
 * @param {string} countryCode - ISO 3166-1 alpha-2 country code (e.g., 'IN', 'AE')
 * @returns {string} Currency code (INR, AED, KWD, or USD for all others)
 */
function getCountryCurrency(countryCode) {
  if (!countryCode) return "USD";
  return COUNTRY_CURRENCY_MAP[countryCode.toUpperCase()] || "USD";
}

/**
 * Get country name for display purposes.
 */
function getCountryName(countryCode) {
  const names = {
    IN: "India",
    AE: "United Arab Emirates",
    KW: "Kuwait",
    US: "United States",
    GB: "United Kingdom",
    CA: "Canada",
    AU: "Australia",
    SG: "Singapore",
    MY: "Malaysia",
    SA: "Saudi Arabia",
    QA: "Qatar",
    BH: "Bahrain",
    OM: "Oman",
  };
  return names[countryCode?.toUpperCase()] || countryCode || "Unknown";
}

/**
 * Detect user's country from request headers (IP geolocation).
 * Falls back to null (will default to USD pricing).
 */
function detectCountry(request) {
  // x-vercel-ip-country is set by Vercel edge network
  const country = (request.headers["x-vercel-ip-country"] || "").toUpperCase();
  if (country && /^[A-Z]{2}$/.test(country)) return country;

  // Try Cloudflare header
  const cfCountry = (request.headers["cf-ipcountry"] || "").toUpperCase();
  if (cfCountry && /^[A-Z]{2}$/.test(cfCountry)) return cfCountry;

  // Try Accept-Language header for hints
  const acceptLang = request.headers["accept-language"] || "";
  if (acceptLang) {
    const match = acceptLang.match(/[_-]([A-Za-z]{2})(?:[;,]|$)/);
    if (match) {
      const localeCountry = match[1].toUpperCase();
      return localeCountry;
    }
  }

  return null;
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

  // Detect from country
  const country = detectCountry(request);
  if (country) {
    return getCountryCurrency(country);
  }

  return "USD";
}

/**
 * Fetch pricing for a plan from the database.
 * Falls back to PLAN_PRICING constant.
 */
async function getPlanPricingFromDB(sql, planId, currency) {
  try {
    const rows = await sql`
      SELECT price_monthly, price_quarterly, price_halfyearly, price_yearly
      FROM subscription_plan_prices
      WHERE plan_id = ${planId} AND currency = ${currency} AND active = true
      LIMIT 1
    `;
    if (rows.length > 0) {
      return {
        monthly: parseFloat(rows[0].price_monthly),
        quarterly: parseFloat(rows[0].price_quarterly),
        halfyearly: parseFloat(rows[0].price_halfyearly),
        yearly: parseFloat(rows[0].price_yearly),
      };
    }
  } catch (err) {
    console.warn("[currency] DB pricing lookup failed:", err.message);
  }
  // Fallback to hardcoded pricing
  return PLAN_PRICING[currency] || PLAN_PRICING.USD;
}

module.exports = {
  CURRENCIES,
  PLAN_PRICING,
  FALLBACK_RATES,
  BILLING_DISCOUNTS,
  COUNTRY_CURRENCY_MAP,
  getExchangeRates,
  convertPrice,
  getPricing,
  detectCurrency,
  detectCountry,
  getCountryCurrency,
  getCountryName,
  getPlanPricingFromDB,
};

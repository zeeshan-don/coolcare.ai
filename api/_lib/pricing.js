// api/_lib/pricing.js
// ═══════════════════════════════════════════════════════════════════════════
// COOLCARE — THE SINGLE SOURCE OF TRUTH FOR ALL SUBSCRIPTION PRICING
// ═══════════════════════════════════════════════════════════════════════════
// EVERY price shown or charged anywhere in the product comes from this file:
//   • Public pricing page  (index.html)             → GET /api/currency
//   • Signup page          (shop-signup.html)       → GET /api/currency
//   • Renewal page         (shop-subscription.html) → GET /api/currency
//   • Checkout amount      (api/payments/index.js)  → calculateAmount()
//   • Signup amount        (api/auth.js)            → calculateAmount()
//   • Razorpay / Stripe    (api/_lib/gateway.js)    → createOrder()
//   • Promo validation     (api/promotions.js)      → pricing config
//   • DB seeding           (migration-combined.sql + scripts/sync-pricing.js)
//
// HOW TO CHANGE A PRICE:
//   Edit PRICES below, then run `node scripts/sync-pricing.js` to push the
//   change into the subscription_plan_prices table (the runtime mirror that
//   the backend reads first). Or change prices at runtime via the admin
//   dashboard "Pricing" tab — that writes to the same DB table.
//
// RULE: Never hardcode a price anywhere else. If you need a price, import
// from here (server) or fetch it from GET /api/currency (frontend).
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

// ─── Billing cycles ──────────────────────────────────────────────────────────
const BILLING_CYCLES = ["monthly", "quarterly", "halfyearly", "yearly"];

const BILLING_CYCLE_LABELS = {
  monthly: "/month",
  quarterly: "/quarter",
  halfyearly: "/6 months",
  yearly: "/year",
};

// Discount vs monthly when paying in bulk (used for display badges only —
// the actual prices below are already the discounted amounts).
const BILLING_CYCLE_DISCOUNTS = {
  monthly: 0,
  quarterly: 10,
  halfyearly: 15,
  yearly: 20,
};

// ─── Supported currencies ────────────────────────────────────────────────────
const CURRENCIES = {
  USD: { symbol: "$", name: "US Dollar" },
  INR: { symbol: "₹", name: "Indian Rupee" },
  AED: { symbol: "د.إ", name: "UAE Dirham" },
  KWD: { symbol: "KD", name: "Kuwaiti Dinar" },
};

// Fixed conversion rates used ONLY to derive prices for currencies that are
// not explicitly listed in PRICES (and as a safety net when the live-rate
// API is unreachable). USD is the international base price.
const FALLBACK_RATES = {
  USD: 1,
  INR: 83.5,
  AED: 3.67,
  KWD: 0.31,
};

// ─── Plans ───────────────────────────────────────────────────────────────────
const PLANS = {
  starter: {
    name: "starter",
    displayName: "CoolCare Starter",
    tagline: "Everything you need to grow",
    hostedWebsite: false,
    features: [
      "WhatsApp AI assistant",
      "Live booking dashboard",
      "Unlimited technicians",
      "Automated booking flow",
      "Reminders & follow-ups",
      "Growth analytics",
      "Priority support",
      "Custom AI responses",
    ],
  },
  pro: {
    name: "pro",
    displayName: "CoolCare Pro",
    tagline: "Everything in Starter, plus your own hosted website",
    hostedWebsite: true,
    features: [
      "Everything in CoolCare Starter",
      "Hosted AI Website",
      "AI Website Chat",
      "Public Online Booking Page",
      "Website Hosting",
      "Custom Website Address (Slug)",
      "Website Branding & Customization",
    ],
  },
};

// ─── PRICES — THE ONLY PLACE PRICES ARE DEFINED ──────────────────────────────
// Exact published prices per plan / currency / billing cycle.
//
//   Starter:                 Monthly  Quarterly  Half-Yearly  Yearly
//     International (USD)      $20      $54        $102         $192
//     India (INR)              ₹1300    ₹3500      ₹6600        ₹12500
//     UAE (AED)                72       194.4      367.2        691.2
//     Kuwait (KWD)             6        16.2       30.6         57.6
//
//   Pro:                     Monthly  Quarterly  Half-Yearly  Yearly
//     International (USD)      $25      $68        $128         $240
//     India (INR)              ₹1700    ₹4600      ₹8700        ₹16500
//     UAE (AED)                90       244.8      460.8        864
//     Kuwait (KWD)             7.5      20.4       38.4         72
const PRICES = {
  starter: {
    USD: { monthly: 20, quarterly: 54, halfyearly: 102, yearly: 192 },
    INR: { monthly: 1300, quarterly: 3500, halfyearly: 6600, yearly: 12500 },
    AED: { monthly: 72, quarterly: 194.4, halfyearly: 367.2, yearly: 691.2 },
    KWD: { monthly: 6, quarterly: 16.2, halfyearly: 30.6, yearly: 57.6 },
  },
  pro: {
    USD: { monthly: 25, quarterly: 68, halfyearly: 128, yearly: 240 },
    INR: { monthly: 1700, quarterly: 4600, halfyearly: 8700, yearly: 16500 },
    AED: { monthly: 90, quarterly: 244.8, halfyearly: 460.8, yearly: 864 },
    KWD: { monthly: 7.5, quarterly: 20.4, halfyearly: 38.4, yearly: 72 },
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePlan(plan) {
  const p = String(plan || "pro").toLowerCase();
  return p === "starter" ? "starter" : "pro";
}

function getPlan(plan) {
  return PLANS[normalizePlan(plan)];
}

function getPlanLabel(plan) {
  return getPlan(plan).displayName;
}

function getPlanFeatures(plan) {
  return getPlan(plan).features || [];
}

function planHasWebsite(plan) {
  return !!getPlan(plan).hostedWebsite;
}

function getBillingCycles() {
  return [...BILLING_CYCLES];
}

function getBillingCycleLabel(cycle) {
  return BILLING_CYCLE_LABELS[cycle] || "/month";
}

function getBillingCycleDiscount(cycle) {
  return BILLING_CYCLE_DISCOUNTS[cycle] || 0;
}

function getSupportedCurrencies() {
  return Object.keys(CURRENCIES);
}

function getCurrencyMeta(code) {
  const c = String(code || "USD").toUpperCase();
  const meta = CURRENCIES[c];
  return meta ? { code: c, symbol: meta.symbol, name: meta.name } : { code: c, symbol: c, name: c };
}

/**
 * Get the exact price for a plan / billing cycle / currency.
 * Explicit prices (USD, INR, AED, KWD) are returned as published.
 * Any other currency is derived from the USD base using FALLBACK_RATES.
 *
 * @returns {number} The amount in the requested currency (never null).
 */
function getPrice(plan, billingCycle, currency) {
  const p = PRICES[normalizePlan(plan)];
  const c = String(currency || "USD").toUpperCase();
  const cycle = BILLING_CYCLES.includes(billingCycle) ? billingCycle : "monthly";

  if (p && p[c]) {
    return typeof p[c][cycle] === "number" ? p[c][cycle] : p[c].monthly;
  }

  // Unknown currency — convert from the USD base price.
  const usdValue = p ? p.USD[cycle] : PRICES.pro.USD.monthly;
  const rate = FALLBACK_RATES[c] || 1;
  return Math.round(usdValue * rate * 100) / 100;
}

/**
 * All prices for a single currency: { starter: {monthly,...}, pro: {...} }.
 */
function getPricingForCurrency(currency) {
  const c = String(currency || "USD").toUpperCase();
  const out = {};
  for (const plan of Object.keys(PLANS)) {
    out[plan] = {};
    for (const cycle of BILLING_CYCLES) {
      out[plan][cycle] = getPrice(plan, cycle, c);
    }
  }
  return out;
}

/**
 * Full pricing table: { starter: { USD: {...}, INR: {...}, ... }, pro: {...} }.
 * Returns a deep copy so callers can never mutate the config.
 */
function getAllPricing() {
  return JSON.parse(JSON.stringify(PRICES));
}

/**
 * Strict comparison used for checkout verification (allows 1 paisa / 1 cent
 * of float rounding, never a real price difference).
 */
function pricesMatch(a, b, tolerance = 0.011) {
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

function formatPrice(currency, amount, { compact = false } = {}) {
  const meta = getCurrencyMeta(currency);
  const n = Number(amount || 0);
  const decimals = Number.isInteger(n) ? 0 : 2;
  const formatted = n.toLocaleString("en-US", {
    minimumFractionDigits: compact ? 0 : decimals,
    maximumFractionDigits: decimals,
  });
  return `${meta.symbol}${formatted}`;
}

module.exports = {
  BILLING_CYCLES,
  BILLING_CYCLE_LABELS,
  BILLING_CYCLE_DISCOUNTS,
  CURRENCIES,
  FALLBACK_RATES,
  PLANS,
  PRICES,
  normalizePlan,
  getPlan,
  getPlanLabel,
  getPlanFeatures,
  planHasWebsite,
  getBillingCycles,
  getBillingCycleLabel,
  getBillingCycleDiscount,
  getSupportedCurrencies,
  getCurrencyMeta,
  getPrice,
  getPricingForCurrency,
  getAllPricing,
  pricesMatch,
  formatPrice,
};

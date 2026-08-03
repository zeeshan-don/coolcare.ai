// api/_lib/gateway.js
// Payment gateway configuration — strategy pattern.
// Reads config from payment_gateways table, decrypts secrets, provides
// a unified interface for creating orders and verifying webhooks.
// Future gateways (PayPal, PhonePe, Cashfree) can be added here without
// changing any other code.

const { neon } = require("@neondatabase/serverless");
const { decrypt } = require("./encrypt");
const { PLAN_PRICING, getPlanPricingFromDB } = require("./currency");
const { getAppBaseUrl } = require("./config");

// ─── Config cache (5 min TTL) ───────────────────────────────────────────────
let gwCache = { data: null, fetchedAt: 0 };
const CACHE_TTL = 300000; // 5 minutes

/**
 * Load all gateway configurations from DB.
 * Returns array of { provider, display_name, is_enabled, is_test_mode, keyId, keySecret, webhookSecret, ... }
 */
async function loadGateways(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && gwCache.data && now - gwCache.fetchedAt < CACHE_TTL) {
    return gwCache.data;
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT id, provider, display_name, is_enabled, is_test_mode,
             key_id, key_secret, webhook_secret, extra_config, priority
      FROM payment_gateways ORDER BY priority ASC
    `;
    gwCache = { data: rows, fetchedAt: now };
    return rows;
  } catch (err) {
    console.warn("[gateway] Could not load gateways from DB:", err.message);
    return [];
  }
}

/**
 * Get a specific gateway's decrypted configuration.
 * Returns null if not found or not enabled.
 */
async function getGateway(provider, includeDisabled = false) {
  const gateways = await loadGateways();
  const gw = gateways.find(g => g.provider === provider);
  if (!gw) return null;
  if (!includeDisabled && !gw.is_enabled) return null;
  return {
    id: gw.id,
    provider: gw.provider,
    displayName: gw.display_name,
    isEnabled: gw.is_enabled,
    isTestMode: gw.is_test_mode,
    keyId: decrypt(gw.key_id),
    keySecret: decrypt(gw.key_secret),
    webhookSecret: decrypt(gw.webhook_secret),
    extraConfig: gw.extra_config || {},
    priority: gw.priority,
  };
}

/**
 * Get the first enabled gateway (highest priority = lowest number).
 * Falls back to env vars if no DB gateway is configured.
 */
async function getActiveGateway() {
  const gateways = await loadGateways();
  const enabled = gateways.filter(g => g.is_enabled);
  if (enabled.length > 0) {
    const gw = enabled[0];
    return {
      id: gw.id,
      provider: gw.provider,
      displayName: gw.display_name,
      isEnabled: true,
      isTestMode: gw.is_test_mode,
      keyId: decrypt(gw.key_id),
      keySecret: decrypt(gw.key_secret),
      webhookSecret: decrypt(gw.webhook_secret),
      extraConfig: gw.extra_config || {},
    };
  }
  // Fallback: check env vars
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    return {
      id: null,
      provider: "razorpay",
      displayName: "Razorpay (env)",
      isEnabled: true,
      isTestMode: true,
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || null,
      extraConfig: {},
    };
  }
  if (process.env.STRIPE_SECRET_KEY) {
    return {
      id: null,
      provider: "stripe",
      displayName: "Stripe (env)",
      isEnabled: true,
      isTestMode: process.env.STRIPE_SECRET_KEY.startsWith("sk_test"),
      keyId: null,
      keySecret: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
      extraConfig: {},
    };
  }
  return null;
}

/**
 * Calculate the payment amount for a given plan, billing cycle, and currency.
 * Uses the subscription_plan_prices DB table as authoritative source.
 * Falls back to PLAN_PRICING constant if DB is unavailable.
 *
 * @param {object} sql - Neon database client (optional, falls back to constant without it)
 * @param {string} currency - Currency code (INR, USD, AED, KWD)
 * @param {string} billingCycle - Billing cycle (monthly, quarterly, halfyearly, yearly)
 * @param {number} planId - Plan ID (defaults to 1 for 'pro' plan)
 * @returns {Promise<{ amount: number, currency: string }>}
 */
async function calculateAmount(sql, currency, billingCycle, planId = 1) {
  // If we have a DB connection, try to fetch from DB first
  if (sql && typeof sql === 'function') {
    try {
      const prices = await getPlanPricingFromDB(sql, planId, currency);
      if (prices) {
        return { amount: prices[billingCycle] || prices.monthly, currency };
      }
    } catch (err) {
      console.warn("[gateway] DB calculateAmount failed, using fallback:", err.message);
    }
  }

  // Fallback to hardcoded PLAN_PRICING constant
  const prices = PLAN_PRICING[currency];
  if (!prices) {
    return { amount: PLAN_PRICING.USD[billingCycle] || PLAN_PRICING.USD.monthly, currency: "USD" };
  }
  return { amount: prices[billingCycle] || prices.monthly, currency };
}

/**
 * Get the Razorpay amount in paise (smallest unit).
 * INR is already in smallest unit (paise) for Razorpay.
 * Other currencies: amount × 100.
 */
function toRazorpayAmount(amount, currency) {
  // Razorpay expects amount in paise (for INR) or smallest unit × 100
  return Math.round(amount * 100);
}

// ─── Strategy: Create Order ─────────────────────────────────────────────────
/**
 * Create a payment order/checkout session using the active gateway.
 * IMPORTANT SECURITY: The `amount` parameter MUST come from a DB-verified source
 * (calculated by handleCheckout or handleSignup which read from subscription_plan_prices).
 * We use the provided amount directly — NEVER recalculate or trust frontend amounts here.
 *
 * Returns: { gateway, checkoutUrl | orderId, amount, currency, keyId, invoiceNumber }
 */
async function createOrder({ shopId, billingCycle, currency, amount, invoiceNumber, paymentDbId, originUrl }) {
  const gw = await getActiveGateway();
  if (!gw) {
    return { gateway: "none", message: "No payment gateway configured." };
  }

  // SECURITY: Use the DB-verified amount passed by the caller.
  // Do NOT recalculate here — the amount was already fetched from
  // subscription_plan_prices by handleCheckout or handleSignup.
  if (amount === undefined || amount === null) {
    console.error("[gateway] No amount provided — caller must pass a DB-verified amount");
    return { gateway: gw.provider, error: "Internal configuration error" };
  }

  switch (gw.provider) {
    case "razorpay":
      return createRazorpayOrder(gw, { shopId, billingCycle, currency, amount, invoiceNumber, paymentDbId });
    case "stripe":
      return createStripeSession(gw, { shopId, billingCycle, currency, amount, invoiceNumber, paymentDbId, originUrl });
    default:
      return { gateway: gw.provider, message: `${gw.displayName} integration not yet implemented.` };
  }
}

// ─── Razorpay Strategy ──────────────────────────────────────────────────────
async function createRazorpayOrder(gw, { shopId, billingCycle, currency, amount, invoiceNumber, paymentDbId }) {
  const razorpayAmount = toRazorpayAmount(amount, currency);
  try {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${gw.keyId}:${gw.keySecret}`).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: razorpayAmount,
        currency,
        receipt: invoiceNumber,
        notes: {
          shop_id: String(shopId),
          plan: "pro",
          payment_id: String(paymentDbId),
          billing_cycle: billingCycle,
          invoice: invoiceNumber,
        },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[gateway/razorpay] Order creation failed:", res.status, err);
      return { gateway: "razorpay", error: "Failed to create Razorpay order", statusCode: res.status };
    }
    const order = await res.json();
    return {
      gateway: "razorpay",
      orderId: order.id,
      amount,
      currency,
      keyId: gw.keyId,
      invoiceNumber,
      isTestMode: gw.isTestMode,
    };
  } catch (err) {
    console.error("[gateway/razorpay] Error:", err.message);
    return { gateway: "razorpay", error: err.message };
  }
}

// ─── Stripe Strategy ────────────────────────────────────────────────────────
async function createStripeSession(gw, { shopId, billingCycle, currency, amount, invoiceNumber, paymentDbId, originUrl }) {
  const baseUrl = originUrl || getAppBaseUrl();
  try {
    const intervalMap = { monthly: "month", quarterly: "month", halfyearly: "month", yearly: "year" };
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gw.keySecret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        mode: "payment",
        "line_items[0][price_data][currency]": currency.toLowerCase(),
        "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)),
        "line_items[0][quantity]": "1",
        "metadata[shop_id]": String(shopId),
        "metadata[plan]": "pro",
        "metadata[payment_id]": String(paymentDbId),
        "metadata[invoice]": invoiceNumber,
        "metadata[billing_cycle]": billingCycle,
        success_url: `${baseUrl}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/payment-failed.html`,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[gateway/stripe] Session creation failed:", res.status, err);
      return { gateway: "stripe", error: "Failed to create Stripe session", statusCode: res.status };
    }
    const session = await res.json();
    return {
      gateway: "stripe",
      checkoutUrl: session.url,
      sessionId: session.id,
      amount,
      currency,
      invoiceNumber,
      isTestMode: gw.isTestMode,
    };
  } catch (err) {
    console.error("[gateway/stripe] Error:", err.message);
    return { gateway: "stripe", error: err.message };
  }
}

// ─── Get masked gateway list (for admin UI) ─────────────────────────────────
async function getGatewayList() {
  const gateways = await loadGateways();
  return gateways.map(gw => ({
    id: gw.id,
    provider: gw.provider,
    displayName: gw.display_name,
    isEnabled: gw.is_enabled,
    isTestMode: gw.is_test_mode,
    hasKeyId: !!gw.key_id,
    hasKeySecret: !!gw.key_secret,
    hasWebhookSecret: !!gw.webhook_secret,
    priority: gw.priority,
    lastTestedAt: gw.last_tested_at,
    updatedAt: gw.updated_at,
  }));
}

/**
 * Invalidate the gateway cache (call after saving settings).
 */
function invalidateCache() {
  gwCache = { data: null, fetchedAt: 0 };
}

module.exports = {
  loadGateways,
  getGateway,
  getActiveGateway,
  getGatewayList,
  createOrder,
  calculateAmount,
  toRazorpayAmount,
  invalidateCache,
};

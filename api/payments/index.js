// api/payments/index.js
// Consolidated payments endpoint — create checkout, manage subscription.
// POST /api/payments  body: { action: "checkout", planName, billingCycle, … } → create checkout
// POST /api/payments  body: { action: "cancel" | "upgrade" | "downgrade" | "reactivate", planName? } → manage subscription
// GET  /api/payments  → view current subscription + payment history
// Security: auth required, rate-limited, validated.

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../_lib/auth");
const { withErrorHandler } = require("../_lib/errors");
const { validate, z } = require("../_lib/validate");
const { apiLimiter, applyLimit } = require("../_lib/rate-limit");
const { setSecurityHeaders } = require("../_lib/security");
const { convertPrice, detectCurrency, CURRENCIES } = require("../_lib/currency");

const checkoutSchema = z.object({
  planName: z.enum(["starter", "professional", "enterprise"]),
  billingCycle: z.enum(["monthly", "yearly"]).default("monthly"),
  currency: z.string().optional(),
  couponCode: z.string().optional(),
});

const subActionSchema = z.object({
  action: z.enum(["cancel", "upgrade", "downgrade", "reactivate"]),
  planName: z.enum(["starter", "professional", "enterprise"]).optional(),
});

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const sql = neon(process.env.DATABASE_URL);

  // GET: view current subscription + payments
  if (request.method === "GET") {
    return handleViewSubscription(request, response, sql, shopId);
  }

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const body = request.body || {};
  const action = body.action;

  if (action === "checkout") return handleCheckout(request, response, sql, shopId, body);
  if (action === "cancel" || action === "upgrade" || action === "downgrade" || action === "reactivate") {
    return handleSubscriptionAction(request, response, sql, shopId, body);
  }

  return response.status(400).json({ error: "Invalid action. Use: checkout, cancel, upgrade, downgrade, reactivate" });
});

// ─── VIEW SUBSCRIPTION ───────────────────────────────────
async function handleViewSubscription(request, response, sql, shopId) {
  const subs = await sql`
    SELECT s.*, sp.name as plan_name, sp.display_name, sp.price_monthly_usd,
           sp.price_yearly_usd, sp.max_bookings, sp.max_technicians, sp.features
    FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.repair_shop_id = ${shopId} ORDER BY s.created_at DESC LIMIT 1
  `;

  const payments = await sql`
    SELECT id, payment_id, transaction_id, gateway, currency, amount, status,
           invoice_number, description, created_at
    FROM payments WHERE repair_shop_id = ${shopId} ORDER BY created_at DESC LIMIT 20
  `;

  return response.status(200).json({ subscription: subs[0] || null, payments });
}

// ─── CREATE CHECKOUT ─────────────────────────────────────
async function handleCheckout(request, response, sql, shopId, body) {
  const data = validate({ ...request, body }, response, checkoutSchema);
  if (!data) return;

  const currency = data.currency || detectCurrency(request);
  const plans = await sql`SELECT * FROM subscription_plans WHERE name = ${data.planName} AND is_active = true LIMIT 1`;
  if (plans.length === 0) return response.status(404).json({ error: "Plan not found" });
  const plan = plans[0];

  const priceUsd = data.billingCycle === "yearly" ? plan.price_yearly_usd : plan.price_monthly_usd;
  const converted = await convertPrice(parseFloat(priceUsd), currency);

  // Apply coupon
  let discount = 0;
  if (data.couponCode) {
    const coupons = await sql`
      SELECT * FROM coupons WHERE code = ${data.couponCode.toUpperCase()} AND is_active = true
        AND used_count < COALESCE(max_uses, 999999) AND valid_from <= now()
        AND (valid_until IS NULL OR valid_until >= now())
        AND (applicable_plans IS NULL OR ${data.planName} = ANY(applicable_plans))
      LIMIT 1
    `;
    if (coupons.length > 0) {
      const coupon = coupons[0];
      discount = coupon.discount_type === "percent"
        ? converted.amount * (parseFloat(coupon.discount_value) / 100)
        : parseFloat(coupon.discount_value);
      await sql`UPDATE coupons SET used_count = used_count + 1 WHERE id = ${coupon.id}`;
    }
  }

  const finalAmount = Math.max(0, converted.amount - discount);
  const invoiceNumber = `INV-${Date.now()}-${shopId}`;

  const payment = await sql`
    INSERT INTO payments (repair_shop_id, gateway, currency, amount, status, invoice_number, description)
    VALUES (${shopId}, 'pending', ${currency}, ${finalAmount}, 'pending', ${invoiceNumber},
            ${`${plan.display_name} — ${data.billingCycle}`})
    RETURNING id
  `;

  // Stripe
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey) {
    try {
      const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          mode: "subscription",
          "line_items[0][price_data][currency]": currency.toLowerCase(),
          "line_items[0][price_data][unit_amount]": String(Math.round(finalAmount * 100)),
          "line_items[0][price_data][recurring][interval]": data.billingCycle === "yearly" ? "year" : "month",
          "line_items[0][quantity]": "1",
          "metadata[shop_id]": String(shopId), "metadata[plan]": data.planName,
          "metadata[payment_id]": String(payment[0].id), "metadata[invoice]": invoiceNumber,
          success_url: `${request.headers["origin"] || "https://coolcare.ai"}/shop-dashboard.html?payment=success`,
          cancel_url: `${request.headers["origin"] || "https://coolcare.ai"}/shop-dashboard.html?payment=cancelled`,
        }),
      });
      if (stripeRes.ok) {
        const session = await stripeRes.json();
        await sql`UPDATE payments SET gateway = 'stripe', payment_id = ${session.id} WHERE id = ${payment[0].id}`;
        return response.status(200).json({ checkoutUrl: session.url, gateway: "stripe", amount: finalAmount, currency, invoiceNumber });
      }
    } catch (e) { console.error("[payments/checkout] Stripe error:", e.message); }
  }

  // Razorpay fallback
  const razorpayKey = process.env.RAZORPAY_KEY_ID;
  const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;
  if (razorpayKey && razorpaySecret) {
    try {
      const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(`${razorpayKey}:${razorpaySecret}`).toString("base64"), "Content-Type": "application/json" },
        body: JSON.stringify({ amount: Math.round(finalAmount * 100), currency, receipt: invoiceNumber, notes: { shop_id: shopId, plan: data.planName, payment_id: payment[0].id } }),
      });
      if (rpRes.ok) {
        const order = await rpRes.json();
        await sql`UPDATE payments SET gateway = 'razorpay', payment_id = ${order.id} WHERE id = ${payment[0].id}`;
        return response.status(200).json({ orderId: order.id, gateway: "razorpay", amount: finalAmount, currency, keyId: razorpayKey, invoiceNumber });
      }
    } catch (e) { console.error("[payments/checkout] Razorpay error:", e.message); }
  }

  return response.status(200).json({
    gateway: "none", amount: finalAmount, currency, invoiceNumber,
    message: "No payment gateway configured. Set STRIPE_SECRET_KEY or RAZORPAY_KEY_ID.",
  });
}

// ─── SUBSCRIPTION ACTION (cancel/upgrade/downgrade/reactivate) ──
async function handleSubscriptionAction(request, response, sql, shopId, body) {
  const data = validate({ ...request, body }, response, subActionSchema);
  if (!data) return;

  const current = await sql`
    SELECT s.*, sp.name as plan_name FROM subscriptions s
    JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.repair_shop_id = ${shopId} ORDER BY s.created_at DESC LIMIT 1
  `;
  if (current.length === 0) return response.status(404).json({ error: "No active subscription found" });
  const sub = current[0];

  if (data.action === "cancel") {
    await sql`UPDATE subscriptions SET status = 'cancelled', cancel_at = current_period_end, updated_at = now() WHERE id = ${sub.id}`;
    return response.status(200).json({ message: "Subscription cancelled. Access continues until period end." });
  }
  if (data.action === "reactivate") {
    await sql`UPDATE subscriptions SET status = 'active', cancel_at = NULL, updated_at = now() WHERE id = ${sub.id}`;
    return response.status(200).json({ message: "Subscription reactivated." });
  }
  if (data.action === "upgrade" || data.action === "downgrade") {
    if (!data.planName) return response.status(400).json({ error: "planName is required for upgrade/downgrade" });
    const newPlan = await sql`SELECT * FROM subscription_plans WHERE name = ${data.planName} LIMIT 1`;
    if (newPlan.length === 0) return response.status(404).json({ error: "Plan not found" });
    await sql`UPDATE subscriptions SET plan_id = ${newPlan[0].id}, updated_at = now() WHERE id = ${sub.id}`;
    return response.status(200).json({ message: `Subscription ${data.action}d to ${data.planName}.`, newPlan: newPlan[0] });
  }

  return response.status(400).json({ error: "Invalid action" });
}

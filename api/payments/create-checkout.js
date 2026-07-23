// api/payments/create-checkout.js
// Create a payment checkout session for subscription.
// POST /api/payments/create-checkout
// Body: { planName, billingCycle, currency?, couponCode? }
// Supports: Stripe, Razorpay (priority order).

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../_lib/auth");
const { withErrorHandler, allowMethods } = require("../_lib/errors");
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

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "POST")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const data = validate(request, response, checkoutSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);
  const currency = data.currency || detectCurrency(request);

  // Fetch plan from DB
  const plans = await sql`
    SELECT * FROM subscription_plans WHERE name = ${data.planName} AND is_active = true LIMIT 1
  `;
  if (plans.length === 0) {
    return response.status(404).json({ error: "Plan not found" });
  }
  const plan = plans[0];

  const priceUsd = data.billingCycle === "yearly" ? plan.price_yearly_usd : plan.price_monthly_usd;
  const converted = await convertPrice(parseFloat(priceUsd), currency);

  // Apply coupon if provided
  let discount = 0;
  if (data.couponCode) {
    const coupons = await sql`
      SELECT * FROM coupons
      WHERE code = ${data.couponCode.toUpperCase()}
        AND is_active = true
        AND used_count < COALESCE(max_uses, 999999)
        AND valid_from <= now()
        AND (valid_until IS NULL OR valid_until >= now())
        AND (applicable_plans IS NULL OR ${data.planName} = ANY(applicable_plans))
      LIMIT 1
    `;
    if (coupons.length > 0) {
      const coupon = coupons[0];
      discount = coupon.discount_type === "percent"
        ? converted.amount * (parseFloat(coupon.discount_value) / 100)
        : parseFloat(coupon.discount_value);

      // Increment usage
      await sql`UPDATE coupons SET used_count = used_count + 1 WHERE id = ${coupon.id}`;
    }
  }

  const finalAmount = Math.max(0, converted.amount - discount);

  // Generate invoice number
  const invoiceNumber = `INV-${Date.now()}-${shopId}`;

  // Create pending payment record
  const payment = await sql`
    INSERT INTO payments (repair_shop_id, gateway, currency, amount, status, invoice_number, description)
    VALUES (${shopId}, 'pending', ${currency}, ${finalAmount}, 'pending', ${invoiceNumber},
            ${`${plan.display_name} — ${data.billingCycle}`})
    RETURNING id
  `;

  // Create Stripe checkout session if configured
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey) {
    try {
      const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          mode: "subscription",
          "line_items[0][price_data][currency]": currency.toLowerCase(),
          "line_items[0][price_data][unit_amount]": String(Math.round(finalAmount * 100)),
          "line_items[0][price_data][recurring][interval]": data.billingCycle === "yearly" ? "year" : "month",
          "line_items[0][quantity]": "1",
          "metadata[shop_id]": String(shopId),
          "metadata[plan]": data.planName,
          "metadata[payment_id]": String(payment[0].id),
          "metadata[invoice]": invoiceNumber,
          success_url: `${request.headers["origin"] || "https://coolcare.ai"}/shop-dashboard.html?payment=success`,
          cancel_url: `${request.headers["origin"] || "https://coolcare.ai"}/shop-dashboard.html?payment=cancelled`,
        }),
      });

      if (stripeRes.ok) {
        const session = await stripeRes.json();
        // Update payment with gateway info
        await sql`
          UPDATE payments SET gateway = 'stripe', payment_id = ${session.id}
          WHERE id = ${payment[0].id}
        `;
        return response.status(200).json({
          checkoutUrl: session.url,
          gateway: "stripe",
          amount: finalAmount,
          currency,
          invoiceNumber,
        });
      }
    } catch (stripeErr) {
      console.error("[checkout] Stripe error:", stripeErr.message);
    }
  }

  // Fallback: Razorpay
  const razorpayKey = process.env.RAZORPAY_KEY_ID;
  const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;
  if (razorpayKey && razorpaySecret) {
    try {
      const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${razorpayKey}:${razorpaySecret}`).toString("base64"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: Math.round(finalAmount * 100),
          currency: currency,
          receipt: invoiceNumber,
          notes: { shop_id: shopId, plan: data.planName, payment_id: payment[0].id },
        }),
      });

      if (rpRes.ok) {
        const order = await rpRes.json();
        await sql`
          UPDATE payments SET gateway = 'razorpay', payment_id = ${order.id}
          WHERE id = ${payment[0].id}
        `;
        return response.status(200).json({
          orderId: order.id,
          gateway: "razorpay",
          amount: finalAmount,
          currency,
          keyId: razorpayKey,
          invoiceNumber,
        });
      }
    } catch (rpErr) {
      console.error("[checkout] Razorpay error:", rpErr.message);
    }
  }

  // No payment gateway configured — return mock for testing
  return response.status(200).json({
    gateway: "none",
    amount: finalAmount,
    currency,
    invoiceNumber,
    message: "No payment gateway configured. Set STRIPE_SECRET_KEY or RAZORPAY_KEY_ID.",
  });
});

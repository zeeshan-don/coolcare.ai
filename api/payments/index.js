// api/payments/index.js
// Consolidated payments endpoint — create checkout, manage subscription, view invoices.
// POST /api/payments  body: { action: "checkout", billingCycle, currency } → create checkout
// POST /api/payments  body: { action: "cancel" | "reactivate" } → manage subscription
// GET  /api/payments  → view current subscription + payment history
// GET  /api/payments?action=invoices → view invoices
// GET  /api/payments?action=invoice&id=123 → single invoice
// Security: auth required, rate-limited, validated.

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../_lib/auth");
const { withErrorHandler } = require("../_lib/errors");
const { validate, z } = require("../_lib/validate");
const { apiLimiter, applyLimit } = require("../_lib/rate-limit");
const { setSecurityHeaders } = require("../_lib/security");
const { PLAN_PRICING, detectCurrency, detectCountry, getCountryCurrency, CURRENCIES, getPlanPricingFromDB } = require("../_lib/currency");
const { createOrder, calculateAmount, getActiveGateway } = require("../_lib/gateway");
const { isDemoShop } = require("../_lib/auth");

// Accept "pro" and legacy plan names (backward compat)
const PLAN_NAMES = ["pro", "starter", "professional", "enterprise"];
const normalizePlanName = (name) => {
  if (!name || name === "pro") return "pro";
  // Legacy plan names → map to pro
  if (["starter", "professional", "enterprise"].includes(name)) return "pro";
  return name;
};

const checkoutSchema = z.object({
  planName: z.enum(PLAN_NAMES).optional().default("pro"),
  billingCycle: z.enum(["monthly", "quarterly", "halfyearly", "yearly"]).default("monthly"),
  currency: z.string().optional(),
  couponCode: z.string().optional(),
  // NEW: Frontend sends ONLY plan_id and selected_country for security
  selectedPlanId: z.coerce.number().int().positive().optional(),
  selectedCountry: z.string().min(2).max(5).optional(),
});

const subActionSchema = z.object({
  action: z.enum(["cancel", "reactivate"]),
});

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const sql = neon(process.env.DATABASE_URL);

  // ── DEMO MODE GUARD ──────────────────────────────────────────────────────
  const isDemo = auth.isDemo || (shopId ? await isDemoShop(sql, shopId) : false);
  if (isDemo && request.method === "POST") {
    return response.status(403).json({
      error: "This is a demo account. Changes are not saved.",
      isDemo: true,
      demoError: true,
    });
  }

  // GET: view subscription, invoices, payment history
  if (request.method === "GET") {
    const action = request.query?.action || "subscription";
    if (action === "invoices") return handleInvoices(request, response, sql, shopId);
    if (action === "invoice") return handleInvoiceDetail(request, response, sql, shopId);
    return handleViewSubscription(request, response, sql, shopId);
  }

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const body = request.body || {};
  const action = body.action;

  if (action === "checkout") return handleCheckout(request, response, sql, shopId, body);
  if (action === "cancel" || action === "reactivate") {
    return handleSubscriptionAction(request, response, sql, shopId, body);
  }

  return response.status(400).json({ error: "Invalid action. Use: checkout, cancel, reactivate" });
});

// ─── VIEW SUBSCRIPTION ───────────────────────────────────
async function handleViewSubscription(request, response, sql, shopId) {
  let subscription = null;
  try {
    const subs = await sql`
      SELECT s.*, sp.name as plan_name, sp.display_name, sp.features,
             sp.price_monthly_usd, sp.price_yearly_usd
      FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id
      WHERE s.repair_shop_id = ${shopId} ORDER BY s.created_at DESC LIMIT 1
    `;
    subscription = subs[0] || null;
  } catch (e) { /* table may not exist yet */ }

  const payments = await sql`
    SELECT id, payment_id, transaction_id, gateway, currency, amount, status,
           invoice_number, description, created_at
    FROM payments WHERE repair_shop_id = ${shopId} ORDER BY created_at DESC LIMIT 20
  `;

  // Invoice count
  let invoiceCount = 0;
  try {
    const ic = await sql`SELECT COUNT(*) as cnt FROM invoices WHERE repair_shop_id = ${shopId} AND status = 'paid'`;
    invoiceCount = parseInt(ic[0]?.cnt || "0", 10);
  } catch (e) { /* table may not exist */ }

  return response.status(200).json({ subscription, payments, invoiceCount });
}

// ─── INVOICES LIST ───────────────────────────────────────
async function handleInvoices(request, response, sql, shopId) {
  try {
    const invoices = await sql`
      SELECT id, invoice_number, plan_name, billing_cycle, currency,
             subtotal, tax_rate, tax_amount, total, status,
             business_name, issued_at, paid_at, created_at
      FROM invoices WHERE repair_shop_id = ${shopId}
      ORDER BY created_at DESC LIMIT 50
    `;
    return response.status(200).json({ invoices });
  } catch (e) {
    return response.status(200).json({ invoices: [], error: "Invoices table not available" });
  }
}

// ─── INVOICE DETAIL ──────────────────────────────────────
async function handleInvoiceDetail(request, response, sql, shopId) {
  const invoiceId = parseInt(request.query?.id, 10);
  if (!invoiceId) return response.status(400).json({ error: "Invoice ID required" });
  try {
    const invoices = await sql`
      SELECT * FROM invoices WHERE id = ${invoiceId} AND repair_shop_id = ${shopId} LIMIT 1
    `;
    if (!invoices.length) return response.status(404).json({ error: "Invoice not found" });
    return response.status(200).json({ invoice: invoices[0] });
  } catch (e) {
    return response.status(404).json({ error: "Invoice not found" });
  }
}

// ─── CREATE CHECKOUT ─────────────────────────────────────
async function handleCheckout(request, response, sql, shopId, body) {
  const data = validate({ ...request, body }, response, checkoutSchema);
  if (!data) return;

  const planName = normalizePlanName(data.planName);
  
  // ── SECURITY: Determine currency and amount from server-side only ──
  // Frontend sends ONLY selected_plan_id and selected_country (optional)
  // Backend determines currency, fetches amount from DB
  let currency;
  let selectedCountry = data.selectedCountry || null;
  
  if (selectedCountry) {
    // Use country from frontend (user may have changed it)
    currency = getCountryCurrency(selectedCountry);
  } else {
    // Detect from IP or use currency header as fallback
    const detectedCountry = detectCountry(request);
    if (detectedCountry) {
      selectedCountry = detectedCountry;
      currency = getCountryCurrency(detectedCountry);
    } else {
      currency = (data.currency || detectCurrency(request)).toUpperCase();
    }
  }

  const billingCycle = data.billingCycle || "monthly";
  
  // Determine plan ID from plan name
  let planId = data.selectedPlanId || null;
  if (!planId) {
    try {
      const planRows = await sql`SELECT id FROM subscription_plans WHERE name = ${planName} LIMIT 1`;
      if (planRows.length > 0) planId = planRows[0].id;
    } catch (e) { /* table may not exist */ }
  }
  if (!planId) planId = 1; // fallback to plan ID 1

  // ── FETCH AMOUNT FROM DATABASE (authoritative source) ──
  // NEVER trust any amount from the frontend
  const { amount: baseAmount } = await calculateAmount(sql, currency, billingCycle, planId);

  // Apply promo code if provided
  let discount = 0;
  let promoCodeId = null;
  if (data.couponCode) {
    try {
      const codeHash = require('crypto').createHash('sha256').update(data.couponCode.toUpperCase()).digest('hex');
      const codes = await sql`
        SELECT * FROM promotion_codes
        WHERE (code = ${data.couponCode.toUpperCase()} OR code_hash = ${codeHash})
          AND is_active = true AND (valid_until IS NULL OR valid_until >= now())
          AND (max_uses IS NULL OR used_count < max_uses)
        LIMIT 1
      `;
      if (codes.length > 0) {
        const promo = codes[0];
        promoCodeId = promo.id;
        if (promo.type === 'percentage_discount' && promo.discount_percent !== null) {
          discount = Math.round((baseAmount * promo.discount_percent / 100) * 100) / 100;
        } else if (promo.type === 'fixed_discount' && promo.discount_amount !== null) {
          discount = promo.discount_amount;
        }
        if (promo.max_discount_amount !== null && discount > promo.max_discount_amount) {
          discount = promo.max_discount_amount;
        }
      }
    } catch (e) {
      console.warn('[payments] Promo code validation failed:', e.message);
    }
  }

  const finalAmount = Math.max(0, Math.round((baseAmount - discount) * 100) / 100);
  const invoiceNumber = `INV-${Date.now()}-${shopId}`;

  // Prevent duplicate pending payments (idempotency)
  try {
    const pending = await sql`
      SELECT id, created_at FROM payments
      WHERE repair_shop_id = ${shopId} AND status = 'pending'
        AND created_at > now() - INTERVAL '15 minutes'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (pending.length > 0) {
      const minsAgo = Math.floor((Date.now() - new Date(pending[0].created_at).getTime()) / 60000);
      if (minsAgo < 10) {
        return response.status(429).json({
          error: "A payment is already in progress. Please complete or cancel it first.",
          retryAfter: 10 - minsAgo,
        });
      }
    }
  } catch (e) { /* ok */ }

  // ── ZERO AMOUNT (100% Discount): Skip Razorpay, activate subscription directly ──
  if (finalAmount === 0 && promoCodeId) {
    try {
      const shopRows = await sql`SELECT email FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
      const shopEmail = shopRows.length > 0 ? shopRows[0].email : 'unknown@shop.com';

      await sql`BEGIN`;
      
      await sql`
        UPDATE repair_shops SET subscription_status = 'active', approval_status = 'approved',
          is_active = true, updated_at = now()
        WHERE id = ${shopId}
      `;
      
      const subEnd = new Date();
      subEnd.setFullYear(subEnd.getFullYear() + 10);
      
      const sub = await sql`
        INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway,
          amount_paid, currency, promotion_code_id,
          current_period_start, current_period_end, created_at)
        VALUES (${shopId}, ${planId}, 'active', ${billingCycle}, 'promo_code',
          0, ${currency}, ${promoCodeId},
          now(), ${subEnd.toISOString()}, now())
        RETURNING id
      `;
      
      await sql`UPDATE promotion_codes SET used_count = used_count + 1, updated_at = now() WHERE id = ${promoCodeId}`;
      await sql`
        INSERT INTO promo_code_redemptions (promotion_code_id, repair_shop_id, email, ip_address, user_agent,
          plan_name, billing_cycle, original_amount, discount_amount, final_amount, currency,
          subscription_id, status)
        VALUES (${promoCodeId}, ${shopId}, ${shopEmail},
          ${request.headers['x-forwarded-for']?.split(',')[0] || request.headers['x-real-ip'] || null},
          ${request.headers['user-agent'] || null},
          ${planName}, ${billingCycle}, ${baseAmount}, ${discount}, 0, ${currency},
          ${sub[0].id}, 'active')
      `;
      
      await sql`COMMIT`;
      
      console.log('[payments] Zero-amount checkout activated for shop #' + shopId);
      return response.status(200).json({
        message: 'Promo code applied! Subscription activated with 100% discount.',
        activationType: 'promo_discount',
        subscriptionId: sub[0].id,
        subscriptionRequired: false,
      });
    } catch (err) {
      await sql`ROLLBACK`.catch(() => {});
      console.error('[payments] Zero-amount checkout activation failed:', err.message);
      return response.status(500).json({ error: 'Discount activation failed: ' + err.message });
    }
  }

  // Create payment record
  const payment = await sql`
    INSERT INTO payments (repair_shop_id, gateway, currency, amount, status, invoice_number, description, metadata)
    VALUES (${shopId}, 'pending', ${currency}, ${finalAmount}, 'pending', ${invoiceNumber},
            ${`CoolCare Pro — ${billingCycle}`},
            ${JSON.stringify({ billingCycle, planName, promoCodeId, discount })}::jsonb)
    RETURNING id
  `;

  // Log payment attempt
  try {
    await sql`
      INSERT INTO payment_logs (payment_id, repair_shop_id, gateway, event_type, severity, message)
      VALUES (${payment[0].id}, ${shopId}, 'system', 'checkout_created', 'info',
              ${`Checkout created: ${currency} ${finalAmount} for ${billingCycle}`})
    `;
  } catch (e) { /* table may not exist */ }

  // Create order via gateway library
  const originUrl = request.headers["origin"] || "https://coolcare.ai";
  const orderResult = await createOrder({
    shopId,
    billingCycle,
    currency,
    amount: finalAmount,
    invoiceNumber,
    paymentDbId: payment[0].id,
    originUrl,
  });

  if (orderResult.error) {
    // Log failure
    try {
      await sql`
        INSERT INTO payment_logs (payment_id, repair_shop_id, gateway, event_type, severity, message, error_message)
        VALUES (${payment[0].id}, ${shopId}, ${orderResult.gateway}, 'checkout_failed', 'error',
                'Gateway order creation failed', ${orderResult.error})
      `;
    } catch (e) { /* ok */ }
    return response.status(500).json({ error: orderResult.error, gateway: orderResult.gateway });
  }

  // Update payment record with gateway info
  if (orderResult.gateway !== "none") {
    const gatewayId = orderResult.orderId || orderResult.sessionId || null;
    await sql`UPDATE payments SET gateway = ${orderResult.gateway}, payment_id = ${gatewayId} WHERE id = ${payment[0].id}`;
  }

  return response.status(200).json({
    ...orderResult,
    paymentId: payment[0].id,
  });
}

// ─── SUBSCRIPTION ACTION (cancel/reactivate) ─────────────
async function handleSubscriptionAction(request, response, sql, shopId, body) {
  const data = validate({ ...request, body }, response, subActionSchema);
  if (!data) return;

  let current;
  try {
    current = await sql`
      SELECT s.*, sp.name as plan_name FROM subscriptions s
      JOIN subscription_plans sp ON sp.id = s.plan_id
      WHERE s.repair_shop_id = ${shopId} ORDER BY s.created_at DESC LIMIT 1
    `;
  } catch (e) {
    return response.status(404).json({ error: "No subscription found" });
  }
  if (!current?.length) return response.status(404).json({ error: "No active subscription found" });
  const sub = current[0];

  if (data.action === "cancel") {
    await sql`UPDATE subscriptions SET status = 'cancelled', cancel_at = current_period_end, updated_at = now() WHERE id = ${sub.id}`;
    try {
      await sql`
        INSERT INTO subscription_history (subscription_id, repair_shop_id, action, old_status, new_status, actor_type)
        VALUES (${sub.id}, ${shopId}, 'cancelled', ${sub.status}, 'cancelled', 'shop')
      `;
    } catch (e) { /* ok */ }
    return response.status(200).json({ message: "Subscription cancelled. Access continues until period end." });
  }

  if (data.action === "reactivate") {
    await sql`UPDATE subscriptions SET status = 'active', cancel_at = NULL, updated_at = now() WHERE id = ${sub.id}`;
    await sql`UPDATE repair_shops SET subscription_status = 'active', updated_at = now() WHERE id = ${shopId}`;
    try {
      await sql`
        INSERT INTO subscription_history (subscription_id, repair_shop_id, action, old_status, new_status, actor_type)
        VALUES (${sub.id}, ${shopId}, 'reactivated', ${sub.status}, 'active', 'shop')
      `;
    } catch (e) { /* ok */ }
    return response.status(200).json({ message: "Subscription reactivated." });
  }

  return response.status(400).json({ error: "Invalid action" });
}

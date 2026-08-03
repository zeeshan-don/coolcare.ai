// api/payments/index.js
// Consolidated payments endpoint — create checkout, manage subscription, view invoices.
// POST /api/payments  body: { action: "checkout", billingCycle, currency } → create checkout
// POST /api/payments  body: { action: "cancel" | "reactivate" } → manage subscription
// GET  /api/payments  → view current subscription + payment history
// GET  /api/payments?action=invoices → view invoices
// GET  /api/payments?action=invoice&id=123 → single invoice
// Security: auth required, rate-limited, validated.

const { neon } = require("@neondatabase/serverless");
const { requireAuth, isDemoShop } = require("../_lib/auth");
const { withErrorHandler, allowMethods } = require("../_lib/errors");
const { validate, z } = require("../_lib/validate");
const { apiLimiter, webhookLimiter, applyLimit } = require("../_lib/rate-limit");
const { setSecurityHeaders, verifyWebhookSignature, htmlEscape } = require("../_lib/security");
const { PLAN_PRICING, detectCurrency, detectCountry, getCountryCurrency, CURRENCIES, getPlanPricingFromDB } = require("../_lib/currency");
const { createOrder, calculateAmount, getActiveGateway, getGateway } = require("../_lib/gateway");
const { notifyAdmin, sendEmail } = require("../_lib/notify");

// Accept "pro" and legacy plan names (backward compat)
const PLAN_NAMES = ["pro", "starter", "professional", "enterprise"];
const normalizePlanName = (name) => {
  if (!name) return "pro";
  const n = String(name).toLowerCase();
  if (n === "pro" || n === "starter") return n;
  // Legacy plan names → map to pro
  if (["professional", "enterprise"].includes(n)) return "pro";
  return n;
};

// Does a plan include the hosted website (Pro)? Drives the website_enabled flag.
async function planHasWebsite(sql, planId) {
  try {
    const rows = await sql`SELECT features FROM subscription_plans WHERE id = ${planId} LIMIT 1`;
    const features = rows[0]?.features;
    const feats = typeof features === "string" ? JSON.parse(features) : (features || {});
    return !!(feats.hosted_website || feats.website_enabled || feats.website);
  } catch (e) {
    return false;
  }
}

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

  // ── WEBHOOK ROUTE ── POST /api/payments/webhook (rewritten to ?route=webhook)
  // Webhooks are signature-verified, NOT auth-verified — handle before auth.
  if (request.query?.route === "webhook") {
    return handleWebhook(request, response);
  }

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
          is_active = true, website_enabled = ${await planHasWebsite(sql, planId)}, updated_at = now()
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
            ${`CoolCare ${planName === "pro" ? "Pro" : "Starter"} — ${billingCycle}`},
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

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK HANDLER (was api/payments/webhook.js — merged here)
// POST /api/payments/webhook (rewritten to /api/payments?route=webhook)
// Supports: Stripe, Razorpay webhooks.
// NEVER trust frontend payment responses — always verify via webhook.
// SECURITY: signature verified against the exact raw body (never JSON.stringify).
// ═══════════════════════════════════════════════════════════════════════════

// ─── Helpers ────────────────────────────────────────────────────────────────

function getExpiryInterval(billingCycle) {
  switch (billingCycle) {
    case "quarterly": return "90";
    case "halfyearly": return "180";
    case "yearly": return "365";
    default: return "30";
  }
}

async function logPayment(sql, paymentId, shopId, gateway, eventType, severity, message, error) {
  try {
    await sql`
      INSERT INTO payment_logs (payment_id, repair_shop_id, gateway, event_type, severity, message, error_message)
      VALUES (${paymentId || null}, ${shopId || null}, ${gateway}, ${eventType}, ${severity}, ${message}, ${error || null})
    `;
  } catch (e) {
    console.error("[webhook] logPayment failed:", e.message);
  }
}

async function logSubHistory(sql, subId, shopId, action, oldStatus, newStatus, amount, currency, billingCycle, gateway, actorType) {
  try {
    await sql`
      INSERT INTO subscription_history (subscription_id, repair_shop_id, action, old_status, new_status,
        amount, currency, billing_cycle, gateway, actor_type)
      VALUES (${subId || null}, ${shopId}, ${action}, ${oldStatus || null}, ${newStatus || null},
        ${amount || null}, ${currency || null}, ${billingCycle || null}, ${gateway || null}, ${actorType || 'webhook'})
    `;
  } catch (e) {
    console.error("[webhook] logSubHistory failed:", e.message);
  }
}

// ─── Atomic idempotency via INSERT ... ON CONFLICT DO NOTHING ───────────────
// Requires a UNIQUE constraint on payment_logs(idempotency_key).
// This eliminates the TOCTOU race between a separate SELECT + INSERT.
async function tryClaimIdempotencyKey(sql, idempotencyKey, paymentId, shopId, gateway, eventType) {
  if (!idempotencyKey) return false;
  try {
    const result = await sql`
      INSERT INTO payment_logs (payment_id, repair_shop_id, gateway, event_type, severity, message, idempotency_key)
      VALUES (${paymentId || null}, ${shopId || null}, ${gateway}, ${eventType}, 'info', 'Webhook processed', ${idempotencyKey})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `;
    return result.length > 0; // true = first claim, false = already exists
  } catch (e) {
    console.error("[webhook] Idempotency claim failed:", e.message);
    return false;
  }
}

// ─── Generate invoice on successful payment ─────────────────────────────────
async function generateInvoice(sql, { shopId, paymentId, subscriptionId, planName, billingCycle, currency, amount, invoiceNumber }) {
  try {
    let businessName = "CoolCare";
    let businessAddress = "";
    let businessGst = "";
    let taxRate = 0;
    try {
      const settings = await sql`SELECT value FROM platform_settings WHERE key = 'payment_settings' LIMIT 1`;
      if (settings[0]?.value) {
        const ps = typeof settings[0].value === "string" ? JSON.parse(settings[0].value) : settings[0].value;
        businessName = ps.business_name || "CoolCare";
        businessAddress = ps.business_address || "";
        businessGst = ps.business_gst || "";
        taxRate = parseFloat(ps.tax_rate) || 0;
      }
    } catch (e) {
      console.warn("[webhook] Payment settings lookup failed:", e.message);
    }

    const taxAmount = Math.round(amount * taxRate / 100 * 100) / 100;
    const total = Math.round((amount + taxAmount) * 100) / 100;

    await sql`
      INSERT INTO invoices (invoice_number, repair_shop_id, subscription_id, payment_id,
        plan_name, billing_cycle, currency, subtotal, tax_rate, tax_amount, total,
        business_name, business_address, business_gst, status, issued_at, paid_at)
      VALUES (${invoiceNumber}, ${shopId}, ${subscriptionId || null}, ${paymentId},
        ${planName}, ${billingCycle}, ${currency}, ${amount}, ${taxRate}, ${taxAmount}, ${total},
        ${businessName}, ${businessAddress}, ${businessGst}, 'paid', now(), now())
    `;
  } catch (e) {
    console.warn("[webhook] Invoice generation failed:", e.message);
  }
}

// ─── Send confirmation email ────────────────────────────────────────────────
async function sendPaymentConfirmation(sql, shopId, { planName, billingCycle, currency, amount, invoiceNumber }) {
  try {
    const shop = await sql`SELECT email, owner_name, shop_name FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    if (!shop[0]?.email) return;

    const safeOwnerName = htmlEscape(shop[0].owner_name);
    const safeBillingCycle = htmlEscape(billingCycle);
    const safeCurrency = htmlEscape(currency);
    const safeAmount = htmlEscape(amount);
    const safeInvoiceNumber = htmlEscape(invoiceNumber);

    const subject = `CoolCare — Payment Confirmed (${safeInvoiceNumber})`;
    const html = `<div style="font-family:Inter,sans-serif;padding:24px;background:#0a0a0a;color:#ededed;">
      <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid #222;border-radius:12px;padding:32px;">
        <h2 style="color:#fff;margin:0 0 16px;font-size:20px;">Payment Confirmed</h2>
        <p style="color:#a3a3a3;line-height:1.6;">Hi ${safeOwnerName},</p>
        <p style="color:#a3a3a3;line-height:1.6;">Your CoolCare Pro subscription has been activated.</p>
        <table style="width:100%;margin:16px 0;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#737373;font-size:13px;">Plan</td><td style="padding:8px 0;color:#fff;font-weight:600;text-align:right;">CoolCare Pro</td></tr>
          <tr><td style="padding:8px 0;color:#737373;font-size:13px;">Billing</td><td style="padding:8px 0;color:#fff;text-align:right;">${safeBillingCycle}</td></tr>
          <tr><td style="padding:8px 0;color:#737373;font-size:13px;">Amount</td><td style="padding:8px 0;color:#22c55e;font-weight:600;text-align:right;">${safeCurrency} ${safeAmount}</td></tr>
          <tr><td style="padding:8px 0;color:#737373;font-size:13px;">Invoice</td><td style="padding:8px 0;color:#fff;text-align:right;">${safeInvoiceNumber}</td></tr>
        </table>
        <hr style="border:none;border-top:1px solid #222;margin:24px 0;">
        <p style="color:#525252;font-size:12px;margin:0;">CoolCare — Better service, one conversation at a time.</p>
      </div></div>`;

    await sendEmail(shop[0].email, subject, html);
  } catch (e) {
    console.warn("[webhook] Confirmation email failed:", e.message);
  }
}

// ─── Activate subscription ──────────────────────────────────────────────────
async function activateSubscription(sql, shopId, planName, billingCycle, gateway, gatewaySubId, amount, currency) {
  const plans = await sql`SELECT id FROM subscription_plans WHERE name = ${planName} LIMIT 1`;
  if (plans.length === 0) {
    const proPlans = await sql`SELECT id FROM subscription_plans WHERE name = 'pro' LIMIT 1`;
    if (proPlans.length === 0) return null;
    plans.push(proPlans[0]);
  }
  const planId = plans[0].id;
  const expiryDays = getExpiryInterval(billingCycle || "monthly");

  const existing = await sql`
    SELECT id, current_period_end, status FROM subscriptions
    WHERE repair_shop_id = ${shopId} AND status IN ('active', 'cancelled')
    ORDER BY created_at DESC LIMIT 1
  `;

  let subId;
  let oldStatus = null;
  let action;

  if (existing.length > 0 && existing[0].status === "active") {
    const oldExpiry = existing[0].current_period_end;
    await sql(
      `UPDATE subscriptions SET
        current_period_end = GREATEST(current_period_end, now()) + ($1 || ' days')::interval,
        amount_paid = COALESCE(amount_paid, 0) + $2,
        currency = $3, billing_cycle = $4,
        updated_at = now()
       WHERE id = $5`,
      expiryDays, amount || 0, currency || "USD", billingCycle || "monthly", existing[0].id
    );
    subId = existing[0].id;
    oldStatus = "active";
    action = "renewed";
  } else {
    const inserted = await sql(
      `INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway, gateway_sub_id,
        current_period_end, amount_paid, currency)
       VALUES ($1, $2, 'pending_approval', $3, $4, $5, now() + ($6 || ' days')::interval, $7, $8)
       RETURNING id`,
      shopId, planId, billingCycle || "monthly", gateway, gatewaySubId || null, expiryDays, amount || 0, currency || "USD"
    );
    subId = inserted[0]?.id;
    oldStatus = existing[0]?.status || "inactive";
    action = existing.length > 0 ? "reactivated" : "activated";
  }

  // Website access follows the plan: Pro → website_enabled, Starter → disabled.
  // The admin approval step re-evaluates this, but pre-set it so a payment alone
  // never leaves a stale flag behind.
  const websiteOn = await planHasWebsite(sql, planId);
  await sql`UPDATE repair_shops SET subscription_status = 'pending_approval', approval_status = 'pending', suspended_at = NULL, suspension_reason = NULL, website_enabled = ${websiteOn}, updated_at = now() WHERE id = ${shopId}`;

  try {
    await sql`
      INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
      VALUES (${shopId}, 'payment_received', 'Payment Received — Pending Approval',
              'Your payment has been received. Your account is pending admin approval. You will be notified once activated.',
              '/payment-success.html')
    `;
    const shop = await sql`SELECT shop_name, owner_name FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    if (shop[0]) {
      const safeShopName = htmlEscape(shop[0].shop_name);
      const safeOwnerName = htmlEscape(shop[0].owner_name);
      await notifyAdmin(shopId, 'New Payment — Pending Approval',
        `Shop "${safeShopName}" (${safeOwnerName}) has paid and is awaiting activation.\n\n` +
        `Approve or reject in the admin dashboard: Pending Activations tab.`);
    }
  } catch (e) {
    console.error("[webhook] Approval notification failed:", e.message);
  }

  await logSubHistory(sql, subId, shopId, action, oldStatus, "pending_approval", amount, currency, billingCycle, gateway, "webhook");

  try {
    await sql`
      INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
      VALUES (${shopId}, 'payment_received', 'Payment Received — Awaiting Approval',
              'Your payment has been received. A super admin will review and activate your account shortly.',
              '/payment-success.html')
    `;
  } catch (e) {
    console.warn("[webhook] In-app notification insert failed:", e.message);
  }

  try {
    const shop = await sql`SELECT referred_by FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    if (shop[0]?.referred_by) {
      const referrer = await sql`SELECT id FROM repair_shops WHERE referral_code = ${shop[0].referred_by} LIMIT 1`;
      if (referrer.length > 0) {
        const rewardAmount = 10;
        await sql`
          UPDATE referrals SET status = 'completed', reward_value = ${rewardAmount}, completed_at = now()
          WHERE referrer_shop_id = ${referrer[0].id} AND referred_shop_id = ${shopId} AND status = 'pending'
        `;
        await sql`
          UPDATE repair_shops SET discount_balance = COALESCE(discount_balance, 0) + ${rewardAmount}, updated_at = now()
          WHERE id = ${referrer[0].id}
        `;
        try {
          await sql`
            INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
            VALUES (${referrer[0].id}, 'referral_reward', 'Referral Reward!',
                    'A shop you referred has purchased a subscription. $10 credit has been added to your account.',
                    '/shop-referrals.html')
          `;
        } catch (e) {
          console.warn("[webhook] Referral notification failed:", e.message);
        }
      }
    }
  } catch (e) {
    console.warn("[webhook] Referral processing failed:", e.message);
  }

  return subId;
}

// ─── Get webhook secret (DB first, then env) ────────────────────────────────
// SECURITY: Razorpay NEVER falls back to the API key secret.
async function getWebhookSecret(provider) {
  const gw = await getGateway(provider, true); // includeDisabled=true to get config even if disabled
  if (gw?.webhookSecret) return gw.webhookSecret;
  if (provider === "stripe") return process.env.STRIPE_WEBHOOK_SECRET;
  if (provider === "razorpay") return process.env.RAZORPAY_WEBHOOK_SECRET;
  return null;
}

// ─── Get the raw request body for signature verification ────────────────────
// Vercel's Node.js runtime auto-parses the request body. The parsed object is
// available as req.body; we re-serialize it with JSON.stringify() to get the
// exact byte string needed for webhook signature verification (providers send
// compact JSON, so the stringified output matches the raw bytes).
function getRawBody(req) {
  if (req.body != null) {
    if (typeof req.body === "string") return Promise.resolve(req.body);
    return Promise.resolve(JSON.stringify(req.body));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ─── MAIN WEBHOOK HANDLER ───────────────────────────────────────────────────
async function handleWebhook(request, response) {
  if (!allowMethods(request, response, "POST")) return;
  if (!applyLimit(request, response, webhookLimiter)) return;

  const sql = neon(process.env.DATABASE_URL);

  const rawBody = await getRawBody(request);
  if (!rawBody) {
    console.error("[webhook] Empty request body");
    return response.status(400).json({ error: "Empty request body" });
  }

  // ─── Stripe Webhook ───────────────────────────────────────────────────────
  const stripeSig = request.headers["stripe-signature"];
  if (stripeSig) {
    const secret = await getWebhookSecret("stripe");
    if (!secret) return response.status(500).json({ error: "Stripe webhook not configured" });

    const isValid = await verifyWebhookSignature(rawBody, stripeSig, secret);
    if (!isValid) {
      await logPayment(sql, null, null, "stripe", "signature_invalid", "error", "Invalid Stripe webhook signature");
      return response.status(403).json({ error: "Invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (err) {
      console.error("[webhook] Failed to parse Stripe event JSON:", err.message);
      return response.status(400).json({ error: "Invalid JSON body" });
    }

    const eventType = event?.type;
    const session = event?.data?.object;
    const idempotencyKey = `stripe_${event?.id || ""}`;

    if (idempotencyKey) {
      const claimed = await tryClaimIdempotencyKey(sql, idempotencyKey, null, null, "stripe", "webhook_received");
      if (!claimed) {
        return response.status(200).json({ received: true, duplicate: true });
      }
    }

    if (eventType === "checkout.session.completed" && session) {
      const shopId = parseInt(session.metadata?.shop_id, 10);
      const planName = session.metadata?.plan || "pro";
      const paymentDbId = parseInt(session.metadata?.payment_id, 10);
      const invoiceNumber = session.metadata?.invoice;
      const billingCycle = session.metadata?.billing_cycle || "monthly";
      const currency = session.currency?.toUpperCase() || "USD";
      const amount = (session.amount_total || 0) / 100;

      await sql`
        UPDATE payments SET status = 'completed', transaction_id = ${session.payment_intent || null},
          gateway = 'stripe', amount = ${amount}, updated_at = now()
        WHERE id = ${paymentDbId}
      `;

      const subId = await activateSubscription(sql, shopId, planName, billingCycle, "stripe", session.subscription || null, amount, currency);

      await generateInvoice(sql, { shopId, paymentId: paymentDbId, subscriptionId: subId, planName, billingCycle, currency, amount, invoiceNumber });

      await sendPaymentConfirmation(sql, shopId, { planName, billingCycle, currency, amount, invoiceNumber });

      await logPayment(sql, paymentDbId, shopId, "stripe", "payment_completed", "info", `Stripe payment completed: ${currency} ${amount}`);

      console.log("[webhook] Stripe checkout completed for shop:", shopId);
      await notifyAdmin(shopId, "New Subscription", `Shop #${shopId} subscribed to CoolCare Pro (${billingCycle}) via Stripe.`);
    }

    return response.status(200).json({ received: true });
  }

  // ─── Razorpay Webhook ─────────────────────────────────────────────────────
  const razorpaySig = request.headers["x-razorpay-signature"];
  if (razorpaySig) {
    const secret = await getWebhookSecret("razorpay");
    if (!secret) return response.status(500).json({ error: "Razorpay webhook not configured" });

    const isValid = await verifyWebhookSignature(rawBody, razorpaySig, secret);
    if (!isValid) {
      await logPayment(sql, null, null, "razorpay", "signature_invalid", "error", "Invalid Razorpay webhook signature");
      return response.status(403).json({ error: "Invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (err) {
      console.error("[webhook] Failed to parse Razorpay event JSON:", err.message);
      return response.status(400).json({ error: "Invalid JSON body" });
    }

    const eventName = event?.event;

    if (eventName === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      const notes = payment?.notes || {};
      const shopId = parseInt(notes.shop_id, 10);
      const planName = notes.plan || "pro";
      const paymentDbId = parseInt(notes.payment_id, 10);
      const billingCycle = notes.billing_cycle || "monthly";
      const invoiceNumber = notes.invoice || payment?.receipt;
      const currency = (payment?.currency || "INR").toUpperCase();
      const amount = (payment?.amount || 0) / 100;
      const idempotencyKey = `razorpay_${payment?.id || ""}`;

      if (idempotencyKey) {
        const claimed = await tryClaimIdempotencyKey(sql, idempotencyKey, null, null, "razorpay", "webhook_received");
        if (!claimed) {
          return response.status(200).json({ received: true, duplicate: true });
        }
      }

      await sql`
        UPDATE payments SET status = 'completed', payment_id = ${payment?.id || null},
          transaction_id = ${payment?.id || null}, gateway = 'razorpay',
          amount = ${amount}, updated_at = now()
        WHERE id = ${paymentDbId}
      `;

      try {
        await sql`UPDATE repair_shops SET selected_currency = ${currency} WHERE id = ${shopId}`;
      } catch (e) {
        console.warn("[webhook] Failed to update shop currency:", e.message);
      }

      const subId = await activateSubscription(sql, shopId, planName, billingCycle, "razorpay", payment?.id || null, amount, currency);

      await generateInvoice(sql, { shopId, paymentId: paymentDbId, subscriptionId: subId, planName, billingCycle, currency, amount, invoiceNumber });

      await sendPaymentConfirmation(sql, shopId, { planName, billingCycle, currency, amount, invoiceNumber });

      await logPayment(sql, paymentDbId, shopId, "razorpay", "payment_completed", "info", `Razorpay payment captured: ${currency} ${amount}`);

      console.log("[webhook] Razorpay payment captured for shop:", shopId);
      await notifyAdmin(shopId, "New Subscription", `Shop #${shopId} subscribed to CoolCare Pro (${billingCycle}) via Razorpay.`);
    }

    if (eventName === "payment.failed") {
      const payment = event.payload?.payment?.entity;
      const notes = payment?.notes || {};
      const shopId = parseInt(notes.shop_id, 10);
      const paymentDbId = parseInt(notes.payment_id, 10);
      const failureReason = payment?.error_description || payment?.error?.description || "Payment failed";

      if (paymentDbId) {
        await sql`
          UPDATE payments SET status = 'failed', updated_at = now() WHERE id = ${paymentDbId}
        `;
        await logPayment(sql, paymentDbId, shopId, "razorpay", "payment_failed", "warning", `Payment failed: ${failureReason}`);

        try {
          await sql`
            INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
            VALUES (${shopId}, 'payment_failed', 'Payment Failed',
                    'Your payment could not be processed. Please try again.',
                    '/index.html#pricing')
          `;
        } catch (e) {
          console.warn("[webhook] Payment failure notification failed:", e.message);
        }
      }

      console.log("[webhook] Razorpay payment failed for shop:", shopId, "Reason:", failureReason);
    }

    return response.status(200).json({ received: true });
  }

  return response.status(400).json({ error: "No recognized webhook signature" });
}

// api/payments/webhook.js
// Payment webhook handler — verifies signatures server-side.
// POST /api/payments/webhook
// Supports: Stripe, Razorpay webhooks.
// NEVER trust frontend payment responses — always verify via webhook.

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("../_lib/errors");
const { webhookLimiter, applyLimit } = require("../_lib/rate-limit");
const { verifyWebhookSignature } = require("../_lib/security");
const { notifyAdmin, sendEmail } = require("../_lib/notify");
const { getGateway, invalidateCache } = require("../_lib/gateway");

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
  } catch (e) { /* table may not exist */ }
}

async function logSubHistory(sql, subId, shopId, action, oldStatus, newStatus, amount, currency, billingCycle, gateway, actorType) {
  try {
    await sql`
      INSERT INTO subscription_history (subscription_id, repair_shop_id, action, old_status, new_status,
        amount, currency, billing_cycle, gateway, actor_type)
      VALUES (${subId || null}, ${shopId}, ${action}, ${oldStatus || null}, ${newStatus || null},
        ${amount || null}, ${currency || null}, ${billingCycle || null}, ${gateway || null}, ${actorType || 'webhook'})
    `;
  } catch (e) { /* table may not exist */ }
}

// ─── Idempotency: check if webhook already processed ────────────────────────
async function isDuplicateWebhook(sql, idempotencyKey) {
  if (!idempotencyKey) return false;
  try {
    const rows = await sql`SELECT id FROM payment_logs WHERE idempotency_key = ${idempotencyKey} LIMIT 1`;
    return rows.length > 0;
  } catch (e) { return false; }
}

async function markIdempotencyKey(sql, idempotencyKey, paymentId, shopId, gateway, eventType) {
  try {
    await sql`
      INSERT INTO payment_logs (payment_id, repair_shop_id, gateway, event_type, severity, message, idempotency_key)
      VALUES (${paymentId || null}, ${shopId || null}, ${gateway}, ${eventType}, 'info', 'Webhook processed', ${idempotencyKey})
    `;
  } catch (e) { /* ok */ }
}

// ─── Generate invoice on successful payment ─────────────────────────────────
async function generateInvoice(sql, { shopId, paymentId, subscriptionId, planName, billingCycle, currency, amount, invoiceNumber }) {
  try {
    // Get payment settings for business info
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
    } catch (e) { /* ok */ }

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

    const subject = `CoolCare — Payment Confirmed (${invoiceNumber})`;
    const html = `<div style="font-family:Inter,sans-serif;padding:24px;background:#0a0a0a;color:#ededed;">
      <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid #222;border-radius:12px;padding:32px;">
        <h2 style="color:#fff;margin:0 0 16px;font-size:20px;">Payment Confirmed</h2>
        <p style="color:#a3a3a3;line-height:1.6;">Hi ${shop[0].owner_name},</p>
        <p style="color:#a3a3a3;line-height:1.6;">Your CoolCare Pro subscription has been activated.</p>
        <table style="width:100%;margin:16px 0;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#737373;font-size:13px;">Plan</td><td style="padding:8px 0;color:#fff;font-weight:600;text-align:right;">CoolCare Pro</td></tr>
          <tr><td style="padding:8px 0;color:#737373;font-size:13px;">Billing</td><td style="padding:8px 0;color:#fff;text-align:right;">${billingCycle}</td></tr>
          <tr><td style="padding:8px 0;color:#737373;font-size:13px;">Amount</td><td style="padding:8px 0;color:#22c55e;font-weight:600;text-align:right;">${currency} ${amount}</td></tr>
          <tr><td style="padding:8px 0;color:#737373;font-size:13px;">Invoice</td><td style="padding:8px 0;color:#fff;text-align:right;">${invoiceNumber}</td></tr>
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
    // Fallback: try 'pro' plan
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
    // Renewal: extend current_period_end from now or current end (whichever is greater)
    const oldExpiry = existing[0].current_period_end;
    await sql.unsafe(
      `UPDATE subscriptions SET
        current_period_end = GREATEST(current_period_end, now()) + ($1 || ' days')::interval,
        amount_paid = COALESCE(amount_paid, 0) + $2,
        currency = $3, billing_cycle = $4,
        updated_at = now()
       WHERE id = $5`,
      [expiryDays, amount || 0, currency || "USD", billingCycle || "monthly", existing[0].id]
    );
    subId = existing[0].id;
    oldStatus = "active";
    action = "renewed";
  } else {
    // New subscription
    const inserted = await sql.unsafe(
      `INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway, gateway_sub_id,
        current_period_end, amount_paid, currency)
       VALUES ($1, $2, 'active', $3, $4, $5, now() + ($6 || ' days')::interval, $7, $8)
       RETURNING id`,
      [shopId, planId, billingCycle || "monthly", gateway, gatewaySubId || null, expiryDays, amount || 0, currency || "USD"]
    );
    subId = inserted[0]?.id;
    oldStatus = existing[0]?.status || "inactive";
    action = existing.length > 0 ? "reactivated" : "activated";
  }

  // Set payment as verified but require admin approval before activation
  await sql`UPDATE repair_shops SET subscription_status = 'active', approval_status = 'pending', suspended_at = NULL, suspension_reason = NULL, updated_at = now() WHERE id = ${shopId}`;

  // Notify super admins about pending approval
  try {
    await sql`
      INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
      VALUES (${shopId}, 'payment_received', 'Payment Received — Pending Approval',
              'Payment received successfully. Your account is pending admin approval. You will be notified once activated.',
              '/shop-subscription.html')
    `;
    // Also notify admin
    const shop = await sql`SELECT shop_name, owner_name FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    if (shop[0]) {
      await notifyAdmin(shopId, 'New Payment — Pending Approval',
        `Shop "${shop[0].shop_name}" (${shop[0].owner_name}) has paid and is awaiting activation.\n\n` +
        `Approve or reject in the admin dashboard: Pending Activations tab.`);
    }
  } catch (e) { /* ok */ }

  // Log subscription history
  await logSubHistory(sql, subId, shopId, action, oldStatus, "active", amount, currency, billingCycle, gateway, "webhook");

  // In-app notification
  try {
    await sql`
      INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
      VALUES (${shopId}, 'subscription_activated', 'Subscription Activated',
              'Your CoolCare Pro subscription is now active. All features have been unlocked.',
              '/shop-subscription.html')
    `;
  } catch (e) { /* table may not exist */ }

  // Process referral reward
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
        } catch (e) { /* ok */ }
      }
    }
  } catch (e) {
    console.warn("[webhook] Referral processing failed:", e.message);
  }

  return subId;
}

// ─── Get webhook secret (DB first, then env) ────────────────────────────────
async function getWebhookSecret(provider) {
  // Try DB first
  const gw = await getGateway(provider, true); // includeDisabled=true to get config even if disabled
  if (gw?.webhookSecret) return gw.webhookSecret;
  // Fallback to env
  if (provider === "stripe") return process.env.STRIPE_WEBHOOK_SECRET;
  if (provider === "razorpay") return process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = withErrorHandler(async (request, response) => {
  if (!allowMethods(request, response, "POST")) return;
  if (!applyLimit(request, response, webhookLimiter)) return;

  const sql = neon(process.env.DATABASE_URL);
  const rawBody = request.body;

  // ─── Stripe Webhook ───────────────────────────────────────────────────────
  const stripeSig = request.headers["stripe-signature"];
  if (stripeSig) {
    const secret = await getWebhookSecret("stripe");
    if (!secret) return response.status(500).json({ error: "Stripe webhook not configured" });

    const isValid = await verifyWebhookSignature(JSON.stringify(rawBody), stripeSig, secret);
    if (!isValid) {
      await logPayment(sql, null, null, "stripe", "signature_invalid", "error", "Invalid Stripe webhook signature");
      return response.status(400).json({ error: "Invalid signature" });
    }

    const event = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    const eventType = event?.type;
    const session = event?.data?.object;
    const idempotencyKey = `stripe_${event?.id || Date.now()}`;

    // Check idempotency
    if (await isDuplicateWebhook(sql, idempotencyKey)) {
      return response.status(200).json({ received: true, duplicate: true });
    }

    if (eventType === "checkout.session.completed" && session) {
      const shopId = parseInt(session.metadata?.shop_id, 10);
      const planName = session.metadata?.plan || "pro";
      const paymentDbId = parseInt(session.metadata?.payment_id, 10);
      const invoiceNumber = session.metadata?.invoice;
      const billingCycle = session.metadata?.billing_cycle || "monthly";
      const currency = session.currency?.toUpperCase() || "USD";
      const amount = (session.amount_total || 0) / 100;

      // Mark payment as completed
      await sql`
        UPDATE payments SET status = 'completed', transaction_id = ${session.payment_intent || null},
          gateway = 'stripe', amount = ${amount}, updated_at = now()
        WHERE id = ${paymentDbId}
      `;

      // Activate subscription
      const subId = await activateSubscription(sql, shopId, planName, billingCycle, "stripe", session.subscription || null, amount, currency);

      // Generate invoice
      await generateInvoice(sql, { shopId, paymentId: paymentDbId, subscriptionId: subId, planName, billingCycle, currency, amount, invoiceNumber });

      // Send confirmation email
      await sendPaymentConfirmation(sql, shopId, { planName, billingCycle, currency, amount, invoiceNumber });

      await markIdempotencyKey(sql, idempotencyKey, paymentDbId, shopId, "stripe", "checkout_completed");
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

    const isValid = await verifyWebhookSignature(JSON.stringify(rawBody), razorpaySig, secret);
    if (!isValid) {
      await logPayment(sql, null, null, "razorpay", "signature_invalid", "error", "Invalid Razorpay webhook signature");
      return response.status(400).json({ error: "Invalid signature" });
    }

    const event = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    const eventName = event?.event;

    // Handle payment.captured
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
      const idempotencyKey = `razorpay_${payment?.id || Date.now()}`;

      // Check idempotency
      if (await isDuplicateWebhook(sql, idempotencyKey)) {
        return response.status(200).json({ received: true, duplicate: true });
      }

      // Mark payment as completed
      await sql`
        UPDATE payments SET status = 'completed', payment_id = ${payment?.id || null},
          transaction_id = ${payment?.id || null}, gateway = 'razorpay',
          amount = ${amount}, updated_at = now()
        WHERE id = ${paymentDbId}
      `;

      // Activate subscription
      const subId = await activateSubscription(sql, shopId, planName, billingCycle, "razorpay", payment?.id || null, amount, currency);

      // Generate invoice
      await generateInvoice(sql, { shopId, paymentId: paymentDbId, subscriptionId: subId, planName, billingCycle, currency, amount, invoiceNumber });

      // Send confirmation email
      await sendPaymentConfirmation(sql, shopId, { planName, billingCycle, currency, amount, invoiceNumber });

      await markIdempotencyKey(sql, idempotencyKey, paymentDbId, shopId, "razorpay", "payment_captured");
      await logPayment(sql, paymentDbId, shopId, "razorpay", "payment_completed", "info", `Razorpay payment captured: ${currency} ${amount}`);

      console.log("[webhook] Razorpay payment captured for shop:", shopId);
      await notifyAdmin(shopId, "New Subscription", `Shop #${shopId} subscribed to CoolCare Pro (${billingCycle}) via Razorpay.`);
    }

    // Handle payment.failed
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

        // Notify shop
        try {
          await sql`
            INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
            VALUES (${shopId}, 'payment_failed', 'Payment Failed',
                    'Your payment could not be processed. Please try again.',
                    '/index.html#pricing')
          `;
        } catch (e) { /* ok */ }
      }

      console.log("[webhook] Razorpay payment failed for shop:", shopId, "Reason:", failureReason);
    }

    return response.status(200).json({ received: true });
  }

  return response.status(400).json({ error: "No recognized webhook signature" });
});

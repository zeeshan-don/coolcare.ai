// api/payments/webhook.js
// Payment webhook handler — verifies signatures server-side.
// POST /api/payments/webhook
// Supports: Stripe, Razorpay webhooks.
// NEVER trust frontend payment responses — always verify via webhook.

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("../_lib/errors");
const { webhookLimiter, applyLimit } = require("../_lib/rate-limit");
const { verifyWebhookSignature } = require("../_lib/security");
const { notifyAdmin } = require("../_lib/notify");

// Calculate expiry interval based on billing cycle
function getExpiryInterval(billingCycle) {
  switch (billingCycle) {
    case "quarterly": return "90 days";
    case "halfyearly": return "180 days";
    case "yearly": return "365 days";
    default: return "30 days";
  }
}

// Activate subscription + process referral + send notifications
async function activateSubscription(sql, shopId, planName, billingCycle, gateway, gatewaySubId) {
  const plans = await sql`SELECT id FROM subscription_plans WHERE name = ${planName} LIMIT 1`;
  if (plans.length === 0) return;

  const expiryDays = getExpiryInterval(billingCycle || "monthly");

  // Check for existing active subscription (renewal) vs new subscription
  const existing = await sql`
    SELECT id, current_period_end FROM subscriptions
    WHERE repair_shop_id = ${shopId} AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `;

  if (existing.length > 0) {
    // Renewal: extend current_period_end from now (or from current end if not yet expired)
    await sql.unsafe(
      `UPDATE subscriptions SET current_period_end = GREATEST(current_period_end, now()) + ($1 || ' days')::interval, updated_at = now() WHERE id = $2`,
      [expiryDays.replace(' days', ''), existing[0].id]
    );
  } else {
    // New subscription
    await sql.unsafe(
      `INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway, gateway_sub_id, current_period_end)
       VALUES ($1, $2, 'active', $3, $4, $5, now() + ($6 || ' days')::interval)`,
      [shopId, plans[0].id, billingCycle || "monthly", gateway, gatewaySubId || null, expiryDays.replace(' days', '')]
    );
  }

  // Activate shop
  await sql`UPDATE repair_shops SET subscription_status = 'active', suspended_at = NULL, suspension_reason = NULL, updated_at = now() WHERE id = ${shopId}`;

  // Create in-app notification
  try {
    await sql`
      INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
      VALUES (${shopId}, 'subscription_activated', 'Subscription Activated',
              'Your ${planName} subscription is now active. All features have been unlocked.',
              '/shop-dashboard.html')
    `;
  } catch (e) { /* table may not exist */ }

  // Process referral reward
  try {
    const shop = await sql`SELECT referred_by FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    if (shop[0]?.referred_by) {
      const referrer = await sql`SELECT id FROM repair_shops WHERE referral_code = ${shop[0].referred_by} LIMIT 1`;
      if (referrer.length > 0) {
        const rewardAmount = 10; // $10 credit
        await sql`
          UPDATE referrals SET status = 'completed', reward_value = ${rewardAmount}, completed_at = now()
          WHERE referrer_shop_id = ${referrer[0].id} AND referred_shop_id = ${shopId} AND status = 'pending'
        `;
        await sql`
          UPDATE repair_shops SET discount_balance = COALESCE(discount_balance, 0) + ${rewardAmount}, updated_at = now()
          WHERE id = ${referrer[0].id}
        `;
        // Notify referrer
        try {
          await sql`
            INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
            VALUES (${referrer[0].id}, 'referral_reward', 'Referral Reward!',
                    'A shop you referred has purchased a subscription. $${rewardAmount} credit has been added to your account.',
                    '/shop-referrals.html')
          `;
        } catch (e) { /* ok */ }
      }
    }
  } catch (e) {
    console.warn("[webhook] Referral processing failed:", e.message);
  }
}

module.exports = withErrorHandler(async (request, response) => {
  if (!allowMethods(request, response, "POST")) return;
  if (!applyLimit(request, response, webhookLimiter)) return;

  const sql = neon(process.env.DATABASE_URL);
  const rawBody = request.body;

  // ─── Stripe Webhook ───────────────────────────────────────────────────────
  const stripeSig = request.headers["stripe-signature"];
  if (stripeSig) {
    const stripeSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripeSecret) return response.status(500).json({ error: "Stripe webhook not configured" });

    const isValid = await verifyWebhookSignature(
      JSON.stringify(rawBody), stripeSig, stripeSecret
    );
    if (!isValid) return response.status(400).json({ error: "Invalid signature" });

    const event = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    const eventType = event?.type;
    const session = event?.data?.object;

    if (eventType === "checkout.session.completed" && session) {
      const shopId = parseInt(session.metadata?.shop_id, 10);
      const planName = session.metadata?.plan;
      const paymentDbId = parseInt(session.metadata?.payment_id, 10);
      const invoiceNumber = session.metadata?.invoice;
      const billingCycle = session.metadata?.billing_cycle || "monthly";

      // Mark payment as completed
      await sql`
        UPDATE payments SET
          status = 'completed',
          transaction_id = ${session.payment_intent || null},
          gateway = 'stripe',
          updated_at = now()
        WHERE id = ${paymentDbId}
      `;

      // Activate subscription + referral
      await activateSubscription(sql, shopId, planName, billingCycle, "stripe", session.subscription || null);

      console.log("[webhook] Stripe checkout completed for shop:", shopId);
      await notifyAdmin(shopId, "New Subscription", `Shop #${shopId} subscribed to ${planName} via Stripe.`);
    }

    return response.status(200).json({ received: true });
  }

  // ─── Razorpay Webhook ─────────────────────────────────────────────────────
  const razorpaySig = request.headers["x-razorpay-signature"];
  if (razorpaySig) {
    const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!razorpaySecret) return response.status(500).json({ error: "Razorpay webhook not configured" });

    const isValid = await verifyWebhookSignature(
      JSON.stringify(rawBody), razorpaySig, razorpaySecret
    );
    if (!isValid) return response.status(400).json({ error: "Invalid signature" });

    const event = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;

    if (event?.event === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      const notes = payment?.notes || {};

      const shopId = parseInt(notes.shop_id, 10);
      const planName = notes.plan;
      const paymentDbId = parseInt(notes.payment_id, 10);
      const billingCycle = notes.billing_cycle || "monthly";

      // Mark payment as completed
      await sql`
        UPDATE payments SET
          status = 'completed',
          payment_id = ${payment?.id || null},
          transaction_id = ${payment?.id || null},
          gateway = 'razorpay',
          amount = ${(payment?.amount || 0) / 100},
          updated_at = now()
        WHERE id = ${paymentDbId}
      `;

      // Activate subscription + referral
      await activateSubscription(sql, shopId, planName, billingCycle, "razorpay", payment?.id || null);

      console.log("[webhook] Razorpay payment captured for shop:", shopId);
    }

    return response.status(200).json({ received: true });
  }

  return response.status(400).json({ error: "No recognized webhook signature" });
});

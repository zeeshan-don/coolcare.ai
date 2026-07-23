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

    // Verify signature
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

      // Mark payment as completed
      await sql`
        UPDATE payments SET
          status = 'completed',
          transaction_id = ${session.payment_intent || null},
          gateway = 'stripe',
          updated_at = now()
        WHERE id = ${paymentDbId}
      `;

      // Create or update subscription
      const plans = await sql`SELECT id FROM subscription_plans WHERE name = ${planName} LIMIT 1`;
      if (plans.length > 0) {
        const billingCycle = session.mode === "subscription" &&
          session.subscription ? "monthly" : "monthly";
        await sql`
          INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway, gateway_sub_id, current_period_end)
          VALUES (${shopId}, ${plans[0].id}, 'active', ${billingCycle}, 'stripe',
                  ${session.subscription || null}, now() + INTERVAL '30 days')
          ON CONFLICT (repair_shop_id) DO UPDATE SET
            plan_id = ${plans[0].id},
            status = 'active',
            gateway = 'stripe',
            gateway_sub_id = ${session.subscription || null},
            current_period_end = now() + INTERVAL '30 days',
            updated_at = now()
        `;
      }

      // Update shop subscription status
      await sql`UPDATE repair_shops SET subscription_status = 'active' WHERE id = ${shopId}`;

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
      const orderId = payment?.order_id;
      const notes = payment?.notes || {};

      const shopId = parseInt(notes.shop_id, 10);
      const planName = notes.plan;
      const paymentDbId = parseInt(notes.payment_id, 10);

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

      // Activate subscription
      const plans = await sql`SELECT id FROM subscription_plans WHERE name = ${planName} LIMIT 1`;
      if (plans.length > 0) {
        await sql`
          INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway, gateway_sub_id, current_period_end)
          VALUES (${shopId}, ${plans[0].id}, 'active', 'monthly', 'razorpay',
                  ${payment?.id || null}, now() + INTERVAL '30 days')
          ON CONFLICT (repair_shop_id) DO UPDATE SET
            plan_id = ${plans[0].id},
            status = 'active',
            gateway = 'razorpay',
            current_period_end = now() + INTERVAL '30 days',
            updated_at = now()
        `;
      }

      await sql`UPDATE repair_shops SET subscription_status = 'active' WHERE id = ${shopId}`;
      console.log("[webhook] Razorpay payment captured for shop:", shopId);
    }

    return response.status(200).json({ received: true });
  }

  return response.status(400).json({ error: "No recognized webhook signature" });
});

// api/payments/subscription.js
// Manage subscription — cancel, upgrade, downgrade, view current plan.
// GET /api/payments/subscription — view current subscription
// POST /api/payments/subscription — cancel/upgrade/downgrade
// Body: { action: "cancel" | "upgrade" | "downgrade", planName? }

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../_lib/auth");
const { withErrorHandler, allowMethods } = require("../_lib/errors");
const { validate, z } = require("../_lib/validate");
const { apiLimiter, applyLimit } = require("../_lib/rate-limit");
const { setSecurityHeaders } = require("../_lib/security");

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

  // GET: view current subscription
  if (request.method === "GET") {
    const subs = await sql`
      SELECT s.*, sp.name as plan_name, sp.display_name, sp.price_monthly_usd,
             sp.price_yearly_usd, sp.max_bookings, sp.max_technicians, sp.features
      FROM subscriptions s
      JOIN subscription_plans sp ON sp.id = s.plan_id
      WHERE s.repair_shop_id = ${shopId}
      ORDER BY s.created_at DESC
      LIMIT 1
    `;

    const payments = await sql`
      SELECT id, payment_id, transaction_id, gateway, currency, amount, status,
             invoice_number, description, created_at
      FROM payments
      WHERE repair_shop_id = ${shopId}
      ORDER BY created_at DESC
      LIMIT 20
    `;

    return response.status(200).json({
      subscription: subs[0] || null,
      payments,
    });
  }

  if (!allowMethods(request, response, "POST")) return;

  const data = validate(request, response, subActionSchema);
  if (!data) return;

  // Fetch current subscription
  const current = await sql`
    SELECT s.*, sp.name as plan_name FROM subscriptions s
    JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.repair_shop_id = ${shopId}
    ORDER BY s.created_at DESC LIMIT 1
  `;

  if (current.length === 0) {
    return response.status(404).json({ error: "No active subscription found" });
  }

  const sub = current[0];

  if (data.action === "cancel") {
    await sql`
      UPDATE subscriptions SET
        status = 'cancelled',
        cancel_at = current_period_end,
        updated_at = now()
      WHERE id = ${sub.id}
    `;
    return response.status(200).json({ message: "Subscription cancelled. Access continues until period end." });
  }

  if (data.action === "reactivate") {
    await sql`
      UPDATE subscriptions SET
        status = 'active',
        cancel_at = NULL,
        updated_at = now()
      WHERE id = ${sub.id}
    `;
    return response.status(200).json({ message: "Subscription reactivated." });
  }

  if (data.action === "upgrade" || data.action === "downgrade") {
    if (!data.planName) {
      return response.status(400).json({ error: "planName is required for upgrade/downgrade" });
    }

    const newPlan = await sql`
      SELECT * FROM subscription_plans WHERE name = ${data.planName} LIMIT 1
    `;
    if (newPlan.length === 0) {
      return response.status(404).json({ error: "Plan not found" });
    }

    await sql`
      UPDATE subscriptions SET
        plan_id = ${newPlan[0].id},
        updated_at = now()
      WHERE id = ${sub.id}
    `;

    return response.status(200).json({
      message: `Subscription ${data.action}d to ${data.planName}.`,
      newPlan: newPlan[0],
    });
  }

  return response.status(400).json({ error: "Invalid action" });
});

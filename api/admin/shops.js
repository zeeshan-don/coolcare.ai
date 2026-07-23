// api/admin/shops.js
// Super Admin — manage all shops, subscriptions, platform.
// GET /api/admin/shops — list all shops with subscription info
// POST /api/admin/shops — suspend/activate/delete a shop
// Body: { shopId, action: "suspend" | "activate" | "delete", reason? }
// Security: Only super_admin or admin role can access.

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../_lib/auth");
const { withErrorHandler, allowMethods, errors } = require("../_lib/errors");
const { validate, z } = require("../_lib/validate");
const { apiLimiter, applyLimit } = require("../_lib/rate-limit");
const { setSecurityHeaders } = require("../_lib/security");

const adminActionSchema = z.object({
  shopId: z.coerce.number().int().positive(),
  action: z.enum(["suspend", "activate", "delete"]),
  reason: z.string().max(500).optional(),
});

// Verify the authenticated user is an admin
async function requireAdmin(auth, response) {
  const sql = neon(process.env.DATABASE_URL);
  const shop = await sql`SELECT role FROM repair_shops WHERE id = ${parseInt(auth.sub, 10)} LIMIT 1`;
  if (!shop.length || !["admin", "super_admin"].includes(shop[0].role)) {
    response.status(403).json({ error: "Admin access required" });
    return null;
  }
  return shop[0];
}

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const admin = await requireAdmin(auth, response);
  if (!admin) return;

  const sql = neon(process.env.DATABASE_URL);

  // GET: list all shops with stats
  if (request.method === "GET") {
    const page = parseInt(request.query?.page || "1", 10);
    const limit = Math.min(parseInt(request.query?.limit || "20", 10), 100);
    const offset = (page - 1) * limit;
    const search = request.query?.search || "";

    let shops;
    if (search) {
      shops = await sql`
        SELECT rs.id, rs.shop_name, rs.owner_name, rs.email, rs.mobile, rs.city,
               rs.role, rs.is_active, rs.subscription_status, rs.suspended_at, rs.created_at,
               (SELECT COUNT(*) FROM bookings WHERE repair_shop_id = rs.id) as total_bookings,
               (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE repair_shop_id = rs.id AND status = 'completed') as total_revenue,
               (SELECT sp.display_name FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id WHERE s.repair_shop_id = rs.id ORDER BY s.created_at DESC LIMIT 1) as plan_name
        FROM repair_shops rs
        WHERE rs.shop_name ILIKE ${"%" + search + "%"} OR rs.email ILIKE ${"%" + search + "%"}
        ORDER BY rs.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      shops = await sql`
        SELECT rs.id, rs.shop_name, rs.owner_name, rs.email, rs.mobile, rs.city,
               rs.role, rs.is_active, rs.subscription_status, rs.suspended_at, rs.created_at,
               (SELECT COUNT(*) FROM bookings WHERE repair_shop_id = rs.id) as total_bookings,
               (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE repair_shop_id = rs.id AND status = 'completed') as total_revenue,
               (SELECT sp.display_name FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id WHERE s.repair_shop_id = rs.id ORDER BY s.created_at DESC LIMIT 1) as plan_name
        FROM repair_shops rs
        ORDER BY rs.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }

    const total = await sql`SELECT COUNT(*) as count FROM repair_shops`;

    // Platform analytics
    const analytics = await sql`
      SELECT
        (SELECT COUNT(*) FROM repair_shops) as total_shops,
        (SELECT COUNT(*) FROM repair_shops WHERE is_active = true AND suspended_at IS NULL) as active_shops,
        (SELECT COUNT(*) FROM bookings) as total_bookings,
        (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE status = 'completed') as total_revenue,
        (SELECT COUNT(*) FROM subscriptions WHERE status = 'active') as active_subscriptions,
        (SELECT COUNT(*) FROM bookings WHERE created_at >= date_trunc('day', now())) as bookings_today
    `;

    return response.status(200).json({
      shops,
      pagination: { page, limit, total: parseInt(total[0].count, 10) },
      analytics: analytics[0] || {},
    });
  }

  // POST: manage shop
  if (!allowMethods(request, response, "POST")) return;

  const data = validate(request, response, adminActionSchema);
  if (!data) return;

  if (data.action === "suspend") {
    await sql`
      UPDATE repair_shops SET
        suspended_at = now(),
        suspension_reason = ${data.reason || null},
        updated_at = now()
      WHERE id = ${data.shopId}
    `;
    console.log(`[admin] Shop #${data.shopId} suspended by admin #${auth.sub}`);
    return response.status(200).json({ message: "Shop suspended" });
  }

  if (data.action === "activate") {
    await sql`
      UPDATE repair_shops SET
        suspended_at = NULL,
        suspension_reason = NULL,
        is_active = true,
        updated_at = now()
      WHERE id = ${data.shopId}
    `;
    return response.status(200).json({ message: "Shop activated" });
  }

  if (data.action === "delete") {
    await sql`DELETE FROM repair_shops WHERE id = ${data.shopId}`;
    console.log(`[admin] Shop #${data.shopId} deleted by admin #${auth.sub}`);
    return response.status(200).json({ message: "Shop deleted" });
  }

  return response.status(400).json({ error: "Invalid action" });
});

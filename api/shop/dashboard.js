// api/shop/dashboard.js
// Protected repair shop dashboard — full stats, pagination, search, filters.
// GET /api/shop/dashboard?page=1&limit=20&status=open&search=raj
// Headers: Authorization: Bearer <token>
// Multi-tenancy: ALL queries filtered by shop_id.

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../_lib/auth");
const { withErrorHandler, allowMethods } = require("../_lib/errors");
const { apiLimiter, applyLimit } = require("../_lib/rate-limit");
const { setSecurityHeaders } = require("../_lib/security");
const { z } = require("zod");

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(),
  search: z.string().optional(),
  sortBy: z.enum(["created_at", "updated_at", "status"]).default("created_at"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "GET")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const sql = neon(process.env.DATABASE_URL);

  // Parse query params
  const q = querySchema.safeParse(request.query || {});
  const params = q.success ? q.data : { page: 1, limit: 20, sortBy: "created_at", sortDir: "desc" };
  const offset = (params.page - 1) * params.limit;

  // Build WHERE clause dynamically
  const conditions = [`b.repair_shop_id = ${shopId}`];
  const sqlParams = [shopId];

  // Status filter
  if (params.status && params.status !== "all") {
    sqlParams.push(params.status);
    conditions.push(`b.status = $${sqlParams.length}`);
  }

  // Search filter (name or phone)
  if (params.search) {
    sqlParams.push(`%${params.search}%`);
    conditions.push(`(b.customer_name ILIKE $${sqlParams.length} OR b.customer_number ILIKE $${sqlParams.length})`);
  }

  const whereClause = conditions.join(" AND ");

  // Sort column whitelist
  const sortCol = ["created_at", "updated_at", "status"].includes(params.sortBy) ? params.sortBy : "created_at";
  const sortDir = params.sortDir === "asc" ? "ASC" : "DESC";

  // Paginated bookings query
  const bookings = await sql.unsafe(`
    SELECT
      b.id, b.customer_number, b.customer_name, b.service_type, b.area,
      COALESCE(b.address, b.area, '') AS address,
      b.urgency, b.status, b.technician_id, b.technician_name,
      b.technician_notes, b.estimated_cost, b.final_cost,
      b.priority, b.customer_notes, b.invoice_number,
      b.created_at, b.updated_at,
      t.name AS assigned_technician_name,
      t.phone AS assigned_technician_phone
    FROM bookings b
    LEFT JOIN technicians t ON t.id = b.technician_id
    WHERE ${whereClause}
    ORDER BY b.${sortCol} ${sortDir}
    LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}
  `, [...sqlParams, params.limit, offset]);

  // Total count for pagination
  const countResult = await sql.unsafe(`
    SELECT COUNT(*) as total FROM bookings b WHERE ${whereClause}
  `, sqlParams);
  const total = parseInt(countResult[0]?.total || "0", 10);

  // Status counts (all statuses, not filtered by status param)
  const counts = await sql`
    SELECT status, COUNT(*) as count
    FROM bookings
    WHERE repair_shop_id = ${shopId}
    GROUP BY status
  `;
  const statusCounts = { open: 0, accepted: 0, assigned: 0, on_the_way: 0, arrived: 0, completed: 0, cancelled: 0, rejected: 0 };
  counts.forEach((r) => { if (statusCounts[r.status] !== undefined) statusCounts[r.status] = parseInt(r.count, 10); });

  // Revenue stats (sum of final_cost for completed bookings)
  const revenueResult = await sql`
    SELECT
      COALESCE(SUM(final_cost), 0) as total_revenue,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', now()) THEN final_cost ELSE 0 END), 0) as monthly_revenue,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('week', now()) THEN final_cost ELSE 0 END), 0) as weekly_revenue
    FROM bookings
    WHERE repair_shop_id = ${shopId} AND status = 'completed'
  `;
  const revenue = revenueResult[0] || { total_revenue: 0, monthly_revenue: 0, weekly_revenue: 0 };

  // Today's bookings count
  const todayResult = await sql`
    SELECT COUNT(*) as count FROM bookings
    WHERE repair_shop_id = ${shopId}
      AND created_at >= date_trunc('day', now())
  `;
  const todayBookings = parseInt(todayResult[0]?.count || "0", 10);

  // Pending jobs (open + accepted + assigned)
  const pendingResult = await sql`
    SELECT COUNT(*) as count FROM bookings
    WHERE repair_shop_id = ${shopId}
      AND status IN ('open', 'accepted', 'assigned', 'on_the_way', 'arrived')
  `;
  const pendingJobs = parseInt(pendingResult[0]?.count || "0", 10);

  // Weekly bookings (last 7 days, per day)
  const weeklyResult = await sql`
    SELECT
      date_trunc('day', created_at)::date as date,
      COUNT(*) as count
    FROM bookings
    WHERE repair_shop_id = ${shopId}
      AND created_at >= now() - INTERVAL '7 days'
    GROUP BY date_trunc('day', created_at)::date
    ORDER BY date ASC
  `;

  // Recent customers (last 10 unique)
  const recentCustomers = await sql`
    SELECT DISTINCT ON (customer_number)
      customer_number, customer_name, MAX(created_at) as last_booking
    FROM bookings
    WHERE repair_shop_id = ${shopId}
    GROUP BY customer_number, customer_name
    ORDER BY customer_number, last_booking DESC
    LIMIT 10
  `;

  // Shop info
  const shopRows = await sql`
    SELECT id, shop_name, owner_name, email, mobile, city, services_offered, service_areas, role
    FROM repair_shops
    WHERE id = ${shopId}
    LIMIT 1
  `;

  // Subscription info
  let subscription = null;
  try {
    const subRows = await sql`
      SELECT s.*, sp.name as plan_name, sp.display_name as plan_display, sp.features
      FROM subscriptions s
      JOIN subscription_plans sp ON sp.id = s.plan_id
      WHERE s.repair_shop_id = ${shopId}
      ORDER BY s.created_at DESC
      LIMIT 1
    `;
    subscription = subRows[0] || null;
  } catch (subErr) {
    // Table may not exist yet
  }

  return response.status(200).json({
    shop: shopRows[0] || null,
    counts: statusCounts,
    bookings,
    pagination: { page: params.page, limit: params.limit, total, totalPages: Math.ceil(total / params.limit) },
    stats: {
      todayBookings,
      pendingJobs,
      completedToday: statusCounts.completed,
      totalRevenue: parseFloat(revenue.total_revenue),
      monthlyRevenue: parseFloat(revenue.monthly_revenue),
      weeklyRevenue: parseFloat(revenue.weekly_revenue),
    },
    weeklyBookings: weeklyResult,
    recentCustomers: recentCustomers.map((c) => ({
      name: c.customer_name,
      phone: c.customer_number,
      lastBooking: c.last_booking,
    })),
    subscription,
  });
});

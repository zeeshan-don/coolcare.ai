// api/shop.js
// Consolidated shop + admin endpoint.
// GET  /api/shop?page=1&limit=20&status=open&search=raj  → dashboard
// GET  /api/shop?action=export&status=completed  → CSV export
// GET  /api/shop?action=booking&id=123  → single booking detail
// GET  /api/shop?action=admin → admin dashboard
// GET  /api/shop?action=admin-users → list users
// GET  /api/shop?action=admin-plans → list plans
// GET  /api/shop?action=admin-payments → list payments
// GET  /api/shop?action=admin-settings → get settings
// GET  /api/shop?action=admin-analytics → analytics
// POST /api/shop  body: { action: "update", bookingId, … } → update booking
// POST /api/shop  body: { action: "suspend|activate|delete", shopId } → shop admin
// POST /api/shop  body: { action: "edit-shop|approve-shop|reset-password", ... } → admin
// POST /api/shop  body: { action: "create-user|edit-user|delete-user|invite-user", ... } → user admin
// POST /api/shop  body: { action: "create-plan|edit-plan|delete-plan|duplicate-plan", ... } → plan admin
// POST /api/shop  body: { action: "save-settings", settings: {} } → settings

const { neon } = require("@neondatabase/serverless");
const { requireAuth, requireRole, requirePlatformAdmin, requireSuperAdmin, requireActiveSubscription, logAdminAction } = require("./_lib/auth");
const { notifyStatusChange } = require("./_lib/notify");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { validate, bookingUpdateSchema, createUserSchema, editUserSchema, createPlanSchema, editPlanSchema, settingsSchema, resetPasswordSchema } = require("./_lib/validate");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { z } = require("zod");
const bcrypt = require("bcryptjs");

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(),
  search: z.string().optional(),
  sortBy: z.enum(["created_at", "updated_at", "status"]).default("created_at"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

const planPricingSchema = z.object({
  planId: z.coerce.number().int().positive("planId is required"),
  currency: z.string().min(1, "Currency is required").max(10).trim(),
  price_monthly: z.coerce.number().min(0, "Monthly price must be >= 0"),
  price_quarterly: z.coerce.number().min(0, "Quarterly price must be >= 0"),
  price_halfyearly: z.coerce.number().min(0, "Half-yearly price must be >= 0"),
  price_yearly: z.coerce.number().min(0, "Yearly price must be >= 0"),
});

// Admin GET actions
const ADMIN_GET_ACTIONS = new Set(["admin", "admin-users", "admin-plans", "admin-pricing", "admin-payments", "admin-settings", "admin-analytics"]);
// Admin POST actions
const ADMIN_POST_ACTIONS = new Set([
  "suspend", "activate", "delete", "edit-shop", "approve-shop", "reset-password",
  "create-user", "edit-user", "delete-user", "invite-user",
  "create-plan", "edit-plan", "delete-plan", "duplicate-plan", "save-plan-pricing", "save-settings",
  "extend-subscription", "change-plan",
]);
// Gated shop actions (require active subscription)
const GATED_POST_ACTIONS = new Set(["update"]);
const GATED_GET_ACTIONS = new Set(["export"]);
// Non-gated shop GET actions (view-only, always allowed)
const OPEN_GET_ACTIONS = new Set(["dashboard", "booking", "referrals", "ai-settings", "whatsapp-status", "whatsapp-logs", "notifications", "shop-settings"]);

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const sql = neon(process.env.DATABASE_URL);

  if (request.method === "GET") {
    const action = request.query?.action || "dashboard";
    // Admin actions (platform admin check inside)
    if (ADMIN_GET_ACTIONS.has(action)) return handleAdminGet(request, response, sql, auth, action);
    // Non-gated actions (view-only or shop config)
    if (action === "dashboard") return handleDashboard(request, response, sql, shopId, auth);
    if (action === "booking") return handleBookingDetail(request, response, sql, shopId);
    if (OPEN_GET_ACTIONS.has(action)) return handleShopGet(request, response, sql, shopId, auth, action);
    // Gated actions
    if (GATED_GET_ACTIONS.has(action)) {
      const sub = await requireActiveSubscription(auth, sql, response);
      if (!sub) return;
      if (action === "export") return handleExport(request, response, sql, shopId);
    }
    return response.status(400).json({ error: "Invalid GET action" });
  }

  if (request.method === "POST") {
    const body = request.body || {};
    const action = body.action;
    // Admin actions
    if (ADMIN_POST_ACTIONS.has(action)) return handleAdminPost(request, response, sql, auth, body);
    // Gated actions (require active subscription)
    if (GATED_POST_ACTIONS.has(action)) {
      const sub = await requireActiveSubscription(auth, sql, response);
      if (!sub) return;
      if (action === "update") return handleBookingUpdate(request, response, sql, shopId, body);
    }
    // Non-gated POST actions
    if (action === "save-ai-settings") return handleSaveAiSettings(request, response, sql, shopId, body);
    if (action === "save-shop-settings") return handleSaveShopSettings(request, response, sql, shopId, body);
    if (action === "mark-notification-read") return handleMarkNotificationRead(request, response, sql, shopId, body);
    if (action === "send-test-whatsapp") return handleSendTestWhatsApp(request, response, sql, shopId);
    return response.status(400).json({ error: "Invalid POST action" });
  }

  return response.status(405).json({ error: "Method not allowed" });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════
async function handleDashboard(request, response, sql, shopId, auth) {
  if (!allowMethods(request, response, "GET")) return;

  const q = querySchema.safeParse(request.query || {});
  const params = q.success ? q.data : { page: 1, limit: 20, sortBy: "created_at", sortDir: "desc" };
  const offset = (params.page - 1) * params.limit;

  const conditions = [`b.repair_shop_id = ${shopId}`];
  const sqlParams = [shopId];
  if (params.status && params.status !== "all") { sqlParams.push(params.status); conditions.push(`b.status = $${sqlParams.length}`); }
  if (params.search) { sqlParams.push(`%${params.search}%`); conditions.push(`(b.customer_name ILIKE $${sqlParams.length} OR b.customer_number ILIKE $${sqlParams.length})`); }
  const whereClause = conditions.join(" AND ");
  const sortCol = ["created_at", "updated_at", "status"].includes(params.sortBy) ? params.sortBy : "created_at";
  const sortDir = params.sortDir === "asc" ? "ASC" : "DESC";

  const bookings = await sql.unsafe(`
    SELECT b.id, b.customer_number, b.customer_name, b.service_type, b.area,
           COALESCE(b.address, b.area, '') AS address,
           b.urgency, b.status, b.technician_id, b.technician_name,
           b.technician_notes, b.estimated_cost, b.final_cost,
           b.priority, b.customer_notes, b.invoice_number,
           b.created_at, b.updated_at,
           t.name AS assigned_technician_name, t.phone AS assigned_technician_phone
    FROM bookings b LEFT JOIN technicians t ON t.id = b.technician_id
    WHERE ${whereClause}
    ORDER BY b.${sortCol} ${sortDir}
    LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}
  `, [...sqlParams, params.limit, offset]);

  const countResult = await sql.unsafe(`SELECT COUNT(*) as total FROM bookings b WHERE ${whereClause}`, sqlParams);
  const total = parseInt(countResult[0]?.total || "0", 10);

  const counts = await sql`SELECT status, COUNT(*) as count FROM bookings WHERE repair_shop_id = ${shopId} GROUP BY status`;
  const statusCounts = { open: 0, accepted: 0, assigned: 0, on_the_way: 0, arrived: 0, completed: 0, cancelled: 0, rejected: 0 };
  counts.forEach((r) => { if (statusCounts[r.status] !== undefined) statusCounts[r.status] = parseInt(r.count, 10); });

  const revenueResult = await sql`
    SELECT COALESCE(SUM(final_cost), 0) as total_revenue,
           COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', now()) THEN final_cost ELSE 0 END), 0) as monthly_revenue,
           COALESCE(SUM(CASE WHEN created_at >= date_trunc('week', now()) THEN final_cost ELSE 0 END), 0) as weekly_revenue
    FROM bookings WHERE repair_shop_id = ${shopId} AND status = 'completed'
  `;
  const revenue = revenueResult[0] || { total_revenue: 0, monthly_revenue: 0, weekly_revenue: 0 };

  const todayResult = await sql`SELECT COUNT(*) as count FROM bookings WHERE repair_shop_id = ${shopId} AND created_at >= date_trunc('day', now())`;
  const todayBookings = parseInt(todayResult[0]?.count || "0", 10);

  const pendingResult = await sql`SELECT COUNT(*) as count FROM bookings WHERE repair_shop_id = ${shopId} AND status IN ('open', 'accepted', 'assigned', 'on_the_way', 'arrived')`;
  const pendingJobs = parseInt(pendingResult[0]?.count || "0", 10);

  const weeklyResult = await sql`
    SELECT date_trunc('day', created_at)::date as date, COUNT(*) as count
    FROM bookings WHERE repair_shop_id = ${shopId} AND created_at >= now() - INTERVAL '7 days'
    GROUP BY date_trunc('day', created_at)::date ORDER BY date ASC
  `;

  const recentCustomers = await sql`
    SELECT DISTINCT ON (customer_number) customer_number, customer_name, MAX(created_at) as last_booking
    FROM bookings WHERE repair_shop_id = ${shopId}
    GROUP BY customer_number, customer_name ORDER BY customer_number, last_booking DESC LIMIT 10
  `;

  // Monthly bookings count
  const monthResult = await sql`SELECT COUNT(*) as count FROM bookings WHERE repair_shop_id = ${shopId} AND created_at >= date_trunc('month', now())`;
  const monthBookings = parseInt(monthResult[0]?.count || '0', 10);

  // Revenue chart data — daily for last 30 days
  const revenueChart = await sql`
    SELECT d.date::date as date,
           COALESCE(SUM(b.final_cost), 0) as revenue,
           COUNT(b.id) as bookings
    FROM generate_series(now() - INTERVAL '29 days', now(), '1 day') d(date)
    LEFT JOIN bookings b ON b.repair_shop_id = ${shopId}
      AND b.created_at::date = d.date::date AND b.status = 'completed'
    GROUP BY d.date ORDER BY d.date ASC
  `;

  // Activity feed — recent booking_timeline entries for this shop
  let activityFeed = [];
  try {
    activityFeed = await sql`
      SELECT bt.*, b.customer_name, b.customer_number, b.service_type
      FROM booking_timeline bt
      JOIN bookings b ON b.id = bt.booking_id
      WHERE b.repair_shop_id = ${shopId}
      ORDER BY bt.created_at DESC LIMIT 20
    `;
  } catch (e) { /* table may not exist */ }

  // Customer history — repeat customers with visit count
  const customerHistory = await sql`
    SELECT customer_number, customer_name, COUNT(*) as visit_count,
           MAX(created_at) as last_visit, MIN(created_at) as first_visit,
           COALESCE(SUM(final_cost), 0) as total_spent
    FROM bookings WHERE repair_shop_id = ${shopId} AND status = 'completed'
    GROUP BY customer_number, customer_name
    HAVING COUNT(*) >= 1
    ORDER BY visit_count DESC, last_visit DESC LIMIT 20
  `;

  const shopRows = await sql`
    SELECT id, shop_name, owner_name, email, mobile, city, services_offered, service_areas, role
    FROM repair_shops WHERE id = ${shopId} LIMIT 1
  `;

  let subscription = null;
  try {
    const subRows = await sql`
      SELECT s.*, sp.name as plan_name, sp.display_name as plan_display, sp.features
      FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id
      WHERE s.repair_shop_id = ${shopId} ORDER BY s.created_at DESC LIMIT 1
    `;
    subscription = subRows[0] || null;
  } catch (e) { /* table may not exist yet */ }

  // Check subscription status for gating UI
  let subscriptionRequired = false;
  let subscriptionStatus = "active";
  try {
    const shopCheck = await sql`SELECT subscription_status FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    subscriptionStatus = shopCheck[0]?.subscription_status || "inactive";
    subscriptionRequired = subscriptionStatus !== "active";
  } catch (e) { /* ok */ }

  return response.status(200).json({
    shop: shopRows[0] || null, counts: statusCounts, bookings,
    pagination: { page: params.page, limit: params.limit, total, totalPages: Math.ceil(total / params.limit) },
    stats: { todayBookings, pendingJobs, completedToday: statusCounts.completed,
      totalRevenue: parseFloat(revenue.total_revenue), monthlyRevenue: parseFloat(revenue.monthly_revenue), weeklyRevenue: parseFloat(revenue.weekly_revenue),
      monthBookings },
    weeklyBookings: weeklyResult,
    revenueChart: revenueChart.map((r) => ({ date: r.date, revenue: parseFloat(r.revenue), bookings: parseInt(r.bookings, 10) })),
    activityFeed: activityFeed.map((a) => ({ id: a.id, bookingId: a.booking_id, action: a.action, oldValue: a.old_value, newValue: a.new_value, customerName: a.customer_name, customerNumber: a.customer_number, serviceType: a.service_type, createdAt: a.created_at })),
    customerHistory: customerHistory.map((c) => ({ name: c.customer_name, phone: c.customer_number, visits: parseInt(c.visit_count, 10), lastVisit: c.last_visit, firstVisit: c.first_visit, totalSpent: parseFloat(c.total_spent) })),
    recentCustomers: recentCustomers.map((c) => ({ name: c.customer_name, phone: c.customer_number, lastBooking: c.last_booking })),
    subscription,
    subscriptionRequired,
    subscriptionStatus,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOKING DETAIL
// ═══════════════════════════════════════════════════════════════════════════════
async function handleBookingDetail(request, response, sql, shopId) {
  const bookingId = parseInt(request.query?.id, 10);
  if (!bookingId || isNaN(bookingId)) return response.status(400).json({ error: "Invalid booking ID" });

  const bookings = await sql`
    SELECT b.*, rs.shop_name, t.name AS assigned_technician_name,
           t.phone AS assigned_technician_phone, t.email AS assigned_technician_email
    FROM bookings b LEFT JOIN repair_shops rs ON rs.id = b.repair_shop_id
    LEFT JOIN technicians t ON t.id = b.technician_id
    WHERE b.id = ${bookingId} AND b.repair_shop_id = ${shopId} LIMIT 1
  `;
  if (bookings.length === 0) return response.status(404).json({ error: "Booking not found or access denied" });

  let timeline = [];
  try { timeline = await sql`SELECT * FROM booking_timeline WHERE booking_id = ${bookingId} ORDER BY created_at ASC`; } catch (e) { /* table may not exist */ }

  let technicians = [];
  try { technicians = await sql`SELECT id, name, phone, specialization FROM technicians WHERE repair_shop_id = ${shopId} AND active = true ORDER BY name`; } catch (e) { /* may not have repair_shop_id */ }

  return response.status(200).json({ booking: bookings[0], timeline, technicians });
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT CSV
// ═══════════════════════════════════════════════════════════════════════════════
async function handleExport(request, response, sql, shopId) {
  const status = request.query?.status;
  const from = request.query?.from;
  const to = request.query?.to;

  let query = `SELECT b.id, b.customer_number, b.customer_name, b.service_type, b.area,
    b.address, b.urgency, b.status, b.priority, b.technician_name, b.technician_notes,
    b.estimated_cost, b.final_cost, b.invoice_number, b.created_at, b.updated_at
    FROM bookings b WHERE b.repair_shop_id = $1`;
  const qp = [shopId];
  if (status && status !== "all") { qp.push(status); query += ` AND b.status = $${qp.length}`; }
  if (from) { qp.push(from); query += ` AND b.created_at >= $${qp.length}::timestamptz`; }
  if (to) { qp.push(to + "T23:59:59"); query += ` AND b.created_at <= $${qp.length}::timestamptz`; }
  query += " ORDER BY b.created_at DESC LIMIT 5000";

  const bookings = await sql.unsafe(query, qp);
  const headers = ["ID","Customer Phone","Customer Name","Service","Area","Address","Urgency","Status","Priority","Technician","Notes","Est. Cost","Final Cost","Invoice","Created","Updated"];
  const esc = (v) => { if (v == null) return ""; const s = String(v); return (s.includes(",") || s.includes('"') || s.includes("\n")) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [headers.join(",")];
  bookings.forEach((b) => rows.push([b.id,b.customer_number,b.customer_name,b.service_type,b.area,b.address,b.urgency,b.status,b.priority,b.technician_name,b.technician_notes,b.estimated_cost,b.final_cost,b.invoice_number,b.created_at,b.updated_at].map(esc).join(",")));

  response.setHeader("Content-Type", "text/csv");
  response.setHeader("Content-Disposition", `attachment; filename="coolcare-bookings-${Date.now()}.csv"`);
  return response.status(200).send(rows.join("\n"));
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOKING UPDATE
// ═══════════════════════════════════════════════════════════════════════════════
async function handleBookingUpdate(request, response, sql, shopId, body) {
  const data = validate({ ...request, body }, response, bookingUpdateSchema);
  if (!data) return;

  const rows = await sql`
    SELECT b.*, rs.shop_name FROM bookings b LEFT JOIN repair_shops rs ON rs.id = b.repair_shop_id
    WHERE b.id = ${data.bookingId} AND b.repair_shop_id = ${shopId} LIMIT 1
  `;
  if (rows.length === 0) return response.status(404).json({ error: "Booking not found or not accessible" });

  const booking = rows[0];
  const oldStatus = booking.status;
  const updates = {};
  if (data.status) updates.status = data.status;
  if (data.technicianName !== undefined) updates.technician_name = data.technicianName || null;
  if (data.technicianId !== undefined) updates.technician_id = data.technicianId ? parseInt(data.technicianId, 10) : null;
  if (data.technicianNotes !== undefined) updates.technician_notes = data.technicianNotes || null;
  if (data.estimatedCost !== undefined) updates.estimated_cost = data.estimatedCost != null ? parseFloat(data.estimatedCost) : null;
  if (data.finalCost !== undefined) updates.final_cost = data.finalCost != null ? parseFloat(data.finalCost) : null;
  if (data.priority) updates.priority = data.priority;
  if (data.rescheduleDate !== undefined) updates.reschedule_date = data.rescheduleDate || null;
  if (data.invoiceNumber !== undefined) updates.invoice_number = data.invoiceNumber || null;
  if (body.customerNotes !== undefined) updates.customer_notes = body.customerNotes || null;
  if (body.photoUrls !== undefined) updates.photo_urls = Array.isArray(body.photoUrls) ? body.photoUrls : null;

  if (Object.keys(updates).length === 0) return response.status(400).json({ error: "No fields to update were provided" });

  const ALLOWED_COLS = new Set(["status","technician_name","technician_id","technician_notes","estimated_cost","final_cost","priority","reschedule_date","invoice_number","customer_notes","photo_urls"]);
  const setParts = []; const setValues = [];
  for (const [col, val] of Object.entries(updates)) { if (!ALLOWED_COLS.has(col)) continue; setValues.push(val); setParts.push(`${col} = $${setValues.length}`); }
  if (setParts.length === 0) return response.status(400).json({ error: "No valid fields provided" });

  setValues.push(data.bookingId, shopId);
  await sql.unsafe(`UPDATE bookings SET ${setParts.join(", ")}, updated_at = now() WHERE id = $${setValues.length - 1} AND repair_shop_id = $${setValues.length}`, setValues);

  if (data.status && data.status !== oldStatus) {
    await sql`INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, actor_id) VALUES (${data.bookingId}, 'status_change', ${oldStatus}, ${data.status}, 'shop', ${shopId})`;
  }
  if (data.technicianName) {
    await sql`INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, actor_id) VALUES (${data.bookingId}, 'technician_assigned', ${booking.technician_name || null}, ${data.technicianName}, 'shop', ${shopId})`;
  }
  if (data.priority) {
    await sql`INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, actor_id) VALUES (${data.bookingId}, 'priority_change', ${booking.priority || 'normal'}, ${data.priority}, 'shop', ${shopId})`;
  }

  const updated = await sql`SELECT b.*, rs.shop_name FROM bookings b LEFT JOIN repair_shops rs ON rs.id = b.repair_shop_id WHERE b.id = ${data.bookingId} LIMIT 1`;
  let timeline = [];
  try { timeline = await sql`SELECT * FROM booking_timeline WHERE booking_id = ${data.bookingId} ORDER BY created_at DESC LIMIT 20`; } catch (e) { /* table may not exist */ }

  if (data.status && data.status !== oldStatus) {
    notifyStatusChange({ ...updated[0], shop_name: booking.shop_name }, data.status).catch((err) => console.error("[shop/update] notify error:", err.message));
  }

  console.log(`[shop/update] booking #${data.bookingId} by shop #${shopId}:`, { status: data.status });
  return response.status(200).json({ updated: true, booking: updated[0], timeline });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN GET ROUTER
// ═══════════════════════════════════════════════════════════════════════════════
async function handleAdminGet(request, response, sql, auth, action) {
  const admin = await requirePlatformAdmin(auth, sql, response);
  if (!admin) return;

  switch (action) {
    case "admin": return adminDashboard(request, response, sql, auth);
    case "admin-users": return adminListUsers(request, response, sql, auth);
    case "admin-plans": return adminListPlans(request, response, sql, auth);
    case "admin-pricing": return adminListPricing(request, response, sql, auth);
    case "admin-payments": return adminListPayments(request, response, sql, auth);
    case "admin-settings": return adminGetSettings(request, response, sql, auth);
    case "admin-analytics": return adminAnalytics(request, response, sql, auth);
    default: return response.status(400).json({ error: "Unknown admin GET action" });
  }
}

async function adminListPricing(request, response, sql, auth) {
  const plans = await sql`
    SELECT sp.id as plan_id, sp.name as plan_name, sp.display_name,
           spp.id as pricing_id, spp.currency, spp.price_monthly, spp.price_quarterly,
           spp.price_halfyearly, spp.price_yearly
    FROM subscription_plans sp
    LEFT JOIN subscription_plan_prices spp ON sp.id = spp.plan_id
    ORDER BY sp.id, spp.currency
  `;

  const result = plans.reduce((acc, row) => {
    if (!acc[row.plan_id]) {
      acc[row.plan_id] = {
        plan_id: row.plan_id,
        plan_name: row.plan_name,
        display_name: row.display_name,
        pricing: {},
      };
    }
    if (row.currency) {
      acc[row.plan_id].pricing[row.currency] = {
        pricing_id: row.pricing_id,
        monthly: parseFloat(row.price_monthly || 0),
        quarterly: parseFloat(row.price_quarterly || 0),
        halfyearly: parseFloat(row.price_halfyearly || 0),
        yearly: parseFloat(row.price_yearly || 0),
      };
    }
    return acc;
  }, {});

  return response.status(200).json({ plans: Object.values(result) });
}

// ─── ADMIN DASHBOARD (enhanced analytics with error handling) ────────────────
async function adminDashboard(request, response, sql, auth) {
  const page = parseInt(request.query?.page || "1", 10);
  const limit = parseInt(request.query?.limit || "20", 10);
  const search = request.query?.search || "";
  const offset = (page - 1) * limit;

  let whereClause = "WHERE 1=1";
  const qp = [];
  if (search) { qp.push(`%${search}%`); whereClause += ` AND (rs.shop_name ILIKE $${qp.length} OR rs.email ILIKE $${qp.length} OR rs.owner_name ILIKE $${qp.length})`; }

  // Fetch shops — use safe columns only (work even if migrations partially applied)
  let shops = [];
  try {
    shops = await sql.unsafe(`
      SELECT rs.id, rs.shop_name, rs.owner_name, rs.email, rs.mobile, rs.city, rs.role,
             COALESCE(rs.subscription_status, 'trial') as subscription_status,
             rs.suspended_at, rs.created_at,
             (SELECT COUNT(*) FROM bookings WHERE repair_shop_id = rs.id) as total_bookings,
             (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE repair_shop_id = rs.id AND status = 'completed') as total_revenue,
             (SELECT sp.name FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id WHERE s.repair_shop_id = rs.id ORDER BY s.created_at DESC LIMIT 1) as plan_name
      FROM repair_shops rs ${whereClause}
      ORDER BY rs.created_at DESC LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}
    `, [...qp, limit, offset]);
  } catch (e) {
    // Fallback: query without subscription/plan joins
    console.warn("[admin/dashboard] Full query failed, using fallback:", e.message);
    try {
      shops = await sql.unsafe(`
        SELECT rs.id, rs.shop_name, rs.owner_name, rs.email, rs.mobile, rs.city,
               COALESCE(rs.role, 'owner') as role,
               COALESCE(rs.subscription_status, 'trial') as subscription_status,
               rs.suspended_at, rs.created_at,
               (SELECT COUNT(*) FROM bookings WHERE repair_shop_id = rs.id) as total_bookings,
               (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE repair_shop_id = rs.id AND status = 'completed') as total_revenue,
               NULL as plan_name
        FROM repair_shops rs ${whereClause}
        ORDER BY rs.created_at DESC LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}
      `, [...qp, limit, offset]);
    } catch (e2) {
      // Minimal fallback
      console.error("[admin/dashboard] Fallback query also failed:", e2.message);
      shops = await sql`SELECT id, shop_name, owner_name, email, mobile, city, created_at, 'owner' as role, 'trial' as subscription_status, NULL as suspended_at, 0 as total_bookings, 0 as total_revenue, NULL as plan_name FROM repair_shops ORDER BY created_at DESC LIMIT 20`;
    }
  }

  // Analytics — each sub-query wrapped in try-catch for resilience
  let analytics = {};
  try {
    const rows = await sql`
      SELECT
        (SELECT COUNT(*) FROM repair_shops) as total_shops,
        (SELECT COUNT(*) FROM repair_shops WHERE suspended_at IS NULL AND COALESCE(is_active, true) = true) as active_shops,
        (SELECT COUNT(*) FROM repair_shops WHERE suspended_at IS NOT NULL) as suspended_shops,
        (SELECT COUNT(*) FROM repair_shops WHERE COALESCE(subscription_status, 'trial') = 'trial') as pending_shops,
        (SELECT COUNT(*) FROM bookings) as total_bookings,
        (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE status = 'completed') as total_revenue,
        (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE status = 'completed' AND created_at >= date_trunc('month', now())) as monthly_revenue,
        (SELECT COUNT(*) FROM bookings WHERE created_at >= date_trunc('day', now())) as bookings_today
    `;
    analytics = rows[0] || {};
  } catch (e) {
    console.warn("[admin/dashboard] Analytics main query failed:", e.message);
    // Fallback: basic counts
    try {
      const basic = await sql`SELECT COUNT(*) as total_shops FROM repair_shops`;
      const bookings = await sql`SELECT COUNT(*) as total_bookings FROM bookings`;
      analytics = {
        total_shops: parseInt(basic[0]?.total_shops || "0", 10),
        active_shops: analytics.total_shops,
        suspended_shops: 0,
        pending_shops: analytics.total_shops,
        total_bookings: parseInt(bookings[0]?.total_bookings || "0", 10),
        total_revenue: 0,
        monthly_revenue: 0,
        bookings_today: 0,
      };
    } catch (e2) {
      analytics = { total_shops: shops.length, active_shops: shops.length, suspended_shops: 0, pending_shops: 0, total_bookings: 0, total_revenue: 0, monthly_revenue: 0, bookings_today: 0 };
    }
  }

  // Additional analytics (subscriptions, payments, plans) — may not exist yet
  try {
    const subCount = await sql`SELECT COUNT(*) as cnt FROM subscriptions WHERE status = 'active'`;
    analytics.active_subscriptions = parseInt(subCount[0]?.cnt || "0", 10);
  } catch (e) { analytics.active_subscriptions = 0; }

  try {
    const failCount = await sql`SELECT COUNT(*) as cnt FROM payments WHERE status = 'failed'`;
    analytics.failed_payments = parseInt(failCount[0]?.cnt || "0", 10);
  } catch (e) { analytics.failed_payments = 0; }

  try {
    const planCount = await sql`SELECT COUNT(*) as cnt FROM subscription_plans WHERE is_active = true`;
    analytics.active_plans = parseInt(planCount[0]?.cnt || "0", 10);
  } catch (e) { analytics.active_plans = 0; }

  try {
    const expired = await sql`SELECT COUNT(*) as cnt FROM repair_shops WHERE subscription_status = 'expired'`;
    analytics.expired_shops = parseInt(expired[0]?.cnt || '0', 10);
  } catch (e) { analytics.expired_shops = 0; }

  try {
    const renewals = await sql`SELECT COUNT(*) as cnt FROM subscriptions WHERE status = 'active' AND current_period_end <= now() + INTERVAL '7 days' AND current_period_end > now()`;
    analytics.pending_renewals = parseInt(renewals[0]?.cnt || '0', 10);
  } catch (e) { analytics.pending_renewals = 0; }

  // Recent signups
  let recentSignups = [];
  try {
    recentSignups = await sql`SELECT id, shop_name, owner_name, email, city, subscription_status, created_at FROM repair_shops ORDER BY created_at DESC LIMIT 10`;
  } catch (e) { /* ok */ }

  // Recent payments
  let recentPayments = [];
  try {
    recentPayments = await sql`SELECT p.id, p.invoice_number, p.amount, p.currency, p.status, p.gateway, p.created_at, rs.shop_name FROM payments p LEFT JOIN repair_shops rs ON rs.id = p.repair_shop_id ORDER BY p.created_at DESC LIMIT 10`;
  } catch (e) { /* ok */ }

  let total = shops.length;
  try {
    const countResult = await sql.unsafe(`SELECT COUNT(*) as total FROM repair_shops rs ${whereClause}`, qp);
    total = parseInt(countResult[0]?.total || "0", 10);
  } catch (e) { /* use shops.length */ }

  return response.status(200).json({
    shops, analytics,
    pagination: { page, limit, total },
    recentSignups,
    recentPayments,
  });
}

// ─── ADMIN LIST USERS ────────────────────────────────────────────────────────
async function adminListUsers(request, response, sql, auth) {
  const page = parseInt(request.query?.page || "1", 10);
  const limit = parseInt(request.query?.limit || "20", 10);
  const search = request.query?.search || "";
  const role = request.query?.role || "";
  const offset = (page - 1) * limit;

  let whereClause = "WHERE 1=1";
  const qp = [];
  if (search) { qp.push(`%${search}%`); whereClause += ` AND (u.name ILIKE $${qp.length} OR u.email ILIKE $${qp.length})`; }
  if (role) { qp.push(role); whereClause += ` AND u.role = $${qp.length}`; }

  const users = await sql.unsafe(`
    SELECT u.id, u.email, u.name, u.role, u.repair_shop_id, u.is_active, u.last_login, u.created_at,
           rs.shop_name as shop_name
    FROM users u LEFT JOIN repair_shops rs ON rs.id = u.repair_shop_id
    ${whereClause}
    ORDER BY u.created_at DESC LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}
  `, [...qp, limit, offset]);

  const countResult = await sql.unsafe(`SELECT COUNT(*) as total FROM users u ${whereClause}`, qp);

  return response.status(200).json({
    users,
    pagination: { page, limit, total: parseInt(countResult[0]?.total || "0", 10) },
  });
}

// ─── ADMIN LIST PLANS ────────────────────────────────────────────────────────
async function adminListPlans(request, response, sql, auth) {
  const plans = await sql`
    SELECT * FROM subscription_plans ORDER BY is_active DESC, price_monthly_usd ASC
  `;
  return response.status(200).json({ plans });
}

// ─── ADMIN LIST PAYMENTS ─────────────────────────────────────────────────────
async function adminListPayments(request, response, sql, auth) {
  const page = parseInt(request.query?.page || "1", 10);
  const limit = parseInt(request.query?.limit || "20", 10);
  const status = request.query?.status || "";
  const offset = (page - 1) * limit;

  let whereClause = "WHERE 1=1";
  const qp = [];
  if (status) { qp.push(status); whereClause += ` AND p.status = $${qp.length}`; }

  const payments = await sql.unsafe(`
    SELECT p.id, p.payment_id, p.transaction_id, p.gateway, p.currency, p.amount, p.status,
           p.invoice_number, p.description, p.refund_amount, p.refund_reason, p.refunded_at,
           p.created_at, p.updated_at,
           rs.shop_name, rs.owner_name as shop_owner
    FROM payments p LEFT JOIN repair_shops rs ON rs.id = p.repair_shop_id
    ${whereClause}
    ORDER BY p.created_at DESC LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}
  `, [...qp, limit, offset]);

  const countResult = await sql.unsafe(`SELECT COUNT(*) as total FROM payments p ${whereClause}`, qp);

  return response.status(200).json({
    payments,
    pagination: { page, limit, total: parseInt(countResult[0]?.total || "0", 10) },
  });
}

// ─── ADMIN GET SETTINGS ──────────────────────────────────────────────────────
async function adminGetSettings(request, response, sql, auth) {
  let settings = {};
  try {
    const rows = await sql`SELECT key, value FROM platform_settings`;
    rows.forEach((r) => { settings[r.key] = r.value; });
  } catch (e) { /* table may not exist */ }
  return response.status(200).json({ settings });
}

// ─── ADMIN ANALYTICS ─────────────────────────────────────────────────────────
async function adminAnalytics(request, response, sql, auth) {
  // Monthly bookings and revenue for last 12 months
  const monthly = await sql`
    SELECT date_trunc('month', created_at)::date as month,
           COUNT(*) as bookings,
           COALESCE(SUM(final_cost), 0) as revenue
    FROM bookings
    WHERE created_at >= now() - INTERVAL '12 months'
    GROUP BY date_trunc('month', created_at)::date
    ORDER BY month ASC
  `;

  // Most active shops (top 10 by bookings)
  const activeShops = await sql`
    SELECT rs.id, rs.shop_name, rs.city, COUNT(b.id) as booking_count,
           COALESCE(SUM(b.final_cost), 0) as total_revenue
    FROM repair_shops rs
    JOIN bookings b ON b.repair_shop_id = rs.id
    GROUP BY rs.id, rs.shop_name, rs.city
    ORDER BY booking_count DESC LIMIT 10
  `;

  // Top cities
  const topCities = await sql`
    SELECT city, COUNT(*) as shop_count FROM repair_shops
    WHERE city IS NOT NULL AND city != ''
    GROUP BY city ORDER BY shop_count DESC LIMIT 10
  `;

  // Subscription breakdown
  const subBreakdown = await sql`
    SELECT s.status, COUNT(*) as count FROM subscriptions s GROUP BY s.status
  `;

  // Growth metrics
  const growth = await sql`
    SELECT
      (SELECT COUNT(*) FROM repair_shops WHERE created_at >= date_trunc('month', now())) as new_shops_this_month,
      (SELECT COUNT(*) FROM bookings WHERE created_at >= date_trunc('month', now())) as bookings_this_month,
      (SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('month', now())) as new_users_this_month
  `;

  return response.status(200).json({
    monthly, activeShops, topCities,
    subscriptions: subBreakdown,
    growth: growth[0] || {},
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN POST ROUTER
// ═══════════════════════════════════════════════════════════════════════════════
async function handleAdminPost(request, response, sql, auth, body) {
  const admin = await requirePlatformAdmin(auth, sql, response);
  if (!admin) return;

  const ip = request.headers["x-forwarded-for"]?.split(",")[0]?.trim() || request.headers["x-real-ip"] || null;
  const actorType = auth.user_type || "shop";
  const actorId = parseInt(auth.sub, 10);
  const action = body.action;

  switch (action) {
    // ── Shop actions ────────────────────────────────────────────
    case "suspend": return adminSuspendShop(sql, response, body, actorType, actorId, ip);
    case "activate": return adminActivateShop(sql, response, body, actorType, actorId, ip);
    case "delete": return adminDeleteShop(sql, response, body, actorType, actorId, ip);
    case "edit-shop": return adminEditShop(sql, response, body, actorType, actorId, ip);
    case "approve-shop": return adminApproveShop(sql, response, body, actorType, actorId, ip);
    case "reset-password": return adminResetPassword(sql, response, body, actorType, actorId, ip);

    // ── User actions ────────────────────────────────────────────
    case "create-user": return adminCreateUser(sql, response, body, actorType, actorId, ip, auth);
    case "edit-user": return adminEditUser(sql, response, body, actorType, actorId, ip);
    case "delete-user": return adminDeleteUser(sql, response, body, actorType, actorId, ip);
    case "invite-user": return adminInviteUser(sql, response, body, actorType, actorId, ip);

    // ── Plan actions ────────────────────────────────────────────
    case "create-plan": return adminCreatePlan(request, response, sql, body, actorType, actorId, ip);
    case "edit-plan": return adminEditPlan(request, response, sql, body, actorType, actorId, ip);
    case "delete-plan": return adminDeletePlan(sql, response, body, actorType, actorId, ip);
    case "duplicate-plan": return adminDuplicatePlan(sql, response, body, actorType, actorId, ip);
    case "save-plan-pricing": return adminSavePlanPricing(sql, response, body, actorType, actorId, ip);

    // ── Settings ────────────────────────────────────────────────
    case "save-settings": return adminSaveSettings(request, response, sql, body, actorType, actorId, ip);

    // ── Subscription management ──────────────────────────────
    case "extend-subscription": return adminExtendSubscription(sql, response, body, actorType, actorId, ip);
    case "change-plan": return adminChangePlan(sql, response, body, actorType, actorId, ip);

    default: return response.status(400).json({ error: "Unknown admin action" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP ADMIN ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
async function adminSuspendShop(sql, response, body, actorType, actorId, ip) {
  const shopId = body.shopId;
  if (!shopId) return response.status(400).json({ error: "shopId required" });
  await sql`UPDATE repair_shops SET suspended_at = now(), suspension_reason = ${body.reason || null}, updated_at = now() WHERE id = ${shopId}`;
  await logAdminAction(sql, { actorType, actorId, action: "suspend_shop", targetType: "shop", targetId: shopId, details: { reason: body.reason }, ip });
  return response.status(200).json({ message: "Shop suspended" });
}

async function adminActivateShop(sql, response, body, actorType, actorId, ip) {
  const shopId = body.shopId;
  if (!shopId) return response.status(400).json({ error: "shopId required" });
  await sql`UPDATE repair_shops SET suspended_at = NULL, suspension_reason = NULL, is_active = true, updated_at = now() WHERE id = ${shopId}`;
  await logAdminAction(sql, { actorType, actorId, action: "activate_shop", targetType: "shop", targetId: shopId, ip });
  return response.status(200).json({ message: "Shop activated" });
}

async function adminDeleteShop(sql, response, body, actorType, actorId, ip) {
  const shopId = body.shopId;
  if (!shopId) return response.status(400).json({ error: "shopId required" });
  await sql`DELETE FROM repair_shops WHERE id = ${shopId}`;
  await logAdminAction(sql, { actorType, actorId, action: "delete_shop", targetType: "shop", targetId: shopId, ip });
  return response.status(200).json({ message: "Shop deleted" });
}

async function adminEditShop(sql, response, body, actorType, actorId, ip) {
  const shopId = body.shopId;
  if (!shopId) return response.status(400).json({ error: "shopId required" });
  const updates = {};
  if (body.shop_name !== undefined) updates.shop_name = body.shop_name;
  if (body.owner_name !== undefined) updates.owner_name = body.owner_name;
  if (body.email !== undefined) updates.email = body.email;
  if (body.city !== undefined) updates.city = body.city;
  if (body.subscription_status !== undefined) updates.subscription_status = body.subscription_status;
  if (Object.keys(updates).length === 0) return response.status(400).json({ error: "No fields to update" });

  const setParts = []; const setValues = [];
  for (const [col, val] of Object.entries(updates)) { setValues.push(val); setParts.push(`${col} = $${setValues.length}`); }
  setValues.push(shopId);
  await sql.unsafe(`UPDATE repair_shops SET ${setParts.join(", ")}, updated_at = now() WHERE id = $${setValues.length}`, setValues);
  await logAdminAction(sql, { actorType, actorId, action: "edit_shop", targetType: "shop", targetId: shopId, details: updates, ip });
  return response.status(200).json({ message: "Shop updated" });
}

async function adminApproveShop(sql, response, body, actorType, actorId, ip) {
  const shopId = body.shopId;
  if (!shopId) return response.status(400).json({ error: "shopId required" });
  await sql`UPDATE repair_shops SET is_active = true, subscription_status = 'active', updated_at = now() WHERE id = ${shopId}`;
  await logAdminAction(sql, { actorType, actorId, action: "approve_shop", targetType: "shop", targetId: shopId, ip });
  return response.status(200).json({ message: "Shop approved" });
}

async function adminResetPassword(sql, response, body, actorType, actorId, ip) {
  const data = validate({ body }, response, resetPasswordSchema);
  if (!data) return;

  const newPassword = body.newPassword || Math.random().toString(36).slice(2, 10) + "A1!";
  const hash = await bcrypt.hash(newPassword, 12);

  if (data.targetType === "user") {
    await sql`UPDATE users SET password_hash = ${hash}, updated_at = now() WHERE id = ${data.targetId}`;
  } else {
    await sql`UPDATE repair_shops SET password_hash = ${hash}, updated_at = now() WHERE id = ${data.targetId}`;
  }
  await logAdminAction(sql, { actorType, actorId, action: "reset_password", targetType: data.targetType, targetId: data.targetId, ip });
  return response.status(200).json({ message: "Password reset", tempPassword: newPassword });
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER ADMIN ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
async function adminCreateUser(sql, response, body, actorType, actorId, ip, auth) {
  const data = validate({ body }, response, createUserSchema);
  if (!data) return;

  // Check if creator is trying to create super_admin (only super_admin can)
  if (data.role === "super_admin") {
    const sa = await requireSuperAdmin(auth, sql, response);
    if (!sa) return;
  }

  // Check email uniqueness
  const existing = await sql`SELECT id FROM users WHERE email = ${data.email} LIMIT 1`;
  if (existing.length > 0) return response.status(409).json({ error: "Email already in use" });

  const hash = await bcrypt.hash(data.password, 12);
  const rows = await sql`
    INSERT INTO users (email, password_hash, name, role, repair_shop_id)
    VALUES (${data.email}, ${hash}, ${data.name}, ${data.role}, ${data.repair_shop_id || null})
    RETURNING id, email, name, role, repair_shop_id
  `;
  await logAdminAction(sql, { actorType, actorId, action: "create_user", targetType: "user", targetId: rows[0].id, details: { role: data.role }, ip });
  return response.status(201).json({ message: "User created", user: rows[0] });
}

async function adminEditUser(sql, response, body, actorType, actorId, ip) {
  const data = validate({ body }, response, editUserSchema);
  if (!data) return;

  const updates = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.role !== undefined) updates.role = data.role;
  if (data.is_active !== undefined) updates.is_active = data.is_active;
  if (data.repair_shop_id !== undefined) updates.repair_shop_id = data.repair_shop_id;
  if (Object.keys(updates).length === 0) return response.status(400).json({ error: "No fields to update" });

  const setParts = []; const setValues = [];
  for (const [col, val] of Object.entries(updates)) { setValues.push(val); setParts.push(`${col} = $${setValues.length}`); }
  setValues.push(data.userId);
  await sql.unsafe(`UPDATE users SET ${setParts.join(", ")}, updated_at = now() WHERE id = $${setValues.length}`, setValues);
  await logAdminAction(sql, { actorType, actorId, action: "edit_user", targetType: "user", targetId: data.userId, details: updates, ip });
  return response.status(200).json({ message: "User updated" });
}

async function adminDeleteUser(sql, response, body, actorType, actorId, ip) {
  const userId = body.userId;
  if (!userId) return response.status(400).json({ error: "userId required" });
  await sql`DELETE FROM users WHERE id = ${userId}`;
  await logAdminAction(sql, { actorType, actorId, action: "delete_user", targetType: "user", targetId: userId, ip });
  return response.status(200).json({ message: "User deleted" });
}

async function adminInviteUser(sql, response, body, actorType, actorId, ip) {
  // Create user with a temporary random password and mark for password change
  const data = validate({ body }, response, createUserSchema);
  if (!data) return;

  const existing = await sql`SELECT id FROM users WHERE email = ${data.email} LIMIT 1`;
  if (existing.length > 0) return response.status(409).json({ error: "Email already in use" });

  const tempPass = Math.random().toString(36).slice(2, 10) + "A1!";
  const hash = await bcrypt.hash(tempPass, 12);
  const rows = await sql`
    INSERT INTO users (email, password_hash, name, role, repair_shop_id)
    VALUES (${data.email}, ${hash}, ${data.name}, ${data.role}, ${data.repair_shop_id || null})
    RETURNING id, email, name, role
  `;
  await logAdminAction(sql, { actorType, actorId, action: "invite_user", targetType: "user", targetId: rows[0].id, ip });
  return response.status(201).json({ message: "User invited", user: rows[0], tempPassword: tempPass });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAN ADMIN ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
async function adminCreatePlan(request, response, sql, body, actorType, actorId, ip) {
  const data = validate({ body }, response, createPlanSchema);
  if (!data) return;

  const existing = await sql`SELECT id FROM subscription_plans WHERE name = ${data.name} LIMIT 1`;
  if (existing.length > 0) return response.status(409).json({ error: "Plan name already exists" });

  const rows = await sql`
    INSERT INTO subscription_plans
      (name, display_name, description, price_monthly_usd, price_yearly_usd,
       max_bookings, max_technicians, max_staff, whatsapp_conversations, ai_credits,
       features, trial_days, currency, is_active)
    VALUES
      (${data.name}, ${data.display_name}, ${data.description}, ${data.price_monthly_usd}, ${data.price_yearly_usd},
       ${data.max_bookings || null}, ${data.max_technicians || null}, ${data.max_staff || null},
       ${data.whatsapp_conversations || null}, ${data.ai_credits || null},
       ${sql.json(data.features || {})}, ${data.trial_days}, ${data.currency}, ${data.is_active})
    RETURNING *
  `;
  await logAdminAction(sql, { actorType, actorId, action: "create_plan", targetType: "plan", targetId: rows[0].id, ip });
  return response.status(201).json({ message: "Plan created", plan: rows[0] });
}

async function adminEditPlan(request, response, sql, body, actorType, actorId, ip) {
  const data = validate({ body }, response, editPlanSchema);
  if (!data) return;

  const updates = {};
  const fields = ["name","display_name","description","price_monthly_usd","price_yearly_usd","max_bookings","max_technicians","max_staff","whatsapp_conversations","ai_credits","trial_days","currency","is_active"];
  for (const f of fields) {
    if (data[f] !== undefined) updates[f] = data[f];
  }
  if (data.features !== undefined) updates.features = data.features;
  if (Object.keys(updates).length === 0) return response.status(400).json({ error: "No fields to update" });

  const setParts = []; const setValues = [];
  for (const [col, val] of Object.entries(updates)) {
    setValues.push(col === "features" ? sql.json(val) : val);
    setParts.push(`${col} = $${setValues.length}`);
  }
  setValues.push(data.planId);
  await sql.unsafe(`UPDATE subscription_plans SET ${setParts.join(", ")} WHERE id = $${setValues.length}`, setValues);
  await logAdminAction(sql, { actorType, actorId, action: "edit_plan", targetType: "plan", targetId: data.planId, ip });
  return response.status(200).json({ message: "Plan updated" });
}

async function adminSavePlanPricing(sql, response, body, actorType, actorId, ip) {
  const data = validate({ body }, response, planPricingSchema);
  if (!data) return;
  const currency = data.currency.toUpperCase();

  const existing = await sql`
    SELECT id FROM subscription_plan_prices
    WHERE plan_id = ${data.planId} AND currency = ${currency}
    LIMIT 1
  `;

  if (existing.length > 0) {
    await sql`
      UPDATE subscription_plan_prices
      SET price_monthly = ${data.price_monthly},
          price_quarterly = ${data.price_quarterly},
          price_halfyearly = ${data.price_halfyearly},
          price_yearly = ${data.price_yearly},
          updated_at = now()
      WHERE id = ${existing[0].id}
    `;
    await logAdminAction(sql, { actorType, actorId, action: "update_plan_pricing", targetType: "plan_pricing", targetId: existing[0].id, ip });
    return response.status(200).json({ message: "Pricing updated" });
  }

  const rows = await sql`
    INSERT INTO subscription_plan_prices
      (plan_id, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly)
    VALUES (${data.planId}, ${data.currency}, ${data.price_monthly}, ${data.price_quarterly}, ${data.price_halfyearly}, ${data.price_yearly})
    RETURNING id
  `;
  await logAdminAction(sql, { actorType, actorId, action: "create_plan_pricing", targetType: "plan_pricing", targetId: rows[0].id, ip });
  return response.status(201).json({ message: "Pricing saved" });
}

async function adminDeletePlan(sql, response, body, actorType, actorId, ip) {
  const planId = body.planId;
  if (!planId) return response.status(400).json({ error: "planId required" });
  // Soft-delete: deactivate instead of delete
  await sql`UPDATE subscription_plans SET is_active = false WHERE id = ${planId}`;
  await logAdminAction(sql, { actorType, actorId, action: "deactivate_plan", targetType: "plan", targetId: planId, ip });
  return response.status(200).json({ message: "Plan deactivated" });
}

async function adminDuplicatePlan(sql, response, body, actorType, actorId, ip) {
  const planId = body.planId;
  if (!planId) return response.status(400).json({ error: "planId required" });

  const original = await sql`SELECT * FROM subscription_plans WHERE id = ${planId} LIMIT 1`;
  if (original.length === 0) return response.status(404).json({ error: "Plan not found" });
  const p = original[0];

  const newName = `${p.name}_copy`;
  const newDisplay = `${p.display_name} (Copy)`;
  const rows = await sql`
    INSERT INTO subscription_plans
      (name, display_name, description, price_monthly_usd, price_yearly_usd,
       max_bookings, max_technicians, max_staff, whatsapp_conversations, ai_credits,
       features, trial_days, currency, is_active)
    VALUES
      (${newName}, ${newDisplay}, ${p.description || ''}, ${p.price_monthly_usd}, ${p.price_yearly_usd},
       ${p.max_bookings}, ${p.max_technicians}, ${p.max_staff}, ${p.whatsapp_conversations}, ${p.ai_credits},
       ${sql.json(p.features || {})}, ${p.trial_days || 14}, ${p.currency || 'USD'}, false)
    RETURNING *
  `;
  await logAdminAction(sql, { actorType, actorId, action: "duplicate_plan", targetType: "plan", targetId: rows[0].id, ip });
  return response.status(201).json({ message: "Plan duplicated", plan: rows[0] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
async function adminSaveSettings(request, response, sql, body, actorType, actorId, ip) {
  const data = validate({ body }, response, settingsSchema);
  if (!data) return;

  for (const [key, value] of Object.entries(data.settings)) {
    await sql`
      INSERT INTO platform_settings (key, value, updated_by, updated_at)
      VALUES (${key}, ${sql.json(typeof value === "object" ? value : { value })}, ${actorId}, now())
      ON CONFLICT (key) DO UPDATE SET value = ${sql.json(typeof value === "object" ? value : { value })},
        updated_by = ${actorId}, updated_at = now()
    `;
  }
  await logAdminAction(sql, { actorType, actorId, action: "save_settings", details: { keys: Object.keys(data.settings) }, ip });
  return response.status(200).json({ message: "Settings saved" });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN SUBSCRIPTION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════
async function adminExtendSubscription(sql, response, body, actorType, actorId, ip) {
  const { shopId, days } = body;
  if (!shopId || !days) return response.status(400).json({ error: "shopId and days required" });
  const daysNum = parseInt(days, 10);
  if (isNaN(daysNum) || daysNum < 1 || daysNum > 365) return response.status(400).json({ error: "days must be between 1 and 365" });

  // Extend current_period_end on active subscription
  try {
    await sql.unsafe(
      `UPDATE subscriptions SET current_period_end = current_period_end + ($1 || ' days')::interval, updated_at = now()
       WHERE repair_shop_id = $2 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [String(daysNum), shopId]
    );
  } catch (e) {
    console.error("[admin/extend] Failed:", e.message);
    return response.status(500).json({ error: "Failed to extend subscription" });
  }

  // Reactivate shop if expired
  await sql`UPDATE repair_shops SET subscription_status = 'active', suspended_at = NULL, updated_at = now() WHERE id = ${shopId}`;
  await logAdminAction(sql, { actorType, actorId, action: "extend_subscription", targetType: "shop", targetId: shopId, details: { days: daysNum }, ip });
  return response.status(200).json({ message: `Subscription extended by ${daysNum} days` });
}

async function adminChangePlan(sql, response, body, actorType, actorId, ip) {
  const { shopId, planName } = body;
  if (!shopId || !planName) return response.status(400).json({ error: "shopId and planName required" });

  const plan = await sql`SELECT id, name, display_name FROM subscription_plans WHERE name = ${planName} AND is_active = true LIMIT 1`;
  if (plan.length === 0) return response.status(404).json({ error: "Plan not found" });

  await sql`
    UPDATE subscriptions SET plan_id = ${plan[0].id}, updated_at = now()
    WHERE repair_shop_id = ${shopId} AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `;
  await logAdminAction(sql, { actorType, actorId, action: "change_plan", targetType: "shop", targetId: shopId, details: { plan: planName }, ip });
  return response.status(200).json({ message: `Plan changed to ${plan[0].display_name}`, plan: plan[0] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP GET ROUTER (non-gated actions)
// ═══════════════════════════════════════════════════════════════════════════════
async function handleShopGet(request, response, sql, shopId, auth, action) {
  switch (action) {
    case "referrals": return handleReferrals(request, response, sql, shopId);
    case "ai-settings": return handleGetAiSettings(request, response, sql, shopId);
    case "whatsapp-status": return handleWhatsAppStatus(request, response, sql, shopId);
    case "whatsapp-logs": return handleWhatsAppLogs(request, response, sql, shopId);
    case "notifications": return handleGetNotifications(request, response, sql, shopId);
    case "shop-settings": return handleGetShopSettings(request, response, sql, shopId);
    default: return response.status(400).json({ error: "Unknown GET action" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REFERRALS
// ═══════════════════════════════════════════════════════════════════════════════
async function handleReferrals(request, response, sql, shopId) {
  const shop = await sql`SELECT referral_code, wallet_balance, discount_balance FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
  const referralCode = shop[0]?.referral_code || null;

  let stats = { total: 0, successful: 0, pending: 0, earnings: 0 };
  let history = [];
  try {
    const rows = await sql`
      SELECT r.*, rs.shop_name as referred_shop_name, rs.email as referred_email
      FROM referrals r LEFT JOIN repair_shops rs ON rs.id = r.referred_shop_id
      WHERE r.referrer_shop_id = ${shopId}
      ORDER BY r.created_at DESC LIMIT 50
    `;
    history = rows;
    stats.total = rows.length;
    stats.successful = rows.filter(r => r.status === 'completed').length;
    stats.pending = rows.filter(r => r.status === 'pending').length;
    stats.earnings = rows.filter(r => r.status === 'completed').reduce((sum, r) => sum + parseFloat(r.reward_value || 0), 0);
  } catch (e) { /* table may not exist */ }

  return response.status(200).json({
    referralCode,
    shareLink: `${process.env.APP_URL || 'https://coolcare.ai'}/shop-signup.html?ref=${referralCode || ''}`,
    walletBalance: parseFloat(shop[0]?.wallet_balance || 0),
    discountBalance: parseFloat(shop[0]?.discount_balance || 0),
    stats,
    history,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
async function handleGetAiSettings(request, response, sql, shopId) {
  let settings = null;
  try {
    const rows = await sql`SELECT * FROM ai_settings WHERE repair_shop_id = ${shopId} LIMIT 1`;
    settings = rows[0] || null;
  } catch (e) { /* table may not exist */ }

  if (!settings) {
    settings = {
      greeting_message: '', business_hours: {}, working_days: ['mon','tue','wed','thu','fri','sat'],
      supported_services: [], knowledge_base: '',
      fallback_response: 'I apologize, but I am unable to help with that right now. A team member will get back to you shortly.',
      transfer_to_human: true,
    };
  }
  return response.status(200).json({ settings });
}

async function handleSaveAiSettings(request, response, sql, shopId, body) {
  const { greetingMessage, businessHours, workingDays, supportedServices, knowledgeBase, fallbackResponse, transferToHuman } = body;
  try {
    await sql`
      INSERT INTO ai_settings (repair_shop_id, greeting_message, business_hours, working_days, supported_services, knowledge_base, fallback_response, transfer_to_human, updated_at)
      VALUES (${shopId}, ${greetingMessage || ''}, ${sql.json(businessHours || {})}, ${workingDays || ['mon','tue','wed','thu','fri','sat']},
              ${supportedServices || []}, ${knowledgeBase || ''}, ${fallbackResponse || ''}, ${transferToHuman !== false}, now())
      ON CONFLICT (repair_shop_id) DO UPDATE SET
        greeting_message = ${greetingMessage || ''}, business_hours = ${sql.json(businessHours || {})},
        working_days = ${workingDays || ['mon','tue','wed','thu','fri','sat']},
        supported_services = ${supportedServices || []}, knowledge_base = ${knowledgeBase || ''},
        fallback_response = ${fallbackResponse || ''}, transfer_to_human = ${transferToHuman !== false}, updated_at = now()
    `;
  } catch (e) {
    console.error("[shop/ai-settings] Save failed:", e.message);
    return response.status(500).json({ error: "Failed to save AI settings" });
  }
  return response.status(200).json({ message: "AI settings saved" });
}

// ═══════════════════════════════════════════════════════════════════════════════
// WHATSAPP MONITORING
// ═══════════════════════════════════════════════════════════════════════════════
async function handleWhatsAppStatus(request, response, sql, shopId) {
  const hasToken = !!process.env.WHATSAPP_ACCESS_TOKEN;
  const hasVerifyToken = !!process.env.META_WEBHOOK_VERIFY_TOKEN;
  const hasPhoneId = !!process.env.WHATSAPP_PHONE_NUMBER_ID;

  let lastSync = null;
  let messageCount = 0;
  try {
    const last = await sql`SELECT created_at FROM whatsapp_conversations WHERE repair_shop_id = ${shopId} ORDER BY created_at DESC LIMIT 1`;
    lastSync = last[0]?.created_at || null;
    const cnt = await sql`SELECT COUNT(*) as cnt FROM whatsapp_conversations WHERE repair_shop_id = ${shopId}`;
    messageCount = parseInt(cnt[0]?.cnt || '0', 10);
  } catch (e) { /* table may not exist */ }

  return response.status(200).json({
    connected: hasToken && hasPhoneId,
    webhookConfigured: hasVerifyToken,
    accessTokenStatus: hasToken ? 'configured' : 'missing',
    lastSync,
    totalMessages: messageCount,
  });
}

async function handleWhatsAppLogs(request, response, sql, shopId) {
  const page = parseInt(request.query?.page || '1', 10);
  const limit = parseInt(request.query?.limit || '20', 10);
  const offset = (page - 1) * limit;

  let logs = [];
  let total = 0;
  try {
    logs = await sql.unsafe(
      `SELECT * FROM whatsapp_conversations WHERE repair_shop_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [shopId, limit, offset]
    );
    const cnt = await sql`SELECT COUNT(*) as cnt FROM whatsapp_conversations WHERE repair_shop_id = ${shopId}`;
    total = parseInt(cnt[0]?.cnt || '0', 10);
  } catch (e) { /* table may not exist */ }

  return response.status(200).json({ logs, pagination: { page, limit, total } });
}

async function handleSendTestWhatsApp(request, response, sql, shopId) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v19.0';

  if (!accessToken || !phoneId) {
    return response.status(400).json({ error: "WhatsApp is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID." });
  }

  // Get shop's phone number to send test to
  const shop = await sql`SELECT mobile FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
  const toNumber = shop[0]?.mobile;
  if (!toNumber) return response.status(400).json({ error: "No mobile number on file for this shop." });

  try {
    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: toNumber, type: 'text',
        text: { body: '✅ CoolCare test message — your WhatsApp integration is working!' },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return response.status(200).json({ sent: true, to: toNumber });
    const err = await res.json().catch(() => ({}));
    return response.status(502).json({ error: 'WhatsApp send failed', details: err });
  } catch (e) {
    return response.status(500).json({ error: 'WhatsApp send error: ' + e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════
async function handleGetNotifications(request, response, sql, shopId) {
  const page = parseInt(request.query?.page || '1', 10);
  const limit = parseInt(request.query?.limit || '20', 10);
  const offset = (page - 1) * limit;

  let notifications = [];
  let unreadCount = 0;
  let total = 0;
  try {
    notifications = await sql.unsafe(
      `SELECT * FROM shop_notifications WHERE repair_shop_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [shopId, limit, offset]
    );
    const unread = await sql`SELECT COUNT(*) as cnt FROM shop_notifications WHERE repair_shop_id = ${shopId} AND is_read = false`;
    unreadCount = parseInt(unread[0]?.cnt || '0', 10);
    const cnt = await sql`SELECT COUNT(*) as cnt FROM shop_notifications WHERE repair_shop_id = ${shopId}`;
    total = parseInt(cnt[0]?.cnt || '0', 10);
  } catch (e) { /* table may not exist */ }

  return response.status(200).json({ notifications, unreadCount, pagination: { page, limit, total } });
}

async function handleMarkNotificationRead(request, response, sql, shopId, body) {
  const { notificationId, markAll } = body;
  try {
    if (markAll) {
      await sql`UPDATE shop_notifications SET is_read = true WHERE repair_shop_id = ${shopId} AND is_read = false`;
    } else if (notificationId) {
      await sql`UPDATE shop_notifications SET is_read = true WHERE id = ${notificationId} AND repair_shop_id = ${shopId}`;
    }
  } catch (e) { /* table may not exist */ }
  return response.status(200).json({ message: "Notifications updated" });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
async function handleGetShopSettings(request, response, sql, shopId) {
  const shop = await sql`
    SELECT id, shop_name, owner_name, email, mobile, city, address, services_offered,
           service_areas, gst_number, logo_url, language, timezone, currency, business_hours
    FROM repair_shops WHERE id = ${shopId} LIMIT 1
  `;
  return response.status(200).json({ settings: shop[0] || null });
}

async function handleSaveShopSettings(request, response, sql, shopId, body) {
  const updates = {};
  const fields = { shop_name: 'shop_name', owner_name: 'owner_name', mobile: 'mobile',
    address: 'address', city: 'city', gst_number: 'gst_number', logo_url: 'logo_url',
    language: 'language', timezone: 'timezone', currency: 'currency' };

  for (const [bodyKey, col] of Object.entries(fields)) {
    if (body[bodyKey] !== undefined) updates[col] = body[bodyKey];
  }
  if (body.businessHours !== undefined) updates.business_hours = body.businessHours;

  if (Object.keys(updates).length === 0) return response.status(400).json({ error: "No fields to update" });

  const setParts = []; const setValues = [];
  for (const [col, val] of Object.entries(updates)) {
    if (col === 'business_hours') {
      setValues.push(JSON.stringify(val));
      setParts.push(`${col} = $${setValues.length}::jsonb`);
    } else {
      setValues.push(val);
      setParts.push(`${col} = $${setValues.length}`);
    }
  }
  setValues.push(shopId);
  await sql.unsafe(`UPDATE repair_shops SET ${setParts.join(', ')}, updated_at = now() WHERE id = $${setValues.length}`, setValues);
  return response.status(200).json({ message: "Settings saved" });
}

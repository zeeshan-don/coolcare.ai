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
const { requireAuth, requireRole, requirePlatformAdmin, requireSuperAdmin, logAdminAction } = require("./_lib/auth");
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

// Admin GET actions
const ADMIN_GET_ACTIONS = new Set(["admin", "admin-users", "admin-plans", "admin-payments", "admin-settings", "admin-analytics"]);
// Admin POST actions
const ADMIN_POST_ACTIONS = new Set([
  "suspend", "activate", "delete", "edit-shop", "approve-shop", "reset-password",
  "create-user", "edit-user", "delete-user", "invite-user",
  "create-plan", "edit-plan", "delete-plan", "duplicate-plan", "save-settings",
]);

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const sql = neon(process.env.DATABASE_URL);

  if (request.method === "GET") {
    const action = request.query?.action || "dashboard";
    if (action === "dashboard") return handleDashboard(request, response, sql, shopId);
    if (action === "booking") return handleBookingDetail(request, response, sql, shopId);
    if (action === "export") return handleExport(request, response, sql, shopId);
    if (ADMIN_GET_ACTIONS.has(action)) return handleAdminGet(request, response, sql, auth, action);
    return response.status(400).json({ error: "Invalid GET action" });
  }

  if (request.method === "POST") {
    const body = request.body || {};
    const action = body.action;
    if (action === "update") return handleBookingUpdate(request, response, sql, shopId, body);
    if (ADMIN_POST_ACTIONS.has(action)) return handleAdminPost(request, response, sql, auth, body);
    return response.status(400).json({ error: "Invalid POST action" });
  }

  return response.status(405).json({ error: "Method not allowed" });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════
async function handleDashboard(request, response, sql, shopId) {
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

  return response.status(200).json({
    shop: shopRows[0] || null, counts: statusCounts, bookings,
    pagination: { page: params.page, limit: params.limit, total, totalPages: Math.ceil(total / params.limit) },
    stats: { todayBookings, pendingJobs, completedToday: statusCounts.completed,
      totalRevenue: parseFloat(revenue.total_revenue), monthlyRevenue: parseFloat(revenue.monthly_revenue), weeklyRevenue: parseFloat(revenue.weekly_revenue) },
    weeklyBookings: weeklyResult,
    recentCustomers: recentCustomers.map((c) => ({ name: c.customer_name, phone: c.customer_number, lastBooking: c.last_booking })),
    subscription,
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
    case "admin-payments": return adminListPayments(request, response, sql, auth);
    case "admin-settings": return adminGetSettings(request, response, sql, auth);
    case "admin-analytics": return adminAnalytics(request, response, sql, auth);
    default: return response.status(400).json({ error: "Unknown admin GET action" });
  }
}

// ─── ADMIN DASHBOARD (enhanced analytics) ────────────────────────────────────
async function adminDashboard(request, response, sql, auth) {
  const page = parseInt(request.query?.page || "1", 10);
  const limit = parseInt(request.query?.limit || "20", 10);
  const search = request.query?.search || "";
  const offset = (page - 1) * limit;

  let whereClause = "WHERE 1=1";
  const qp = [];
  if (search) { qp.push(`%${search}%`); whereClause += ` AND (rs.shop_name ILIKE $${qp.length} OR rs.email ILIKE $${qp.length} OR rs.owner_name ILIKE $${qp.length})`; }

  const shops = await sql.unsafe(`
    SELECT rs.id, rs.shop_name, rs.owner_name, rs.email, rs.mobile, rs.city, rs.role,
           rs.subscription_status, rs.suspended_at, rs.created_at,
           (SELECT COUNT(*) FROM bookings WHERE repair_shop_id = rs.id) as total_bookings,
           (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE repair_shop_id = rs.id AND status = 'completed') as total_revenue,
           (SELECT sp.name FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id WHERE s.repair_shop_id = rs.id ORDER BY s.created_at DESC LIMIT 1) as plan_name
    FROM repair_shops rs ${whereClause}
    ORDER BY rs.created_at DESC LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}
  `, [...qp, limit, offset]);

  const analytics = await sql`
    SELECT
      (SELECT COUNT(*) FROM repair_shops) as total_shops,
      (SELECT COUNT(*) FROM repair_shops WHERE suspended_at IS NULL AND is_active = true) as active_shops,
      (SELECT COUNT(*) FROM repair_shops WHERE suspended_at IS NOT NULL) as suspended_shops,
      (SELECT COUNT(*) FROM repair_shops WHERE subscription_status = 'trial') as pending_shops,
      (SELECT COUNT(*) FROM bookings) as total_bookings,
      (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE status = 'completed') as total_revenue,
      (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE status = 'completed' AND created_at >= date_trunc('month', now())) as monthly_revenue,
      (SELECT COUNT(*) FROM subscriptions WHERE status = 'active') as active_subscriptions,
      (SELECT COUNT(*) FROM bookings WHERE created_at >= date_trunc('day', now())) as bookings_today,
      (SELECT COUNT(*) FROM payments WHERE status = 'failed') as failed_payments,
      (SELECT COUNT(*) FROM subscription_plans WHERE is_active = true) as active_plans
  `;

  const countResult = await sql.unsafe(`SELECT COUNT(*) as total FROM repair_shops rs ${whereClause}`, qp);

  return response.status(200).json({
    shops, analytics: analytics[0] || {},
    pagination: { page, limit, total: parseInt(countResult[0]?.total || "0", 10) },
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

    // ── Settings ────────────────────────────────────────────────
    case "save-settings": return adminSaveSettings(request, response, sql, body, actorType, actorId, ip);

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

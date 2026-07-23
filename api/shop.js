// api/shop.js
// Consolidated shop endpoint — dashboard, booking detail, update booking, export CSV, admin.
// GET  /api/shop?page=1&limit=20&status=open&search=raj  → dashboard
// GET  /api/shop?action=export&status=completed&from=…&to=… → CSV export
// GET  /api/shop?action=booking&id=123  → single booking detail
// GET  /api/shop?action=admin&page=1&search=…  → admin: list shops
// POST /api/shop  body: { action: "update", bookingId, … } → update booking
// POST /api/shop  body: { action: "admin_action", shopId, action_type } → admin actions
// Security: auth required, multi-tenant, rate-limited.

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("./_lib/auth");
const { notifyStatusChange } = require("./_lib/notify");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { validate, bookingUpdateSchema } = require("./_lib/validate");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
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
    if (action === "admin") return handleAdminGet(request, response, sql, auth);
    return response.status(400).json({ error: "Invalid GET action" });
  }

  if (request.method === "POST") {
    const body = request.body || {};
    const action = body.action;
    if (action === "update") return handleBookingUpdate(request, response, sql, shopId, body);
    if (action === "suspend" || action === "activate" || action === "delete") return handleAdminPost(request, response, sql, auth, body);
    return response.status(400).json({ error: "Invalid POST action" });
  }

  return response.status(405).json({ error: "Method not allowed" });
});

// ─── DASHBOARD ──────────────────────────────────────────
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

// ─── BOOKING DETAIL ─────────────────────────────────────
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

// ─── EXPORT CSV ──────────────────────────────────────────
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

// ─── BOOKING UPDATE ──────────────────────────────────────
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

  // Timeline audit
  if (data.status && data.status !== oldStatus) {
    await sql`INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, actor_id) VALUES (${data.bookingId}, 'status_change', ${oldStatus}, ${data.status}, 'shop', ${shopId})`;
  }
  if (data.technicianName) {
    await sql`INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, actor_id) VALUES (${data.bookingId}, 'technician_assigned', ${booking.technician_name || null}, ${data.technicianName}, 'shop', ${shopId})`;
  }
  if (data.technicianNotes) {
    await sql`INSERT INTO booking_timeline (booking_id, action, new_value, actor_type, actor_id, notes) VALUES (${data.bookingId}, 'note_added', ${data.technicianNotes}, 'shop', ${shopId}, ${data.technicianNotes})`;
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

// ─── ADMIN GET (list shops) ──────────────────────────────
async function handleAdminGet(request, response, sql, auth) {
  const admin = await requireAdmin(auth, sql, response);
  if (!admin) return;

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
      (SELECT COUNT(*) FROM bookings) as total_bookings,
      (SELECT COALESCE(SUM(final_cost), 0) FROM bookings WHERE status = 'completed') as total_revenue,
      (SELECT COUNT(*) FROM subscriptions WHERE status = 'active') as active_subscriptions,
      (SELECT COUNT(*) FROM bookings WHERE created_at >= date_trunc('day', now())) as bookings_today
  `;

  const countResult = await sql.unsafe(`SELECT COUNT(*) as total FROM repair_shops rs ${whereClause}`, qp);

  return response.status(200).json({
    shops, analytics: analytics[0] || {},
    pagination: { page, limit, total: parseInt(countResult[0]?.total || "0", 10) },
  });
}

// ─── ADMIN POST (shop actions) ───────────────────────────
async function handleAdminPost(request, response, sql, auth, body) {
  const admin = await requireAdmin(auth, sql, response);
  if (!admin) return;

  const targetShopId = body.shopId;
  if (!targetShopId) return response.status(400).json({ error: "shopId required" });

  const actionType = body.action;
  if (!actionType) return response.status(400).json({ error: "action required" });

  if (actionType === "suspend") {
    await sql`UPDATE repair_shops SET suspended_at = now(), suspension_reason = ${body.reason || null}, updated_at = now() WHERE id = ${targetShopId}`;
    console.log(`[admin] Shop #${targetShopId} suspended by admin #${auth.sub}`);
    return response.status(200).json({ message: "Shop suspended" });
  }
  if (actionType === "activate") {
    await sql`UPDATE repair_shops SET suspended_at = NULL, suspension_reason = NULL, is_active = true, updated_at = now() WHERE id = ${targetShopId}`;
    return response.status(200).json({ message: "Shop activated" });
  }
  if (actionType === "delete") {
    await sql`DELETE FROM repair_shops WHERE id = ${targetShopId}`;
    console.log(`[admin] Shop #${targetShopId} deleted by admin #${auth.sub}`);
    return response.status(200).json({ message: "Shop deleted" });
  }

  return response.status(400).json({ error: "Invalid action" });
}

// Verify the authenticated user is an admin (DB lookup)
async function requireAdmin(auth, sql, response) {
  const shop = await sql`SELECT role FROM repair_shops WHERE id = ${parseInt(auth.sub, 10)} LIMIT 1`;
  if (!shop.length || !["admin", "super_admin"].includes(shop[0].role)) {
    response.status(403).json({ error: "Admin access required" });
    return null;
  }
  return shop[0];
}

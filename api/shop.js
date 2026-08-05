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
const { requireAuth, requireRole, requirePlatformAdmin, requireSuperAdmin, requireActiveSubscription, logAdminAction, isDemoShop } = require("./_lib/auth");
const { sendEmail, sendWhatsApp, notifyTechnician } = require("./_lib/notify");
const { insertTimelineEvent, ACTORS, loadRepairTimeline, applyBookingStatusChange } = require("./_lib/repair-lifecycle");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { validate, bookingUpdateSchema, createUserSchema, editUserSchema, createPlanSchema, editPlanSchema, aiSettingsSchema, settingsSchema, resetPasswordSchema } = require("./_lib/validate");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { getHostedWebsiteUrl, getAppBaseUrl } = require("./_lib/config");
const { encrypt, decrypt, mask } = require("./_lib/encrypt");
const { getGatewayList, invalidateCache } = require("./_lib/gateway");
const { buildDemoDashboardResponse, buildDemoInsightsResponse, buildDemoBookingDetailResponse, buildDemoNotificationsResponse, buildDemoAiSettingsResponse, buildDemoShopSettingsResponse, buildDemoReferralsResponse, buildDemoWhatsAppLogsResponse, buildDemoWhatsAppStatusResponse, buildDemoWhatsAppConnectionResponse, buildDemoSubscriptionResponse, buildDemoWidgetSettingsResponse, buildDemoSandboxStatusResponse, buildDemoTechniciansResponse } = require("./_lib/demo-data");
const { buildRealCommandCenter } = require("./_lib/command-center");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

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

// ─── Technician roster schemas ───────────────────────────────────────────────
const technicianCreateSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).trim(),
  // Absent keys stay `undefined` so partial updates never wipe existing values.
  phone: z.string().max(30).optional().nullable().transform((v) => (v === undefined ? undefined : (v == null ? null : String(v).trim()) || null)),
  email: z.string().max(120).optional().nullable().transform((v) => (v === undefined ? undefined : (v == null ? null : String(v).trim()) || null)),
  services: z.array(z.string().max(120)).optional().default([]),
  specialization: z.array(z.string().max(120)).optional().default([]),
  active: z.boolean().optional().default(true),
});
const technicianUpdateSchema = technicianCreateSchema.partial().extend({
  id: z.coerce.number().int().positive("id is required"),
});

// Admin GET actions
const ADMIN_GET_ACTIONS = new Set(["admin", "admin-users", "admin-plans", "admin-pricing", "admin-payments", "admin-settings", "admin-analytics", "admin-gateways", "admin-subscriptions", "admin-invoices", "admin-payment-logs", "admin-pending-activations", "admin-subscription-plans"]);
// Admin POST actions
const ADMIN_POST_ACTIONS = new Set([
  "suspend", "activate", "delete", "edit-shop", "approve-shop", "reject-shop", "reset-password",
  "create-user", "edit-user", "delete-user", "invite-user",
  "create-plan", "edit-plan", "delete-plan", "duplicate-plan", "save-plan-pricing", "save-settings",
  "extend-subscription", "change-plan",
  "save-gateway", "toggle-gateway",
  "toggle-plan-pricing", "toggle-website",
]);
// Gated shop actions (require active subscription)
const GATED_POST_ACTIONS = new Set(["update"]);
const GATED_GET_ACTIONS = new Set(["export"]);
// Non-gated shop GET actions (view-only, always allowed)
const OPEN_GET_ACTIONS = new Set(["dashboard", "insights", "booking", "referrals", "ai-settings", "whatsapp-status", "whatsapp-logs", "whatsapp-connect", "notifications", "shop-settings", "conversation-transcript", "conversation-analytics", "human-handoff-close", "widget-settings", "sandbox-status", "sandbox-ticket", "technicians"]);

// Simplified owner workflow — legacy intermediate statuses roll into the
// 3-state model (Pending → Assigned → Completed). Used for dashboard filters.
const STATUS_GROUPS = {
  pending: ["open", "accepted"],
  assigned: ["assigned", "on_the_way", "arrived", "in_progress", "waiting_parts"],
  completed: ["completed", "payment_received"],
  cancelled: ["cancelled", "rejected"],
};
// Technician roster writes (shop staff)
const TECH_POST_ACTIONS = new Set(["create-technician", "update-technician", "delete-technician", "toggle-technician"]);

// Prompt/engine version surfaced in the Developer Sandbox panel
const PROMPT_VERSION = "llama-3.3-70b-versatile · engine v1.0";

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
    if (action === "insights") return handleInsights(request, response, sql, shopId, auth);
    if (action === "booking") return handleBookingDetail(request, response, sql, shopId, auth);
    if (OPEN_GET_ACTIONS.has(action)) return handleShopGet(request, response, sql, shopId, auth, action);
    // Gated actions
    if (GATED_GET_ACTIONS.has(action)) {
      const sub = await requireActiveSubscription(auth, sql, response);
      if (!sub) return;
      if (action === "export") return handleExport(request, response, sql, shopId);
    }
    return response.status(400).json({ error: "Invalid GET action" });
  }

  // ── DEMO MODE GUARD: Block all write operations for demo shops ──────────
  const isDemo = auth.isDemo || (shopId ? await isDemoShop(sql, shopId) : false);

  if (request.method === "POST") {
    const body = request.body || {};
    const action = body.action;

    // Block all write operations for demo shops
    if (isDemo && action !== 'mark-notification-read') {
      // Allow reading notifications but block everything else
      return response.status(403).json({
        error: "This is a demo account. Changes are not saved.",
        isDemo: true,
        demoError: true,
      });
    }

    // Admin actions
    if (ADMIN_POST_ACTIONS.has(action)) return handleAdminPost(request, response, sql, auth, body);
    // Gated actions (require active subscription)
    if (GATED_POST_ACTIONS.has(action)) {
      const sub = await requireActiveSubscription(auth, sql, response);
      if (!sub) return;
      if (action === "update") return handleBookingUpdate(request, response, sql, shopId, body);
    }
    // Technician roster actions
    if (TECH_POST_ACTIONS.has(action)) return handleTechnicianRoster(request, response, sql, shopId, action, body);
    // Non-gated POST actions
    if (action === "save-ai-settings") return handleSaveAiSettings(request, response, sql, shopId, body);
    if (action === "save-shop-settings") return handleSaveShopSettings(request, response, sql, shopId, body);
    if (action === "mark-notification-read") return handleMarkNotificationRead(request, response, sql, shopId, body);
    if (action === "send-test-whatsapp") return handleSendTestWhatsApp(request, response, sql, shopId);
    if (action === "close-human-handoff") return handleCloseHumanHandoff(request, response, sql, shopId, body);
    if (action === "save-ai-settings-extended") return handleSaveAiSettingsExtended(request, response, sql, shopId, body);
    if (action === "save-widget-settings") return handleSaveWidgetSettings(request, response, sql, shopId, body);
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

  // ── DEMO MODE: Serve from in-memory demo data ───────────────────────────
  if (auth.isDemo) {
    return response.status(200).json(buildDemoDashboardResponse({
      page: params.page,
      limit: params.limit,
      status: params.status || "all",
      search: params.search || "",
    }));
  }

  const offset = (params.page - 1) * params.limit;

  // repair_shop_id is a real parameter ($1) — it MUST also be referenced in the SQL,
  // otherwise PostgreSQL declares $1 with no type context → error 42P18.
  const conditions = [`b.repair_shop_id = $1`];
  const sqlParams = [shopId];
  if (params.status && params.status !== "all") {
    // Simplified workflow groups (pending / assigned / completed / cancelled)
    const group = STATUS_GROUPS[params.status];
    if (group) {
      sqlParams.push(group);
      conditions.push(`b.status = ANY($${sqlParams.length}::text[])`);
    } else {
      sqlParams.push(params.status);
      conditions.push(`b.status = $${sqlParams.length}`);
    }
  }
  if (params.search) { sqlParams.push(`%${params.search}%`); conditions.push(`(b.customer_name ILIKE $${sqlParams.length} OR b.customer_number ILIKE $${sqlParams.length})`); }
  const whereClause = conditions.join(" AND ");
  const sortCol = ["created_at", "updated_at", "status"].includes(params.sortBy) ? params.sortBy : "created_at";
  const sortDir = params.sortDir === "asc" ? "ASC" : "DESC";

  const bookings = await sql(`
    SELECT b.id, b.customer_number, b.customer_name, b.service_type, b.area,
           COALESCE(b.address, b.area, '') AS address,
           b.urgency, b.status, b.technician_id, b.technician_name,
           b.technician_notes, b.estimated_cost, b.final_cost,
           b.priority, b.customer_notes, b.invoice_number,
           COALESCE(b.source, 'whatsapp') AS source,
           b.created_at, b.updated_at,
           t.name AS assigned_technician_name, t.phone AS assigned_technician_phone
    FROM bookings b LEFT JOIN technicians t ON t.id = b.technician_id
    WHERE ${whereClause}
    ORDER BY b.${sortCol} ${sortDir}
    LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}
  `, [...sqlParams, params.limit, offset]);

  const countResult = await sql(`SELECT COUNT(*) as total FROM bookings b WHERE ${whereClause}`, sqlParams);
  const total = parseInt(countResult[0]?.total || "0", 10);

  const counts = await sql`SELECT status, COUNT(*) as count FROM bookings WHERE repair_shop_id = ${shopId} GROUP BY status`;
  const statusCounts = { open: 0, accepted: 0, rejected: 0, assigned: 0, on_the_way: 0, arrived: 0, in_progress: 0, waiting_parts: 0, completed: 0, cancelled: 0, payment_received: 0 };
  counts.forEach((r) => { if (statusCounts[r.status] !== undefined) statusCounts[r.status] = parseInt(r.count, 10); });

  const revenueResult = await sql`
    SELECT COALESCE(SUM(final_cost), 0) as total_revenue,
           COALESCE(SUM(CASE WHEN COALESCE(completed_at, updated_at) >= date_trunc('month', now()) THEN final_cost ELSE 0 END), 0) as monthly_revenue,
           COALESCE(SUM(CASE WHEN COALESCE(completed_at, updated_at) >= date_trunc('week', now()) THEN final_cost ELSE 0 END), 0) as weekly_revenue
    FROM bookings WHERE repair_shop_id = ${shopId} AND status IN ('completed', 'payment_received')
  `;
  const revenue = revenueResult[0] || { total_revenue: 0, monthly_revenue: 0, weekly_revenue: 0 };

  const todayResult = await sql`SELECT COUNT(*) as count FROM bookings WHERE repair_shop_id = ${shopId} AND created_at >= date_trunc('day', now())`;
  const todayBookings = parseInt(todayResult[0]?.count || "0", 10);

  const pendingResult = await sql`SELECT COUNT(*) as count FROM bookings WHERE repair_shop_id = ${shopId} AND status IN ('open', 'accepted', 'assigned', 'on_the_way', 'arrived', 'in_progress', 'waiting_parts')`;
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

  // Revenue chart data — daily for last 30 days, bucketed by COMPLETION time
  // (completed_at) so a job completed today counts today even when the booking
  // was created last week. 'payment_received' keeps counting (money collected).
  const revenueChart = await sql`
    SELECT d.date::date as date,
           COALESCE(SUM(b.final_cost), 0) as revenue,
           COUNT(b.id) as bookings
    FROM generate_series(now() - INTERVAL '29 days', now(), '1 day') d(date)
    LEFT JOIN bookings b ON b.repair_shop_id = ${shopId}
      AND COALESCE(b.completed_at, b.updated_at)::date = d.date::date
      AND b.status IN ('completed', 'payment_received')
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
    FROM bookings WHERE repair_shop_id = ${shopId} AND status IN ('completed', 'payment_received')
    GROUP BY customer_number, customer_name
    HAVING COUNT(*) >= 1
    ORDER BY visit_count DESC, last_visit DESC LIMIT 20
  `;

  // ── Today's money & motion (action KPIs) ─────────────────────────────────
  let revenueToday = 0;
  let completedToday = 0;
  try {
    const todayRev = await sql`
      SELECT COALESCE(SUM(final_cost), 0) AS revenue_today,
             COUNT(*) AS completed_today
      FROM bookings
      WHERE repair_shop_id = ${shopId} AND status IN ('completed', 'payment_received')
        AND COALESCE(completed_at, updated_at) >= date_trunc('day', now())
    `;
    revenueToday = parseFloat(todayRev[0]?.revenue_today || 0);
    completedToday = parseInt(todayRev[0]?.completed_today || "0", 10);
  } catch (e) { /* ok */ }

  let totalCustomers = 0;
  try {
    const cust = await sql`SELECT COUNT(DISTINCT customer_number) AS total FROM bookings WHERE repair_shop_id = ${shopId}`;
    totalCustomers = parseInt(cust[0]?.total || "0", 10);
  } catch (e) { /* ok */ }

  // Pending bookings waiting for a technician — Today's Priorities (real work)
  let pendingAssignments = [];
  try {
    pendingAssignments = await sql`
      SELECT id, customer_name, customer_number, service_type, area, created_at
      FROM bookings
      WHERE repair_shop_id = ${shopId} AND status IN ('open','accepted')
      ORDER BY created_at ASC LIMIT 8
    `;
  } catch (e) { /* ok */ }

  // ── Today vs the 7-day average (excl. today) — tells the owner if today is
  // ahead of or behind a normal day. A business signal, not analysis: every
  // AI/automation/productivity metric lives on the Business Insights page.
  let revenueDeltaPct = 0;
  if (revenueChart.length >= 2) {
    const today = revenueChart[revenueChart.length - 1];
    const prevSeven = revenueChart.slice(-8, -1);
    const prevAvg = prevSeven.reduce((s, d) => s + parseFloat(d.revenue || 0), 0) / Math.max(prevSeven.length, 1);
    revenueDeltaPct = prevAvg > 0 ? Math.round(((parseFloat(today.revenue || 0) - prevAvg) / prevAvg) * 100) : 0;
    revenueDeltaPct = Math.max(-99, Math.min(199, revenueDeltaPct));
  }

  const shopRows = await sql`
    SELECT id, shop_name, owner_name, email, mobile, city, services_offered, service_areas, role, currency
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

  // Check subscription status and approval status for gating UI
  let subscriptionRequired = false;
  let subscriptionStatus = "active";
  let approvalStatus = "approved";
  let rejectionReason = null;
  let websiteEnabled = false;
  let websiteUrl = null;
  try {
    const shopCheck = await sql`SELECT subscription_status, approval_status, rejection_reason, website_enabled, slug FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    subscriptionStatus = shopCheck[0]?.subscription_status || "inactive";
    approvalStatus = shopCheck[0]?.approval_status || "none";
    rejectionReason = shopCheck[0]?.rejection_reason || null;
    subscriptionRequired = subscriptionStatus !== "active" || (approvalStatus !== "approved" && approvalStatus !== "none");
    websiteEnabled = !!shopCheck[0]?.website_enabled;
    if (websiteEnabled && shopCheck[0]?.slug) {
      websiteUrl = getHostedWebsiteUrl(shopCheck[0].slug);
    }
  } catch (e) { /* ok */ }

  return response.status(200).json({
    shop: shopRows[0] || null, counts: statusCounts, bookings,
    pagination: { page: params.page, limit: params.limit, total, totalPages: Math.ceil(total / params.limit) },
    stats: { todayBookings, pendingJobs, revenueToday, completedToday, revenueDeltaPct,
      totalRevenue: parseFloat(revenue.total_revenue), monthlyRevenue: parseFloat(revenue.monthly_revenue), weeklyRevenue: parseFloat(revenue.weekly_revenue),
      monthBookings, totalCustomers, customersCount: totalCustomers },
    pendingAssignments: pendingAssignments.map((p) => ({ id: p.id, customerName: p.customer_name, customerNumber: p.customer_number, serviceType: p.service_type, area: p.area, createdAt: p.created_at })),
    weeklyBookings: weeklyResult,
    revenueChart: revenueChart.map((r) => ({ date: r.date, revenue: parseFloat(r.revenue), bookings: parseInt(r.bookings, 10) })),
    activityFeed: activityFeed.map((a) => ({ id: a.id, bookingId: a.booking_id, action: a.action, oldValue: a.old_value, newValue: a.new_value, customerName: a.customer_name, customerNumber: a.customer_number, serviceType: a.service_type, createdAt: a.created_at })),
    customerHistory: customerHistory.map((c) => ({ name: c.customer_name, phone: c.customer_number, visits: parseInt(c.visit_count, 10), lastVisit: c.last_visit, firstVisit: c.first_visit, totalSpent: parseFloat(c.total_spent) })),
    recentCustomers: recentCustomers.map((c) => ({ name: c.customer_name, phone: c.customer_number, lastBooking: c.last_booking })),
    subscription,
    subscriptionRequired,
    subscriptionStatus,
    approvalStatus,
    rejectionReason,
    websiteEnabled,
    websiteUrl,
    isDemo: !!auth.isDemo,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUSINESS INSIGHTS — analysis. Answers "What can I learn from my business?"
// Hosts everything analysis-y: business health, AI performance, revenue
// analytics, technician performance and customer insights. The action dashboard
// (handleDashboard) intentionally does NOT return these.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleInsights(request, response, sql, shopId, auth) {
  if (!allowMethods(request, response, "GET")) return;

  // DEMO MODE: served from the dedicated demo insights payload.
  if (auth?.isDemo) {
    return response.status(200).json(buildDemoInsightsResponse());
  }

  const statusCounts = { open: 0, accepted: 0, rejected: 0, assigned: 0, on_the_way: 0, arrived: 0, in_progress: 0, waiting_parts: 0, completed: 0, cancelled: 0, payment_received: 0 };
  try {
    const counts = await sql`SELECT status, COUNT(*) as count FROM bookings WHERE repair_shop_id = ${shopId} GROUP BY status`;
    counts.forEach((r) => { if (statusCounts[r.status] !== undefined) statusCounts[r.status] = parseInt(r.count, 10); });
  } catch (e) { /* ok */ }

  // Revenue chart — daily for last 30 days, bucketed by COMPLETION time so a
  // job completed today counts today even when the booking was created earlier.
  let revenueChart = [];
  try {
    revenueChart = await sql`
      SELECT d.date::date as date,
             COALESCE(SUM(b.final_cost), 0) as revenue,
             COUNT(b.id) as bookings
      FROM generate_series(now() - INTERVAL '29 days', now(), '1 day') d(date)
      LEFT JOIN bookings b ON b.repair_shop_id = ${shopId}
        AND COALESCE(b.completed_at, b.updated_at)::date = d.date::date
        AND b.status IN ('completed', 'payment_received')
      GROUP BY d.date ORDER BY d.date ASC
    `;
  } catch (e) { /* ok */ }

  let todayBookings = 0;
  try {
    const t = await sql`SELECT COUNT(*) AS count FROM bookings WHERE repair_shop_id = ${shopId} AND created_at >= date_trunc('day', now())`;
    todayBookings = parseInt(t[0]?.count || "0", 10);
  } catch (e) { /* ok */ }

  let monthlyRevenue = 0, monthBookings = 0;
  try {
    const rev = await sql`SELECT COALESCE(SUM(final_cost), 0) AS monthly_revenue FROM bookings WHERE repair_shop_id = ${shopId} AND status IN ('completed', 'payment_received') AND COALESCE(completed_at, updated_at) >= date_trunc('month', now())`;
    monthlyRevenue = parseFloat(rev[0]?.monthly_revenue || 0);
  } catch (e) { /* ok */ }
  try {
    const m = await sql`SELECT COUNT(*) AS count FROM bookings WHERE repair_shop_id = ${shopId} AND created_at >= date_trunc('month', now())`;
    monthBookings = parseInt(m[0]?.count || "0", 10);
  } catch (e) { /* ok */ }

  // ── Customer analytics ────────────────────────────────────────────────────
  let totalCustomers = 0, repeatCustomers = 0;
  try {
    const c = await sql`
      SELECT COUNT(DISTINCT customer_number) AS total,
             COUNT(DISTINCT CASE WHEN visit_count > 1 THEN customer_number END) AS repeat_customers
      FROM (SELECT customer_number, COUNT(*) AS visit_count FROM bookings WHERE repair_shop_id = ${shopId} GROUP BY customer_number) x
    `;
    totalCustomers = parseInt(c[0]?.total || "0", 10);
    repeatCustomers = parseInt(c[0]?.repeat_customers || "0", 10);
  } catch (e) { /* ok */ }

  let newCustomersMonth = 0;
  try {
    const n = await sql`SELECT COUNT(DISTINCT customer_number) AS total FROM bookings WHERE repair_shop_id = ${shopId} AND created_at >= date_trunc('month', now())`;
    newCustomersMonth = parseInt(n[0]?.total || "0", 10);
  } catch (e) { /* ok */ }

  let topCustomers = [];
  try {
    topCustomers = await sql`
      SELECT customer_name, customer_number, COUNT(*) AS visits,
             COALESCE(SUM(final_cost), 0) AS total_spent, MAX(created_at) AS last_visit
      FROM bookings WHERE repair_shop_id = ${shopId} AND status IN ('completed', 'payment_received')
      GROUP BY customer_name, customer_number ORDER BY total_spent DESC LIMIT 10
    `;
  } catch (e) { /* ok */ }

  // Monthly trend — last 6 months, bucketed by completion time
  let monthlyTrend = [];
  try {
    monthlyTrend = await sql`
      SELECT date_trunc('month', COALESCE(completed_at, created_at))::date AS month,
             COUNT(*) AS bookings,
             COALESCE(SUM(CASE WHEN status IN ('completed', 'payment_received') THEN final_cost ELSE 0 END), 0) AS revenue
      FROM bookings WHERE repair_shop_id = ${shopId} AND created_at >= now() - INTERVAL '6 months'
      GROUP BY date_trunc('month', COALESCE(completed_at, created_at))::date ORDER BY month ASC
    `;
  } catch (e) { /* ok */ }

  const commandCenter = await buildRealCommandCenter(sql, shopId, statusCounts, revenueChart, todayBookings, {
    monthlyRevenue,
    monthBookings,
  });

  // Shop header — the page shows the shop name in the top bar. currency is
  // returned so the insights page formats every amount in the shop's currency.
  let shopRow = null;
  try {
    const shopRows = await sql`SELECT id, shop_name, owner_name, currency FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    shopRow = shopRows[0] || null;
  } catch (e) { /* ok */ }

  return response.status(200).json({
    shop: shopRow,
    ...commandCenter,
    statusCounts,
    revenueChart: revenueChart.map((r) => ({ date: r.date, revenue: parseFloat(r.revenue), bookings: parseInt(r.bookings, 10) })),
    monthlyTrend: monthlyTrend.map((r) => ({ month: r.month, bookings: parseInt(r.bookings, 10), revenue: parseFloat(r.revenue) })),
    customers: {
      totalCustomers,
      repeatCustomers,
      newCustomersMonth,
      topCustomers: topCustomers.map((c) => ({ name: c.customer_name, phone: c.customer_number, visits: parseInt(c.visits, 10), totalSpent: parseFloat(c.total_spent), lastVisit: c.last_visit })),
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOKING DETAIL
// ═══════════════════════════════════════════════════════════════════════════════
async function handleBookingDetail(request, response, sql, shopId, auth) {
  const bookingId = parseInt(request.query?.id, 10);
  if (!bookingId || isNaN(bookingId)) return response.status(400).json({ error: "Invalid booking ID" });

  // ── DEMO MODE: Serve from in-memory demo data ───────────────────────────
  if (auth?.isDemo) {
    const demoData = buildDemoBookingDetailResponse(bookingId);
    if (!demoData) return response.status(404).json({ error: "Booking not found" });
    return response.status(200).json(demoData);
  }

  const bookings = await sql`
    SELECT b.*, rs.shop_name, rs.currency AS shop_currency, t.name AS assigned_technician_name,
           t.phone AS assigned_technician_phone, t.email AS assigned_technician_email
    FROM bookings b LEFT JOIN repair_shops rs ON rs.id = b.repair_shop_id
    LEFT JOIN technicians t ON t.id = b.technician_id
    WHERE b.id = ${bookingId} AND b.repair_shop_id = ${shopId} LIMIT 1
  `;
  if (bookings.length === 0) return response.status(404).json({ error: "Booking not found or access denied" });

  const timeline = await loadRepairTimeline(sql, bookingId);

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

  const bookings = await sql(query, qp);
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
  // Status is applied through the shared repair lifecycle (status + timeline +
  // notification in one place) — everything else is a plain field update.
  if (data.technicianName !== undefined) updates.technician_name = data.technicianName || null;
  if (data.technicianId !== undefined) updates.technician_id = data.technicianId ? parseInt(data.technicianId, 10) : null;
  if (data.technicianNotes !== undefined) updates.technician_notes = data.technicianNotes || null;
  if (data.estimatedCost !== undefined) updates.estimated_cost = data.estimatedCost != null ? parseFloat(data.estimatedCost) : null;
  // NOTE: final_cost is NOT written here — it is written atomically by
  // applyBookingStatusChange() together with payment_status + completed_at so
  // a payment capture can never leave the booking half-updated.
  if (data.priority) updates.priority = data.priority;
  if (data.rescheduleDate !== undefined) updates.reschedule_date = data.rescheduleDate || null;
  if (data.invoiceNumber !== undefined) updates.invoice_number = data.invoiceNumber || null;
  if (body.customerNotes !== undefined) updates.customer_notes = body.customerNotes || null;
  if (body.photoUrls !== undefined) updates.photo_urls = Array.isArray(body.photoUrls) ? body.photoUrls : null;

  const ALLOWED_COLS = new Set(["technician_name","technician_id","technician_notes","estimated_cost","priority","reschedule_date","invoice_number","customer_notes","photo_urls"]);
  const setParts = []; const setValues = [];
  for (const [col, val] of Object.entries(updates)) { if (!ALLOWED_COLS.has(col)) continue; setValues.push(val); setParts.push(`${col} = $${setValues.length}`); }

  // A final amount alone is a valid update — it goes through the lifecycle
  // below (final_cost + payment_status + completed_at atomically), so it must
  // NOT trip the "no fields to update" guard below.
  const hasFinalCost = data.finalCost != null && data.finalCost !== "";

  if (setParts.length > 0) {
    setValues.push(data.bookingId, shopId);
    await sql(`UPDATE bookings SET ${setParts.join(", ")}, updated_at = now() WHERE id = $${setValues.length - 1} AND repair_shop_id = $${setValues.length}`, setValues);
  } else if (!data.status && !hasFinalCost) {
    return response.status(400).json({ error: "No fields to update were provided" });
  }

  // ── Repair lifecycle status change (single shared path) ──────────────────
  // Updates bookings.status, records the status_change timeline event with the
  // actor + optional notes, and notifies the customer on meaningful milestones.
  // When the owner supplies a FINAL AMOUNT (entered at "Mark Completed" or
  // "Collect Payment"), it is saved here too — the lifecycle atomically writes
  // final_cost + payment_status='paid' + completed_at so revenue updates the
  // moment the payment is captured.
  const statusChanged = !!(data.status && data.status !== oldStatus);
  if (statusChanged || hasFinalCost) {
    await applyBookingStatusChange(sql, {
      bookingId: data.bookingId,
      newStatus: data.status || oldStatus,
      actorType: ACTORS.SHOP,
      actorId: shopId,
      notes: data.notes || undefined,
      finalCost: hasFinalCost ? parseFloat(data.finalCost) : null,
      // Only ping the customer when the status actually moved — saving a final
      // amount alone must never re-send a milestone message.
      notify: statusChanged,
    });
  }

  if (data.technicianName && data.technicianName !== booking.technician_name) {
    await insertTimelineEvent(sql, { bookingId: data.bookingId, action: "technician_assigned", oldValue: booking.technician_name || null, newValue: data.technicianName, actorType: ACTORS.SHOP, actorId: shopId });
  }

  // ── Technician assignment notification ────────────────────────────────────
  // A technician only ever gets a job AFTER the owner manually assigns them.
  // Look up the REAL roster record (scoped to this shop) and notify them
  // (fire-and-forget). Only fires when the assignment actually changed, so a
  // re-save of the same technician never re-sends the notification.
  const incomingTechId = data.technicianId != null && data.technicianId !== "" ? parseInt(data.technicianId, 10) : null;
  const techChanged = incomingTechId != null
    ? String(incomingTechId) !== String(booking.technician_id || "")
    : !!(data.technicianName && data.technicianName !== booking.technician_name);
  if (techChanged) {
    try {
      const techId = incomingTechId || booking.technician_id;
      const techRows = await sql`SELECT name, phone FROM technicians WHERE id = ${techId} AND repair_shop_id = ${shopId} LIMIT 1`;
      const tech = techRows[0];
      if (tech?.phone) {
        const b = (await sql`SELECT * FROM bookings WHERE id = ${data.bookingId} LIMIT 1`)[0];
        notifyTechnician(tech.phone, { ...b, technician_name: b.technician_name || tech.name })
          .catch((err) => console.warn("[shop/update] Technician notify failed:", err.message));
      }
    } catch (e) { console.warn("[shop/update] Technician notify lookup failed:", e.message); }
  }
  if (data.priority && data.priority !== booking.priority) {
    await insertTimelineEvent(sql, { bookingId: data.bookingId, action: "priority_change", oldValue: booking.priority || 'normal', newValue: data.priority, actorType: ACTORS.SHOP, actorId: shopId });
  }

  // ── Shop notifications: Booking Cancelled / Payment Received ────────────
  // The notification bell must surface these events, and clicking opens the
  // booking directly. New-booking notifications are created at booking time
  // (api/bookings.js + conversation-engine) with the same deep link.
  const bookingLink = `/shop-booking.html?id=${data.bookingId}`;
  if (data.status === "cancelled" && data.status !== oldStatus) {
    try {
      await sql`
        INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
        VALUES (${shopId}, 'booking_cancelled', 'Booking Cancelled',
                ${`${booking.customer_name || "A customer"} cancelled ${booking.service_type || "the booking"} (Ref #${data.bookingId}).`},
                ${bookingLink})
      `;
    } catch (e) { console.warn("[shop/update] Cancelled notification failed:", e.message); }
  }
  if (data.status === "payment_received" && data.status !== oldStatus) {
    try {
      await sql`
        INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
        VALUES (${shopId}, 'payment_received', 'Payment Received',
                ${`Payment received from ${booking.customer_name || "customer"} for ${booking.service_type || "the repair"} (Ref #${data.bookingId}).`},
                ${bookingLink})
      `;
    } catch (e) { console.warn("[shop/update] Payment notification failed:", e.message); }
  }

  const updated = await sql`SELECT b.*, rs.shop_name, rs.currency AS shop_currency FROM bookings b LEFT JOIN repair_shops rs ON rs.id = b.repair_shop_id WHERE b.id = ${data.bookingId} LIMIT 1`;
  const timeline = await loadRepairTimeline(sql, data.bookingId);

  console.log(`[shop/update] booking #${data.bookingId} by shop #${shopId}:`, { status: data.status });
  return response.status(200).json({ updated: true, booking: updated[0], timeline });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TECHNICIAN ROSTER (Add / Edit / Suspend / Delete)
// ═══════════════════════════════════════════════════════════════════════════════
async function handleTechniciansList(request, response, sql, shopId) {
  // created_at only exists after the technician roster migration (migration-combined.sql §26) — fall back
  // gracefully (repo convention) in case it hasn't been applied yet.
  let rows = [];
  try {
    rows = await sql`
      SELECT t.id, t.name, t.phone, t.email, t.services, t.specialization, t.active, t.created_at,
             (SELECT COUNT(*) FROM bookings b WHERE b.technician_id = t.id
                AND b.status IN ('assigned','on_the_way','arrived','in_progress','waiting_parts')) AS active_jobs,
             (SELECT COUNT(*) FROM bookings b WHERE b.technician_id = t.id) AS total_jobs
      FROM technicians t
      WHERE t.repair_shop_id = ${shopId}
      ORDER BY t.name ASC
    `;
  } catch (e) {
    console.warn("[shop/technicians] created_at may be missing, using fallback:", e.message);
    rows = await sql`
      SELECT t.id, t.name, t.phone, t.email, t.services, t.specialization, t.active,
             (SELECT COUNT(*) FROM bookings b WHERE b.technician_id = t.id
                AND b.status IN ('assigned','on_the_way','arrived','in_progress','waiting_parts')) AS active_jobs,
             (SELECT COUNT(*) FROM bookings b WHERE b.technician_id = t.id) AS total_jobs
      FROM technicians t
      WHERE t.repair_shop_id = ${shopId}
      ORDER BY t.name ASC
    `;
  }
  return response.status(200).json({ technicians: rows });
}

async function handleTechnicianRoster(request, response, sql, shopId, action, body) {
  switch (action) {
    case "create-technician": return handleCreateTechnician(request, response, sql, shopId, body);
    case "update-technician": return handleUpdateTechnician(request, response, sql, shopId, body);
    case "toggle-technician": return handleToggleTechnician(request, response, sql, shopId, body);
    case "delete-technician": return handleDeleteTechnician(request, response, sql, shopId, body);
    default: return response.status(400).json({ error: "Unknown technician action" });
  }
}

async function handleCreateTechnician(request, response, sql, shopId, body) {
  const data = validate({ body }, response, technicianCreateSchema);
  if (!data) return;

  // Enforce plan max_technicians (null = unlimited)
  try {
    const shop = await sql`
      SELECT sp.max_technicians FROM repair_shops rs
      LEFT JOIN subscriptions s ON s.repair_shop_id = rs.id AND s.status = 'active'
      LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
      WHERE rs.id = ${shopId} LIMIT 1
    `;
    const max = shop[0]?.max_technicians;
    if (max != null) {
      const count = await sql`SELECT COUNT(*) as c FROM technicians WHERE repair_shop_id = ${shopId}`;
      if (parseInt(count[0]?.c || "0", 10) >= max) {
        return response.status(403).json({
          error: `Your plan allows a maximum of ${max} technicians. Upgrade your plan to add more.`,
          errorType: "plan_limit",
          maxTechnicians: max,
        });
      }
    }
  } catch (e) { /* plan check is non-fatal */ }

  const rows = await sql`
    INSERT INTO technicians (repair_shop_id, name, phone, email, services, specialization, active, created_at, updated_at)
    VALUES (${shopId}, ${data.name}, ${data.phone ?? null}, ${data.email ?? null}, ${data.services || []}, ${data.specialization || []}, ${data.active !== false}, now(), now())
    RETURNING id, name, phone, email, services, specialization, active, created_at
  `;
  console.log(`[shop] technician created #${rows[0].id} (${data.name}) for shop #${shopId}`);
  return response.status(201).json({ technician: rows[0] });
}

async function handleUpdateTechnician(request, response, sql, shopId, body) {
  const data = validate({ body }, response, technicianUpdateSchema);
  if (!data) return;

  const existing = await sql`SELECT id FROM technicians WHERE id = ${data.id} AND repair_shop_id = ${shopId} LIMIT 1`;
  if (existing.length === 0) return response.status(404).json({ error: "Technician not found" });

  const fieldMap = { name: "name", phone: "phone", email: "email", services: "services", specialization: "specialization", active: "active" };
  const setParts = []; const setValues = [];
  // Only write fields the client actually sent. The parsed `data` carries zod
  // defaults (active=true, services=[]) that must NOT overwrite stored values
  // on a partial update — otherwise editing just the name would unsuspend a
  // suspended technician and wipe their services/specialization.
  for (const [k, col] of Object.entries(fieldMap)) {
    if (Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined) {
      setValues.push(k === "active" ? !!data[k] : data[k]);
      setParts.push(`${col} = $${setValues.length}`);
    }
  }
  if (setParts.length === 0) return response.status(400).json({ error: "No fields to update" });

  setValues.push(data.id, shopId);
  await sql(`UPDATE technicians SET ${setParts.join(", ")}, updated_at = now() WHERE id = $${setValues.length - 1} AND repair_shop_id = $${setValues.length}`, setValues);

  const updated = await sql`SELECT id, name, phone, email, services, specialization, active, created_at FROM technicians WHERE id = ${data.id} LIMIT 1`;
  console.log(`[shop] technician updated #${data.id} for shop #${shopId}`);
  return response.status(200).json({ updated: true, technician: updated[0] });
}

async function handleToggleTechnician(request, response, sql, shopId, body) {
  const id = parseInt(body.id, 10);
  if (!id) return response.status(400).json({ error: "id required" });
  const existing = await sql`SELECT id, active FROM technicians WHERE id = ${id} AND repair_shop_id = ${shopId} LIMIT 1`;
  if (existing.length === 0) return response.status(404).json({ error: "Technician not found" });
  const next = body.active !== undefined ? !!body.active : !existing[0].active;
  await sql`UPDATE technicians SET active = ${next}, updated_at = now() WHERE id = ${id} AND repair_shop_id = ${shopId}`;
  console.log(`[shop] technician #${id} ${next ? "activated" : "suspended"} for shop #${shopId}`);
  return response.status(200).json({ updated: true, active: next });
}

async function handleDeleteTechnician(request, response, sql, shopId, body) {
  const id = parseInt(body.id, 10);
  if (!id) return response.status(400).json({ error: "id required" });
  const existing = await sql`SELECT id, name FROM technicians WHERE id = ${id} AND repair_shop_id = ${shopId} LIMIT 1`;
  if (existing.length === 0) return response.status(404).json({ error: "Technician not found" });

  // Unassign the technician from active jobs first (keeps history intact,
  // only releases the assignment), then remove the roster record.
  await sql`UPDATE bookings SET technician_id = NULL
    WHERE technician_id = ${id} AND repair_shop_id = ${shopId}
      AND status IN ('assigned','on_the_way','arrived','in_progress','waiting_parts','accepted')`;
  await sql`DELETE FROM technicians WHERE id = ${id} AND repair_shop_id = ${shopId}`;
  console.log(`[shop] technician deleted #${id} (${existing[0].name}) for shop #${shopId}`);
  return response.status(200).json({ message: "Technician deleted" });
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
    case "admin-gateways": return adminListGateways(request, response, sql, auth);
    case "admin-subscriptions": return adminListSubscriptions(request, response, sql, auth);
    case "admin-pending-activations": return adminPendingActivations(request, response, sql, auth);
    case "admin-invoices": return adminListInvoices(request, response, sql, auth);
    case "admin-payment-logs": return adminListPaymentLogs(request, response, sql, auth);
    case "admin-subscription-plans": return adminListSubscriptionPlans(request, response, sql, auth);
    default: return response.status(400).json({ error: "Unknown admin GET action" });
  }
}

async function adminListPricing(request, response, sql, auth) {
  let result = {};
  try {
    const plans = await sql`
      SELECT sp.id as plan_id, sp.name as plan_name, sp.display_name,
             spp.id as pricing_id, spp.currency, spp.price_monthly, spp.price_quarterly,
             spp.price_halfyearly, spp.price_yearly, spp.active as pricing_active
      FROM subscription_plans sp
      LEFT JOIN subscription_plan_prices spp ON sp.id = spp.plan_id
      ORDER BY sp.id, spp.currency
    `;

    result = plans.reduce((acc, row) => {
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
          active: row.pricing_active,
        };
      }
      return acc;
    }, {});
  } catch (e) {
    console.warn("[admin/pricing] Tables may not exist:", e.message);
  }

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
    shops = await sql(`
      SELECT rs.id, rs.shop_name, rs.owner_name, rs.email, rs.mobile, rs.city, rs.role,
             COALESCE(rs.subscription_status, 'inactive') as subscription_status,
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
      shops = await sql(`
        SELECT rs.id, rs.shop_name, rs.owner_name, rs.email, rs.mobile, rs.city,
               COALESCE(rs.role, 'owner') as role,
               COALESCE(rs.subscription_status, 'inactive') as subscription_status,
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
      shops = await sql`SELECT id, shop_name, owner_name, email, mobile, city, created_at, 'owner' as role, 'inactive' as subscription_status, NULL as suspended_at, 0 as total_bookings, 0 as total_revenue, NULL as plan_name FROM repair_shops ORDER BY created_at DESC LIMIT 20`;
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
        (SELECT COUNT(*) FROM repair_shops WHERE COALESCE(subscription_status, 'inactive') IN ('inactive', 'none', 'pending_approval') OR COALESCE(approval_status, 'none') = 'pending') as pending_shops,
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
    const pendingActivations = await sql`SELECT COUNT(*) as cnt FROM repair_shops WHERE approval_status = 'pending'`;
    analytics.pending_activations = parseInt(pendingActivations[0]?.cnt || '0', 10);
  } catch (e) { analytics.pending_activations = 0; }

  try {
    const rejectedShops = await sql`SELECT COUNT(*) as cnt FROM repair_shops WHERE approval_status = 'rejected'`;
    analytics.rejected_shops = parseInt(rejectedShops[0]?.cnt || '0', 10);
  } catch (e) { analytics.rejected_shops = 0; }

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
    const countResult = await sql(`SELECT COUNT(*) as total FROM repair_shops rs ${whereClause}`, qp);
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

  let users = [];
  let total = 0;
  try {
    let whereClause = "WHERE 1=1";
    const qp = [];
    if (search) { qp.push(`%${search}%`); whereClause += ` AND (u.name ILIKE $${qp.length} OR u.email ILIKE $${qp.length})`; }
    if (role) { qp.push(role); whereClause += ` AND u.role = $${qp.length}`; }

    users = await sql(`
      SELECT u.id, u.email, u.name, u.role, u.repair_shop_id, u.is_active, u.last_login, u.created_at,
             rs.shop_name as shop_name
      FROM users u LEFT JOIN repair_shops rs ON rs.id = u.repair_shop_id
      ${whereClause}
      ORDER BY u.created_at DESC LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}
    `, [...qp, limit, offset]);

    const countResult = await sql(`SELECT COUNT(*) as total FROM users u ${whereClause}`, qp);
    total = parseInt(countResult[0]?.total || "0", 10);
  } catch (e) {
    console.warn("[admin/users] Table may not exist:", e.message);
  }

  return response.status(200).json({
    users,
    pagination: { page, limit, total },
  });
}

// ─── ADMIN LIST PLANS ────────────────────────────────────────────────────────
async function adminListPlans(request, response, sql, auth) {
  let plans = [];
  try {
    plans = await sql`
      SELECT * FROM subscription_plans ORDER BY is_active DESC, price_monthly_usd ASC
    `;
  } catch (e) {
    console.warn("[admin/plans] Table may not exist:", e.message);
  }
  return response.status(200).json({ plans });
}

// ─── ADMIN LIST PAYMENTS ─────────────────────────────────────────────────────
async function adminListPayments(request, response, sql, auth) {
  const page = parseInt(request.query?.page || "1", 10);
  const limit = parseInt(request.query?.limit || "20", 10);
  const status = request.query?.status || "";
  const offset = (page - 1) * limit;

  let payments = [];
  let total = 0;
  try {
    let whereClause = "WHERE 1=1";
    const qp = [];
    if (status) { qp.push(status); whereClause += ` AND p.status = $${qp.length}`; }

    payments = await sql(`
      SELECT p.id, p.payment_id, p.transaction_id, p.gateway, p.currency, p.amount, p.status,
             p.invoice_number, p.description, p.refund_amount, p.refund_reason, p.refunded_at,
             p.created_at, p.updated_at,
             rs.shop_name, rs.owner_name as shop_owner
      FROM payments p LEFT JOIN repair_shops rs ON rs.id = p.repair_shop_id
      ${whereClause}
      ORDER BY p.created_at DESC LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}
    `, [...qp, limit, offset]);

    const countResult = await sql(`SELECT COUNT(*) as total FROM payments p ${whereClause}`, qp);
    total = parseInt(countResult[0]?.total || "0", 10);
  } catch (e) {
    console.warn("[admin/payments] Table may not exist:", e.message);
  }

  return response.status(200).json({
    payments,
    pagination: { page, limit, total },
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
  let monthly = [];
  let activeShops = [];
  let topCities = [];
  let subBreakdown = [];
  let growth = {};

  try {
    monthly = await sql`
      SELECT date_trunc('month', created_at)::date as month,
             COUNT(*) as bookings,
             COALESCE(SUM(final_cost), 0) as revenue
      FROM bookings
      WHERE created_at >= now() - INTERVAL '12 months'
      GROUP BY date_trunc('month', created_at)::date
      ORDER BY month ASC
    `;
  } catch (e) {
    console.warn("[admin/analytics] Bookings query failed:", e.message);
  }

  try {
    activeShops = await sql`
      SELECT rs.id, rs.shop_name, rs.city, COUNT(b.id) as booking_count,
             COALESCE(SUM(b.final_cost), 0) as total_revenue
      FROM repair_shops rs
      JOIN bookings b ON b.repair_shop_id = rs.id
      GROUP BY rs.id, rs.shop_name, rs.city
      ORDER BY booking_count DESC LIMIT 10
    `;
  } catch (e) {
    console.warn("[admin/analytics] Active shops query failed:", e.message);
  }

  try {
    topCities = await sql`
      SELECT city, COUNT(*) as shop_count FROM repair_shops
      WHERE city IS NOT NULL AND city != ''
      GROUP BY city ORDER BY shop_count DESC LIMIT 10
    `;
  } catch (e) {
    console.warn("[admin/analytics] Top cities query failed:", e.message);
  }

  // Subscription breakdown — may not exist yet
  try {
    subBreakdown = await sql`
      SELECT s.status, COUNT(*) as count FROM subscriptions s GROUP BY s.status
    `;
  } catch (e) {
    console.warn("[admin/analytics] Subscriptions table may not exist:", e.message);
  }

  try {
    const growthRows = await sql`
      SELECT
        (SELECT COUNT(*) FROM repair_shops WHERE created_at >= date_trunc('month', now())) as new_shops_this_month,
        (SELECT COUNT(*) FROM bookings WHERE created_at >= date_trunc('month', now())) as bookings_this_month,
        (SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('month', now())) as new_users_this_month
    `;
    growth = growthRows[0] || {};
  } catch (e) {
    console.warn("[admin/analytics] Growth query failed:", e.message);
  }

  return response.status(200).json({
    monthly, activeShops, topCities,
    subscriptions: subBreakdown,
    growth,
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
    case "approve-shop": return adminApproveShop(request, response, sql, body, actorType, actorId, ip);
    case "reject-shop": return adminRejectShop(request, response, sql, body, actorType, actorId, ip);
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

    // ── Website feature flag (admin override) ─────────────────
    case "toggle-website": return adminToggleWebsite(sql, response, body, actorType, actorId, ip);

    // ── Subscription management ──────────────────────────────
    case "extend-subscription": return adminExtendSubscription(sql, response, body, actorType, actorId, ip);
    case "change-plan": return adminChangePlan(sql, response, body, actorType, actorId, ip);

    // ── Gateway management (Super Admin only) ────────────────
    case "save-gateway": return adminSaveGateway(request, response, sql, auth, body, actorType, actorId, ip);
    case "toggle-gateway": return adminToggleGateway(request, response, sql, auth, body, actorType, actorId, ip);

    // ── Subscription Plans management (Super Admin only) ──────
    case "toggle-plan-pricing": return adminTogglePlanPricing(sql, response, body, actorType, actorId, ip);

    default: return response.status(400).json({ error: "Unknown admin action" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP ADMIN ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
async function adminToggleWebsite(sql, response, body, actorType, actorId, ip) {
  const shopId = body.shopId;
  if (!shopId) return response.status(400).json({ error: "shopId required" });
  const enabled = body.enabled === true;
  await sql`UPDATE repair_shops SET website_enabled = ${enabled}, updated_at = now() WHERE id = ${shopId}`;
  await logAdminAction(sql, { actorType, actorId, action: "toggle_website", targetType: "shop", targetId: shopId, details: { website_enabled: enabled }, ip });
  return response.status(200).json({ message: enabled ? "Hosted website enabled" : "Hosted website disabled", websiteEnabled: enabled });
}
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
  await sql(`UPDATE repair_shops SET ${setParts.join(", ")}, updated_at = now() WHERE id = $${setValues.length}`, setValues);
  await logAdminAction(sql, { actorType, actorId, action: "edit_shop", targetType: "shop", targetId: shopId, details: updates, ip });
  return response.status(200).json({ message: "Shop updated" });
}

async function adminApproveShop(request, response, sql, body, actorType, actorId, ip) {
  const shopId = body.shopId;
  if (!shopId) return response.status(400).json({ error: "shopId required" });
  
  // Get shop info before update
  const shopRows = await sql`SELECT id, shop_name, owner_name, email, mobile, approval_status FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
  if (shopRows.length === 0) return response.status(404).json({ error: "Shop not found" });
  if (shopRows[0].approval_status === 'approved') {
    return response.status(409).json({ error: "Shop is already approved", approvalStatus: 'approved' });
  }
  const shop = shopRows[0];

  await sql`UPDATE repair_shops SET is_active = true, subscription_status = 'active', approval_status = 'approved', approved_at = now(), approved_by = ${actorId}, rejection_reason = NULL, updated_at = now() WHERE id = ${shopId}`;

  // ── Website access: enable the hosted website when the shop's plan is Pro ──
  try {
    const plan = await sql`
      SELECT sp.features FROM subscriptions s
      JOIN subscription_plans sp ON sp.id = s.plan_id
      WHERE s.repair_shop_id = ${shopId} AND s.status = 'active'
      ORDER BY s.created_at DESC LIMIT 1
    `;
    const features = plan[0]?.features;
    const feats = typeof features === "string" ? JSON.parse(features) : (features || {});
    const websiteOn = !!(feats.hosted_website || feats.website_enabled || feats.website);
    await sql`UPDATE repair_shops SET website_enabled = ${websiteOn}, updated_at = now() WHERE id = ${shopId}`;
  } catch (e) { console.warn("[shop/approve] website_enabled plan check failed:", e.message); }
  
  // Log action
  await logAdminAction(sql, { actorType, actorId, action: "approve_shop", targetType: "shop", targetId: shopId, details: { approval: 'granted' }, ip });

  // In-app notification for shop owner
  try {
    await sql`
      INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
      VALUES (${shopId}, 'account_approved', 'Account Approved! 🎉',
              'Your CoolCare account has been approved! You can now use the AI chatbot, dashboard, WhatsApp integration, and all booking features.',
              '/shop-dashboard.html')
    `;
  } catch (e) { /* ok */ }

  // Send email notification
  const subject = 'Your CoolCare Account Has Been Approved! 🎉';
  const htmlBody = `<div style="font-family:Inter,sans-serif;padding:24px;background:#0a0a0a;color:#ededed;">
    <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid #222;border-radius:12px;padding:32px;">
      <h2 style="color:#fff;margin:0 0 16px;font-size:20px;">Welcome to CoolCare! ✅</h2>
      <p style="color:#a3a3a3;line-height:1.6;">Hi ${shop.owner_name},</p>
      <p style="color:#e5e5e5;line-height:1.6;">Your CoolCare account has been approved! You can now start using all features:</p>
      <ul style="color:#a3a3a3;line-height:1.8;padding-left:20px;">
        <li>🤖 AI Assistant for WhatsApp</li>
        <li>📊 Full Dashboard Access</li>
        <li>🔧 Booking Management</li>
        <li>💬 WhatsApp Integration</li>
      </ul>
      <p style="margin:24px 0 0;"><a href="${getAppBaseUrl()}/shop-dashboard.html"
        style="display:inline-block;background:#fff;color:#000;font-weight:600;font-size:14px;padding:12px 32px;border-radius:8px;text-decoration:none;">Go to Dashboard</a></p>
      <hr style="border:none;border-top:1px solid #222;margin:24px 0;">
      <p style="color:#525252;font-size:12px;margin:0;">CoolCare — Better service, one conversation at a time.</p>
    </div></div>`;
  try {
    if (shop.email) await sendEmail(shop.email, subject, htmlBody);
  } catch (e) { console.warn("[shop/approve] Email failed:", e.message); }

  // Send WhatsApp notification
  try {
    const waMsg = `✅ *CoolCare Account Approved!*\n\nHi ${shop.owner_name}, your account has been approved! You can now use the AI chatbot, dashboard, and all booking features.\n\nStart here: ${getAppBaseUrl()}/shop-dashboard.html`;
    if (shop.mobile) await sendWhatsApp(shop.mobile, waMsg);
  } catch (e) { console.warn("[shop/approve] WhatsApp failed:", e.message); }

  console.log("[shop/approve] Shop #" + shopId + " approved by actor #" + actorId);
  return response.status(200).json({ message: "Shop approved. AI features activated.", approvalStatus: "approved" });
}

async function adminRejectShop(request, response, sql, body, actorType, actorId, ip) {
  const shopId = body.shopId;
  const reason = body.reason || "No reason provided";
  if (!shopId) return response.status(400).json({ error: "shopId required" });
  
  const shopRows = await sql`SELECT id, shop_name, owner_name, email, approval_status FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
  if (shopRows.length === 0) return response.status(404).json({ error: "Shop not found" });
  if (shopRows[0].approval_status === 'rejected') {
    return response.status(409).json({ error: "Shop is already rejected", approvalStatus: 'rejected' });
  }
  const shop = shopRows[0];

  await sql`UPDATE repair_shops SET approval_status = 'rejected', rejection_reason = ${reason}, updated_at = now() WHERE id = ${shopId}`;
  await logAdminAction(sql, { actorType, actorId, action: "reject_shop", targetType: "shop", targetId: shopId, details: { reason }, ip });

  // In-app notification
  try {
    await sql`
      INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
      VALUES (${shopId}, 'account_rejected', 'Account Application Update',
              ${'Your CoolCare account application was not approved. Reason: ' + reason + '. Please contact support for more information.'},
              '/contact.html')
    `;
  } catch (e) { /* ok */ }

  // Email notification
  try {
    if (shop.email) {
      const subject = 'CoolCare Account Application Status';
      const htmlBody = `<div style="font-family:Inter,sans-serif;padding:24px;background:#0a0a0a;color:#ededed;">
        <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid #222;border-radius:12px;padding:32px;">
          <h2 style="color:#fff;margin:0 0 16px;font-size:20px;">Application Update</h2>
          <p style="color:#a3a3a3;line-height:1.6;">Hi ${shop.owner_name},</p>
          <p style="color:#e5e5e5;line-height:1.6;">We reviewed your CoolCare account application, but we were unable to approve it at this time.</p>
          <p style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:12px;color:#ef4444;font-size:14px;">
            <strong>Reason:</strong> ${reason}
          </p>
          <p style="color:#a3a3a3;line-height:1.6;margin-top:16px;">If you have any questions, please contact our support team.</p>
          <hr style="border:none;border-top:1px solid #222;margin:24px 0;">
          <p style="color:#525252;font-size:12px;margin:0;">CoolCare — Better service, one conversation at a time.</p>
        </div></div>`;
      await sendEmail(shop.email, subject, htmlBody);
    }
  } catch (e) { console.warn("[shop/reject] Email failed:", e.message); }

  // WhatsApp notification
  try {
    if (shop.mobile) {
      const waMsg = `ℹ️ *CoolCare Application Update*\n\nHi ${shop.owner_name}, we reviewed your application but were unable to approve it.\nReason: ${reason}\n\nPlease contact support for assistance.`;
      await sendWhatsApp(shop.mobile, waMsg);
    }
  } catch (e) { console.warn("[shop/reject] WhatsApp failed:", e.message); }

  console.log("[shop/reject] Shop #" + shopId + " rejected by actor #" + actorId + ":", reason);
  return response.status(200).json({ message: "Shop rejected", reason });
}

async function adminPendingActivations(request, response, sql, auth) {
  try {
    const shops = await sql`
      SELECT rs.id, rs.shop_name, rs.owner_name, rs.email, rs.mobile, rs.city, rs.created_at,
             rs.approval_status, rs.rejection_reason,
             p.amount as payment_amount, p.currency as payment_currency,
             p.gateway as payment_gateway, p.payment_id, p.transaction_id,
             p.created_at as payment_date,
             s.billing_cycle, s.current_period_start, s.current_period_end
      FROM repair_shops rs
      LEFT JOIN payments p ON p.repair_shop_id = rs.id AND p.status = 'completed'
      LEFT JOIN subscriptions s ON s.repair_shop_id = rs.id AND s.status = 'active'
      WHERE rs.approval_status = 'pending'
      ORDER BY rs.created_at DESC
    `;
    return response.status(200).json({ shops });
  } catch (e) {
    console.error("[shop/admin-pending-activations] Failed:", e.message);
    // Fallback with minimal fields if columns don't exist
    try {
      const shops = await sql`
        SELECT id, shop_name, owner_name, email, mobile, city, created_at,
               'pending' as approval_status, NULL as rejection_reason
        FROM repair_shops WHERE approval_status = 'pending'
        ORDER BY created_at DESC
      `;
      return response.status(200).json({ shops });
    } catch (e2) {
      return response.status(500).json({ error: "Failed to fetch pending activations", detail: e2.message });
    }
  }
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
  await sql(`UPDATE users SET ${setParts.join(", ")}, updated_at = now() WHERE id = $${setValues.length}`, setValues);
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
       ${JSON.stringify(data.features || {})}, ${data.trial_days}, ${data.currency}, ${data.is_active})
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
    setValues.push(col === "features" ? JSON.stringify(val) : val);
    setParts.push(`${col} = $${setValues.length}`);
  }
  setValues.push(data.planId);
  await sql(`UPDATE subscription_plans SET ${setParts.join(", ")} WHERE id = $${setValues.length}`, setValues);
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
    // Keep the USD display columns on subscription_plans in sync so the
    // admin "Plans" view never shows a different price than what is charged.
    if (currency === "USD") {
      await sql`UPDATE subscription_plans SET price_monthly_usd = ${data.price_monthly}, price_yearly_usd = ${data.price_yearly}, updated_at = now() WHERE id = ${data.planId}`;
    }
    await logAdminAction(sql, { actorType, actorId, action: "update_plan_pricing", targetType: "plan_pricing", targetId: existing[0].id, ip });
    return response.status(200).json({ message: "Pricing updated" });
  }

  const rows = await sql`
    INSERT INTO subscription_plan_prices
      (plan_id, currency, price_monthly, price_quarterly, price_halfyearly, price_yearly)
    VALUES (${data.planId}, ${data.currency}, ${data.price_monthly}, ${data.price_quarterly}, ${data.price_halfyearly}, ${data.price_yearly})
    RETURNING id
  `;
  if (currency === "USD") {
    await sql`UPDATE subscription_plans SET price_monthly_usd = ${data.price_monthly}, price_yearly_usd = ${data.price_yearly}, updated_at = now() WHERE id = ${data.planId}`;
  }
  await logAdminAction(sql, { actorType, actorId, action: "create_plan_pricing", targetType: "plan_pricing", targetId: rows[0].id, ip });
  return response.status(201).json({ message: "Pricing saved" });
}

// ─── ADMIN LIST SUBSCRIPTION PLANS (for admin subscription plans page) ─────
async function adminListSubscriptionPlans(request, response, sql, auth) {
  // Requires super admin
  const sa = await requireSuperAdmin(auth, sql, response);
  if (!sa) return;

  try {
    const plans = await sql`
      SELECT sp.id as plan_id, sp.name, sp.display_name, sp.is_active as plan_active,
             spp.id as pricing_id, spp.currency, spp.price_monthly, spp.price_quarterly,
             spp.price_halfyearly, spp.price_yearly, spp.active as pricing_active,
             spp.created_at as pricing_created, spp.updated_at as pricing_updated
      FROM subscription_plans sp
      LEFT JOIN subscription_plan_prices spp ON sp.id = spp.plan_id
      ORDER BY sp.id, spp.currency
    `;

    // Group by plan
    const result = plans.reduce((acc, row) => {
      const pid = row.plan_id;
      if (!acc[pid]) {
        acc[pid] = {
          plan_id: pid,
          name: row.name,
          display_name: row.display_name,
          is_active: row.plan_active,
          pricing: {},
        };
      }
      if (row.currency) {
        acc[pid].pricing[row.currency] = {
          pricing_id: row.pricing_id,
          monthly: parseFloat(row.price_monthly || 0),
          quarterly: parseFloat(row.price_quarterly || 0),
          halfyearly: parseFloat(row.price_halfyearly || 0),
          yearly: parseFloat(row.price_yearly || 0),
          active: row.pricing_active,
        };
      }
      return acc;
    }, {});

    return response.status(200).json({ plans: Object.values(result) });
  } catch (err) {
    console.error("[admin/subscription-plans] Failed:", err.message);
    return response.status(500).json({ error: "Failed to load subscription plans" });
  }
}

// ─── ADMIN TOGGLE PLAN PRICING ACTIVE ───────────────────────────────────────
async function adminTogglePlanPricing(sql, response, body, actorType, actorId, ip) {
  const pricingId = body.pricingId;
  if (!pricingId) return response.status(400).json({ error: "pricingId required" });

  const active = body.active !== undefined ? body.active : null;
  if (active === null) return response.status(400).json({ error: "active flag required" });

  try {
    await sql`
      UPDATE subscription_plan_prices
      SET active = ${active === true || active === 'true'}, updated_at = now()
      WHERE id = ${pricingId}
    `;
    await logAdminAction(sql, { actorType, actorId, action: "toggle_plan_pricing", targetType: "plan_pricing", targetId: pricingId, details: { active }, ip });
    return response.status(200).json({ message: `Pricing ${active ? 'enabled' : 'disabled'}` });
  } catch (err) {
    console.error("[admin/toggle-pricing] Failed:", err.message);
    return response.status(500).json({ error: "Failed to toggle pricing" });
  }
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
       ${JSON.stringify(p.features || {})}, ${p.trial_days || 14}, ${p.currency || 'USD'}, false)
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
      VALUES (${key}, ${JSON.stringify(typeof value === "object" ? value : { value })}, ${actorId}, now())
      ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(typeof value === "object" ? value : { value })},
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
    await sql(
      `UPDATE subscriptions SET current_period_end = current_period_end + ($1 || ' days')::interval, updated_at = now()
       WHERE repair_shop_id = $2 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      String(daysNum), shopId
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
  // ── DEMO MODE: Serve from in-memory demo data ───────────────────────────
  if (auth.isDemo) {
    switch (action) {
      case "referrals": return response.status(200).json(buildDemoReferralsResponse());
      case "ai-settings": return response.status(200).json(buildDemoAiSettingsResponse());
      case "whatsapp-status": return response.status(200).json(buildDemoWhatsAppStatusResponse());
      case "whatsapp-logs": return response.status(200).json(buildDemoWhatsAppLogsResponse());
      case "notifications": return response.status(200).json(buildDemoNotificationsResponse(parseInt(request.query?.limit || "50", 10)));
      case "shop-settings": return response.status(200).json(buildDemoShopSettingsResponse());
      case "conversation-transcript": return response.status(200).json({
        messages: [], state: null, booking: null,
        isDemo: true,
        note: "In production, this shows real conversation transcripts, images, files, and sentiment data.",
      });
      case "widget-settings": return response.status(200).json(buildDemoWidgetSettingsResponse());
      case "sandbox-status": return response.status(200).json(buildDemoSandboxStatusResponse());
      case "sandbox-ticket": return handleSandboxTicket(request, response, sql, shopId);
      case "conversation-analytics": return response.status(200).json({
        daily: [], summary: {
          totalConversations: 42, totalBookings: 28, totalHandoffs: 3,
          completionRate: 67, handoffRate: 7, avgResponseTimeMs: 1200,
          mostCommonAppliance: "AC", mostCommonIssue: "Not cooling",
          dropOffStage: "COLLECTING_ADDRESS",
          bookingCompletionPercent: 67, humanHandoffPercent: 7,
        },
        isDemo: true,
      });
      case "technicians": return response.status(200).json(buildDemoTechniciansResponse());
      default: return response.status(400).json({ error: "Unknown GET action" });
    }
  }

  switch (action) {
    case "referrals": return handleReferrals(request, response, sql, shopId);
    case "ai-settings": return handleGetAiSettings(request, response, sql, shopId);
    case "whatsapp-status": return handleWhatsAppStatus(request, response, sql, shopId);
    case "whatsapp-logs": return handleWhatsAppLogs(request, response, sql, shopId);
    case "notifications": return handleGetNotifications(request, response, sql, shopId);
    case "shop-settings": return handleGetShopSettings(request, response, sql, shopId);
    case "conversation-transcript": return handleConversationTranscript(request, response, sql, shopId);
    case "conversation-analytics": return handleConversationAnalytics(request, response, sql, shopId);
    case "technicians": return handleTechniciansList(request, response, sql, shopId);
    case "widget-settings": return handleGetWidgetSettings(request, response, sql, shopId);
    case "sandbox-status": return handleSandboxStatus(request, response, sql, shopId);
    case "sandbox-ticket": return handleSandboxTicket(request, response, sql, shopId);
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
    shareLink: `${getAppBaseUrl()}/shop-signup.html?ref=${referralCode || ''}`,
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
  } catch (e) {
    console.warn("[shop/ai-settings] GET: table may not exist:", e.message);
  }

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
  const data = validate({ body }, response, aiSettingsSchema);
  if (!data) return;
  const { greetingMessage, businessHours, workingDays, supportedServices, knowledgeBase, fallbackResponse, transferToHuman } = data;
  try {
    const result = await sql`
      INSERT INTO ai_settings (repair_shop_id, greeting_message, business_hours, working_days, supported_services, knowledge_base, fallback_response, transfer_to_human, updated_at)
      VALUES (${shopId}, ${greetingMessage || ''},        ${JSON.stringify(businessHours || {})}, ${workingDays || ['mon','tue','wed','thu','fri','sat']},
              ${supportedServices || []}, ${knowledgeBase || ''}, ${fallbackResponse || ''}, ${transferToHuman !== false}, now())
      ON CONFLICT (repair_shop_id) DO UPDATE SET
        greeting_message = ${greetingMessage || ''}, business_hours = ${JSON.stringify(businessHours || {})},
        working_days = ${workingDays || ['mon','tue','wed','thu','fri','sat']},
        supported_services = ${supportedServices || []}, knowledge_base = ${knowledgeBase || ''},
        fallback_response = ${fallbackResponse || ''}, transfer_to_human = ${transferToHuman !== false}, updated_at = now()
      RETURNING id
    `;
    console.log("[shop/ai-settings] Saved for shop #" + shopId + ", row id:", result[0]?.id);
  } catch (e) {
    console.error("[shop/ai-settings] Save failed for shop #" + shopId + ":", {
      message: e.message,
      code: e.code,
      detail: e.detail,
      stack: e.stack?.split('\n').slice(0, 3).join('\n'),
      body: JSON.stringify({ ...body, supportedServices: undefined }),
    });
    // Attempt auto-recovery: create table if missing and retry
    if (e.code === '42P01' || e.message?.includes('does not exist')) {
      try {
        await sql`CREATE TABLE IF NOT EXISTS ai_settings (
          id SERIAL PRIMARY KEY,
          repair_shop_id INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
          greeting_message TEXT DEFAULT \'\',
          business_hours JSONB DEFAULT \'{}\',
          working_days TEXT[] DEFAULT ARRAY[\'mon\',\'tue\',\'wed\',\'thu\',\'fri\',\'sat\'],
          supported_services TEXT[] DEFAULT \'{}\',
          knowledge_base TEXT DEFAULT \'\',
          fallback_response TEXT DEFAULT \'I apologize, but I am unable to help with that right now. A team member will get back to you shortly.\',
          transfer_to_human BOOLEAN NOT NULL DEFAULT true,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(repair_shop_id)
        )`;
        console.log("[shop/ai-settings] Auto-created ai_settings table for shop #" + shopId);
        // Retry the original INSERT once after creating the table
        const retryResult = await sql`
          INSERT INTO ai_settings (repair_shop_id, greeting_message, business_hours, working_days, supported_services, knowledge_base, fallback_response, transfer_to_human, updated_at)
          VALUES (${shopId}, ${greetingMessage || ''},        ${JSON.stringify(businessHours || {})}, ${workingDays || ['mon','tue','wed','thu','fri','sat']},
                ${supportedServices || []}, ${knowledgeBase || ''}, ${fallbackResponse || ''}, ${transferToHuman !== false}, now())
          ON CONFLICT (repair_shop_id) DO UPDATE SET
            greeting_message = ${greetingMessage || ''}, business_hours = ${JSON.stringify(businessHours || {})},
            working_days = ${workingDays || ['mon','tue','wed','thu','fri','sat']},
            supported_services = ${supportedServices || []}, knowledge_base = ${knowledgeBase || ''},
            fallback_response = ${fallbackResponse || ''}, transfer_to_human = ${transferToHuman !== false}, updated_at = now()
          RETURNING id
        `;
        console.log("[shop/ai-settings] Retry INSERT succeeded for shop #" + shopId + ", row id:", retryResult[0]?.id);
        return response.status(200).json({ message: "AI settings saved (table auto-created)" });
      } catch (createErr) {
        console.error("[shop/ai-settings] Auto-recovery failed for shop #" + shopId + ":", {
          message: createErr.message,
          code: createErr.code,
          detail: createErr.detail,
        });
        return response.status(500).json({
          error: "Database configuration error: ai_settings table could not be created",
          detail: process.env.NODE_ENV !== 'production' ? createErr.message : undefined,
        });
      }
    }
    return response.status(500).json({
      error: "Failed to save AI settings",
      detail: process.env.NODE_ENV !== 'production' ? e.message : undefined,
    });
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
    logs = await sql(
      `SELECT * FROM whatsapp_conversations WHERE repair_shop_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      shopId, limit, offset
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
    notifications = await sql(
      `SELECT * FROM shop_notifications WHERE repair_shop_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      shopId, limit, offset
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
           service_areas, gst_number, logo_url, language, timezone, currency, business_hours,
           digest_enabled, digest_time, slug, website_enabled
    FROM repair_shops WHERE id = ${shopId} LIMIT 1
  `;
  const s = shop[0] || null;
  let websiteUrl = null;
  if (s?.website_enabled && s?.slug) {
    websiteUrl = getHostedWebsiteUrl(s.slug);
  }
  return response.status(200).json({ settings: s, websiteUrl });
}

async function handleSaveShopSettings(request, response, sql, shopId, body) {
  const updates = {};
  const fields = { shop_name: 'shop_name', owner_name: 'owner_name', mobile: 'mobile',
    address: 'address', city: 'city', gst_number: 'gst_number', logo_url: 'logo_url',
    language: 'language', timezone: 'timezone', currency: 'currency', slug: 'slug' };

  // Slug is sanitized on the server (lowercase, alphanumerics + dashes only)
  if (typeof body.slug === "string") {
    const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug && slug.length <= 100) {
      // Uniqueness check
      try {
        const dup = await sql`SELECT id FROM repair_shops WHERE slug = ${slug} AND id <> ${shopId} LIMIT 1`;
        if (dup.length === 0) updates.slug = slug;
      } catch (e) { /* column may not exist yet */ }
    }
  }

  for (const [bodyKey, col] of Object.entries(fields)) {
    if (body[bodyKey] !== undefined) updates[col] = body[bodyKey];
  }
  if (body.businessHours !== undefined) updates.business_hours = body.businessHours;
  if (body.digestEnabled !== undefined) updates.digest_enabled = !!body.digestEnabled;
  if (body.digestTime !== undefined) updates.digest_time = String(body.digestTime || '08:00').slice(0, 5);

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
  await sql(`UPDATE repair_shops SET ${setParts.join(', ')}, updated_at = now() WHERE id = $${setValues.length}`, setValues);
  return response.status(200).json({ message: "Settings saved" });
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSITE CHAT WIDGET SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
async function handleGetWidgetSettings(request, response, sql, shopId) {
  let settings = null;
  try {
    const rows = await sql`SELECT * FROM widget_settings WHERE repair_shop_id = ${shopId} LIMIT 1`;
    settings = rows[0] || null;
  } catch (e) {
    console.warn("[shop/widget-settings] table may not exist:", e.message);
  }

  if (!settings) {
    const shop = await sql`SELECT shop_name, logo_url FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    settings = {
      enabled: false,
      business_name: shop[0]?.shop_name || null,
      welcome_message: "",
      offline_message: "",
      primary_color: "#22c55e",
      accent_color: "#16a34a",
      widget_position: "bottom-right",
      logo_url: shop[0]?.logo_url || "",
      theme: "auto",
      show_avatar: true,
      auto_open: false,
      language: "en",
    };
  }

  // Hosted website feature flag (Website Chat is a Pro feature)
  let websiteEnabled = false;
  let websiteUrl = null;
  let slug = null;
  try {
    const shopRow = await sql`SELECT slug, website_enabled FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    websiteEnabled = !!shopRow[0]?.website_enabled;
    slug = shopRow[0]?.slug || null;
    if (websiteEnabled && slug) {
      websiteUrl = getHostedWebsiteUrl(slug);
    }
  } catch (e) { /* column may not exist yet */ }

  // Compute the embed snippet for this shop
  const appUrl = getAppBaseUrl();
  const embedCode = `<script src="${appUrl}/web-bot/widget.js" data-widget-id="${shopId}"></script>`;

  return response.status(200).json({ settings, embedCode, websiteEnabled, websiteUrl });
}

async function handleSaveWidgetSettings(request, response, sql, shopId, body) {
  const { enabled, businessName, welcomeMessage, offlineMessage, primaryColor, accentColor, widgetPosition, logoUrl, theme, showAvatar, autoOpen, language } = body;

  const color = /^#[0-9a-fA-F]{6}$/.test(String(primaryColor || "")) ? primaryColor : "#22c55e";
  const accent = /^#[0-9a-fA-F]{6}$/.test(String(accentColor || "")) ? accentColor : "#16a34a";
  const position = widgetPosition === "bottom-left" ? "bottom-left" : "bottom-right";
  const themeVal = ["light", "dark", "auto"].includes(theme) ? theme : "auto";
  const langVal = ["en", "hi", "ta", "ar", "auto"].includes(language) ? language : "en";

  try {
    await sql`
      INSERT INTO widget_settings
        (repair_shop_id, enabled, business_name, welcome_message, offline_message,
         primary_color, accent_color, widget_position, logo_url, theme, show_avatar,
         auto_open, language, updated_at)
      VALUES
        (${shopId}, ${!!enabled}, ${businessName || null}, ${welcomeMessage || ""}, ${offlineMessage || ""},
         ${color}, ${accent}, ${position}, ${logoUrl || ""}, ${themeVal}, ${showAvatar !== false},
         ${!!autoOpen}, ${langVal}, now())
      ON CONFLICT (repair_shop_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        business_name = EXCLUDED.business_name,
        welcome_message = EXCLUDED.welcome_message,
        offline_message = EXCLUDED.offline_message,
        primary_color = EXCLUDED.primary_color,
        accent_color = EXCLUDED.accent_color,
        widget_position = EXCLUDED.widget_position,
        logo_url = EXCLUDED.logo_url,
        theme = EXCLUDED.theme,
        show_avatar = EXCLUDED.show_avatar,
        auto_open = EXCLUDED.auto_open,
        language = EXCLUDED.language,
        updated_at = now()
    `;
    return response.status(200).json({ message: "Widget settings saved" });
  } catch (e) {
    // Auto-recovery: create the table if missing, then retry
    if (e.code === '42P01' || e.message?.includes('does not exist')) {
      try {
        await sql`CREATE TABLE IF NOT EXISTS widget_settings (
          id SERIAL PRIMARY KEY,
          repair_shop_id INTEGER NOT NULL REFERENCES repair_shops(id) ON DELETE CASCADE,
          enabled BOOLEAN NOT NULL DEFAULT false,
          business_name TEXT,
          welcome_message TEXT DEFAULT '',
          offline_message TEXT DEFAULT '',
          primary_color TEXT NOT NULL DEFAULT '#22c55e',
          accent_color TEXT NOT NULL DEFAULT '#16a34a',
          widget_position TEXT NOT NULL DEFAULT 'bottom-right',
          logo_url TEXT DEFAULT '',
          theme TEXT NOT NULL DEFAULT 'auto',
          show_avatar BOOLEAN NOT NULL DEFAULT true,
          auto_open BOOLEAN NOT NULL DEFAULT false,
          language TEXT NOT NULL DEFAULT 'en',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT unique_widget_settings_shop UNIQUE (repair_shop_id)
        )`;
        await sql`
          INSERT INTO widget_settings
            (repair_shop_id, enabled, business_name, welcome_message, offline_message,
             primary_color, accent_color, widget_position, logo_url, theme, show_avatar,
             auto_open, language, updated_at)
          VALUES
            (${shopId}, ${!!enabled}, ${businessName || null}, ${welcomeMessage || ""}, ${offlineMessage || ""},
             ${color}, ${accent}, ${position}, ${logoUrl || ""}, ${themeVal}, ${showAvatar !== false},
             ${!!autoOpen}, ${langVal}, now())
          ON CONFLICT (repair_shop_id) DO UPDATE SET
            enabled = EXCLUDED.enabled, business_name = EXCLUDED.business_name,
            welcome_message = EXCLUDED.welcome_message, offline_message = EXCLUDED.offline_message,
            primary_color = EXCLUDED.primary_color, accent_color = EXCLUDED.accent_color,
            widget_position = EXCLUDED.widget_position, logo_url = EXCLUDED.logo_url,
            theme = EXCLUDED.theme, show_avatar = EXCLUDED.show_avatar,
            auto_open = EXCLUDED.auto_open, language = EXCLUDED.language, updated_at = now()
        `;
        return response.status(200).json({ message: "Widget settings saved (table auto-created)" });
      } catch (createErr) {
        console.error("[shop/widget-settings] Auto-recovery failed:", createErr.message);
        return response.status(500).json({ error: "Failed to save widget settings" });
      }
    }
    console.error("[shop/widget-settings] Save failed:", e.message);
    return response.status(500).json({ error: "Failed to save widget settings" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SANDBOX STATUS — powers the Developer Sandbox debug panel
// GET /api/shop?action=sandbox-status&visitor=web_xxx
// Returns the live conversation state, booking, technician & AI info for a
// website-visitor session. Uses the SAME engine + tables as production.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSandboxStatus(request, response, sql, shopId) {
  const visitor = String(request.query?.visitor || "");
  if (!visitor) return response.status(400).json({ error: "visitor query param required" });

  let state = null;
  try {
    const rows = await sql`SELECT * FROM conversation_state WHERE customer_number = ${visitor} AND repair_shop_id = ${shopId} LIMIT 1`;
    state = rows[0] || null;
  } catch (e) { /* table may not exist */ }

  let booking = null;
  let technician = null;
  if (state && state.booking_id) {
    try {
      const rows = await sql`
        SELECT b.*, t.name AS tech_name, t.phone AS tech_phone
        FROM bookings b LEFT JOIN technicians t ON t.id = b.technician_id
        WHERE b.id = ${parseInt(state.booking_id, 10)} AND b.repair_shop_id = ${shopId}
        LIMIT 1
      `;
      booking = rows[0] || null;
      technician = booking ? { name: booking.tech_name || booking.technician_name, phone: booking.tech_phone } : null;
    } catch (e) { /* ok */ }
  }

  let widget = null;
  try {
    const rows = await sql`SELECT * FROM widget_settings WHERE repair_shop_id = ${shopId} LIMIT 1`;
    widget = rows[0] || null;
  } catch (e) { /* ok */ }

  let aiSettings = null;
  try {
    const rows = await sql`SELECT business_hours, greeting_message, languages_spoken FROM ai_settings WHERE repair_shop_id = ${shopId} LIMIT 1`;
    aiSettings = rows[0] || null;
  } catch (e) { /* ok */ }

  return response.status(200).json({
    shopId,
    channel: "website",
    widgetId: shopId,
    widgetEnabled: !!(widget && widget.enabled),
    visitorId: visitor,
    aiStatus: state?.status || "NO_SESSION",
    language: state?.language || "en",
    bookingId: state?.booking_id || null,
    bookingStatus: booking?.status || null,
    technician,
    state: {
      status: state?.status || null,
      appliance: state?.appliance || null,
      issue: state?.issue || null,
      customer_name: state?.customer_name || null,
      area: state?.area || null,
      urgency: state?.urgency || null,
      human_handoff: !!state?.human_handoff,
      selected_slot: state?.selected_slot || null,
      image_urls: Array.isArray(state?.image_urls) ? state.image_urls : [],
      file_urls: Array.isArray(state?.file_urls) ? state.file_urls : [],
    },
    booking: booking ? {
      id: booking.id,
      status: booking.status,
      service_type: booking.service_type,
      customer_name: booking.customer_name,
      address: booking.address,
      created_at: booking.created_at,
    } : null,
    businessHours: aiSettings?.business_hours || null,
    greetingMessage: aiSettings?.greeting_message || "",
    promptVersion: PROMPT_VERSION,
    serverTime: new Date().toISOString(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SANDBOX TICKET — signed, short-lived token that lets the (authenticated)
// Developer Sandbox page run the real widget even while the widget is disabled.
// The public /api/chat only honors sandbox mode when this token verifies,
// so strangers cannot bypass a shop's disabled-widget gate.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSandboxTicket(request, response, sql, shopId) {
  if (!process.env.JWT_SECRET) {
    return response.status(500).json({ error: "JWT_SECRET not configured" });
  }
  const token = jwt.sign(
    { scope: "sandbox", shopId, channel: "website" },
    process.env.JWT_SECRET,
    { expiresIn: "30m" }
  );
  return response.status(200).json({ token, expiresIn: 1800 });
}


// ═══════════════════════════════════════════════════════════════════════════════
// GATEWAY MANAGEMENT (Super Admin only)
// ═══════════════════════════════════════════════════════════════════════════════

async function adminListGateways(request, response, sql, auth) {
  const admin = await requireSuperAdmin(auth, sql, response);
  if (!admin) return;
  const gateways = await getGatewayList();
  let rows = [];
  try {
    rows = await sql`SELECT * FROM payment_gateways ORDER BY priority ASC`;
    const keyMap = {};
    rows.forEach(r => { keyMap[r.provider] = r.key_id ? mask(decrypt(r.key_id)) : null; });
    gateways.forEach(gw => { gw.maskedKeyId = keyMap[gw.provider] || null; });
  } catch (e) { /* ok */ }
  return response.status(200).json({ gateways });
}

async function adminSaveGateway(request, response, sql, auth, body, actorType, actorId, ip) {
  const admin = await requireSuperAdmin(auth, sql, response);
  if (!admin) return;
  const { provider, keyId, keySecret, webhookSecret, isTestMode, isEnabled, extraConfig } = body;
  if (!provider) return response.status(400).json({ error: "provider is required" });
  const validProviders = ["razorpay", "stripe", "paypal", "phonepe", "cashfree"];
  if (!validProviders.includes(provider)) return response.status(400).json({ error: "Invalid provider" });
  const existing = await sql`SELECT id FROM payment_gateways WHERE provider = ${provider} LIMIT 1`;

  // Build parameterized SET clauses and their values separately from static SQL expressions.
  // Example: dynamicClauses = ["key_id = $1", "key_secret = $2"], params = [encKeyId, encKeySecret]
  // Static SQL: "updated_at = now()" goes into staticClauses (no param needed).
  const dynamicClauses = []; const params = [];
  if (keyId !== undefined && keyId !== null && keyId !== "") { params.push(encrypt(keyId)); dynamicClauses.push(`key_id = $${params.length}`); }
  if (keySecret !== undefined && keySecret !== null && keySecret !== "") { params.push(encrypt(keySecret)); dynamicClauses.push(`key_secret = $${params.length}`); }
  if (webhookSecret !== undefined && webhookSecret !== null && webhookSecret !== "") { params.push(encrypt(webhookSecret)); dynamicClauses.push(`webhook_secret = $${params.length}`); }
  if (isTestMode !== undefined) { params.push(!!isTestMode); dynamicClauses.push(`is_test_mode = $${params.length}`); }
  if (extraConfig !== undefined) { params.push(JSON.stringify(extraConfig)); dynamicClauses.push(`extra_config = $${params.length}::jsonb`); }
  if (isEnabled !== undefined) { params.push(!!isEnabled); dynamicClauses.push(`is_enabled = $${params.length}`); }

  // Build the rest (updated_by also needs a param; updated_at is a static SQL expression)
  const staticClauses = ["updated_at = now()"];
  params.push(actorId);
  dynamicClauses.push(`updated_by = $${params.length}`);

  // Combine both for UPDATE (static + dynamic parts all go to SET clause)
  const allSetClauses = [...staticClauses, ...dynamicClauses];

  if (existing.length > 0) {
    params.push(existing[0].id);
    await sql(`UPDATE payment_gateways SET ${allSetClauses.join(", ")} WHERE id = $${params.length}`, params);
  } else {
    const displayName = provider.charAt(0).toUpperCase() + provider.slice(1);
    // For INSERT we need explicit column names. Static columns get their value in SQL directly.
    // Dynamic parameterized columns get $N placeholders.
    const dynamicCols = dynamicClauses.map(c => c.split(" = ")[0]);
    const insertCols = ["provider", "display_name", ...staticClauses.map(c => c.split(" = ")[0]), ...dynamicCols];
    const insertParams = [provider, displayName];
    // Static values are SQL expressions (e.g. now()), not parameters — they go directly in the VALUES list
    const staticValues = staticClauses.map(c => c.split(" = ")[1]);
    const dynamicPlaceholders = dynamicCols.map((_, i) => `$${i + 1 + insertParams.length}`);
    const insertValues = ["$1", "$2", ...staticValues, ...dynamicPlaceholders];
    insertParams.push(...params);

    await sql(`INSERT INTO payment_gateways (${insertCols.join(", ")}) VALUES (${insertValues.join(", ")})`, insertParams);
  }
  invalidateCache();
  await logAdminAction(sql, { actorType, actorId, action: "save-gateway", targetType: "gateway", details: { provider }, ip });
  return response.status(200).json({ message: `${provider} gateway saved` });
}

async function adminToggleGateway(request, response, sql, auth, body, actorType, actorId, ip) {
  const admin = await requireSuperAdmin(auth, sql, response);
  if (!admin) return;
  const { provider, isEnabled } = body;
  if (!provider) return response.status(400).json({ error: "provider is required" });
  await sql`UPDATE payment_gateways SET is_enabled = ${!!isEnabled}, updated_at = now(), updated_by = ${actorId} WHERE provider = ${provider}`;
  invalidateCache();
  await logAdminAction(sql, { actorType, actorId, action: isEnabled ? "enable-gateway" : "disable-gateway", targetType: "gateway", details: { provider }, ip });
  return response.status(200).json({ message: `${provider} ${isEnabled ? "enabled" : "disabled"}` });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION / INVOICE / LOG ADMIN VIEWS
// ═══════════════════════════════════════════════════════════════════════════════

async function adminListSubscriptions(request, response, sql, auth) {
  const page = parseInt(request.query?.page || "1", 10);
  const limit = parseInt(request.query?.limit || "20", 10);
  const status = request.query?.status || "";
  const offset = (page - 1) * limit;
  let whereClause = "WHERE 1=1"; const qp = [];
  if (status) { qp.push(status); whereClause += ` AND s.status = $${qp.length}`; }
  try {
    const subs = await sql(`SELECT s.id, s.repair_shop_id, s.status, s.billing_cycle, s.gateway, s.current_period_start, s.current_period_end, s.amount_paid, s.currency, s.created_at, sp.name as plan_name, sp.display_name, rs.shop_name, rs.owner_name, rs.email FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id JOIN repair_shops rs ON rs.id = s.repair_shop_id ${whereClause} ORDER BY s.created_at DESC LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}`, [...qp, limit, offset]);
    const cnt = await sql(`SELECT COUNT(*) as total FROM subscriptions s ${whereClause}`, qp);
    return response.status(200).json({ subscriptions: subs, pagination: { page, limit, total: parseInt(cnt[0]?.total || "0", 10) } });
  } catch (e) { return response.status(200).json({ subscriptions: [], pagination: { page, limit, total: 0 } }); }
}

async function adminListInvoices(request, response, sql, auth) {
  const page = parseInt(request.query?.page || "1", 10);
  const limit = parseInt(request.query?.limit || "20", 10);
  const status = request.query?.status || "";
  const offset = (page - 1) * limit;
  let whereClause = "WHERE 1=1"; const qp = [];
  if (status) { qp.push(status); whereClause += ` AND i.status = $${qp.length}`; }
  try {
    const invoices = await sql(`SELECT i.id, i.invoice_number, i.plan_name, i.billing_cycle, i.currency, i.subtotal, i.tax_rate, i.tax_amount, i.total, i.status, i.business_name, i.issued_at, i.paid_at, i.created_at, rs.shop_name, rs.owner_name FROM invoices i JOIN repair_shops rs ON rs.id = i.repair_shop_id ${whereClause} ORDER BY i.created_at DESC LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}`, [...qp, limit, offset]);
    const cnt = await sql(`SELECT COUNT(*) as total FROM invoices i ${whereClause}`, qp);
    return response.status(200).json({ invoices, pagination: { page, limit, total: parseInt(cnt[0]?.total || "0", 10) } });
  } catch (e) { return response.status(200).json({ invoices: [], pagination: { page, limit, total: 0 } }); }
}

async function adminListPaymentLogs(request, response, sql, auth) {
  const page = parseInt(request.query?.page || "1", 10);
  const limit = parseInt(request.query?.limit || "30", 10);
  const gateway = request.query?.gateway || "";
  const eventType = request.query?.event_type || "";
  const severity = request.query?.severity || "";
  const offset = (page - 1) * limit;
  let whereClause = "WHERE 1=1"; const qp = [];
  if (gateway) { qp.push(gateway); whereClause += ` AND pl.gateway = $${qp.length}`; }
  if (eventType) { qp.push(eventType); whereClause += ` AND pl.event_type = $${qp.length}`; }
  if (severity) { qp.push(severity); whereClause += ` AND pl.severity = $${qp.length}`; }
  try {
    const logs = await sql(`SELECT pl.id, pl.payment_id, pl.repair_shop_id, pl.gateway, pl.event_type, pl.severity, pl.message, pl.error_message, pl.created_at, rs.shop_name FROM payment_logs pl LEFT JOIN repair_shops rs ON rs.id = pl.repair_shop_id ${whereClause} ORDER BY pl.created_at DESC LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}`, [...qp, limit, offset]);
    const cnt = await sql(`SELECT COUNT(*) as total FROM payment_logs pl ${whereClause}`, qp);
    return response.status(200).json({ logs, pagination: { page, limit, total: parseInt(cnt[0]?.total || "0", 10) } });
  } catch (e) { return response.status(200).json({ logs: [], pagination: { page, limit, total: 0 } }); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSATION TRANSCRIPT — full chat history for a customer
// ═══════════════════════════════════════════════════════════════════════════════
async function handleConversationTranscript(request, response, sql, shopId) {
  const customerNumber = request.query?.customer;
  if (!customerNumber) return response.status(400).json({ error: "customer query param required" });

  try {
    const messages = await sql`
      SELECT id, role, message, channel, created_at
      FROM conversations
      WHERE customer_number = ${customerNumber}
      ORDER BY created_at ASC LIMIT 100
    `;

    const state = await sql`
      SELECT * FROM conversation_state WHERE customer_number = ${customerNumber} LIMIT 1
    `;

    const booking = await sql`
      SELECT id, image_urls, file_urls, conversation_summary, customer_sentiment, human_takeover_history
      FROM bookings WHERE customer_number = ${customerNumber} AND repair_shop_id = ${shopId}
      ORDER BY created_at DESC LIMIT 1
    `;

    return response.status(200).json({
      messages,
      state: state[0] || null,
      booking: booking[0] || null,
    });
  } catch (e) {
    console.error("[shop/conversation-transcript] Error:", e.message);
    return response.status(500).json({ error: "Failed to fetch conversation" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSATION ANALYTICS — bot performance metrics
// ═══════════════════════════════════════════════════════════════════════════════
async function handleConversationAnalytics(request, response, sql, shopId) {
  try {
    const daily = await sql`
      SELECT * FROM conversation_analytics
      WHERE repair_shop_id = ${shopId}
      ORDER BY date DESC LIMIT 30
    `;

    // Aggregate stats
    let totalConversations = 0;
    let totalBookings = 0;
    let totalHandoffs = 0;
    const applianceCounts = {};
    const issueCounts = {};
    let totalResponseTime = 0;
    let responseTimeCount = 0;

    daily.forEach(r => {
      totalConversations += parseInt(r.total_conversations || 0, 10);
      totalBookings += parseInt(r.booking_completed || 0, 10);
      totalHandoffs += parseInt(r.human_handoff || 0, 10);
      if (r.avg_response_time_ms) {
        totalResponseTime += parseInt(r.avg_response_time_ms, 10);
        responseTimeCount++;
      }
    });

    // Get most common appliances and issues from bookings
    const bookings = await sql`
      SELECT service_type FROM bookings
      WHERE repair_shop_id = ${shopId}
      ORDER BY created_at DESC LIMIT 100
    `;
    bookings.forEach(b => {
      const parts = (b.service_type || '').split(' — ');
      const appliance = parts[0] || 'Unknown';
      const issue = parts[1] || 'General';
      applianceCounts[appliance] = (applianceCounts[appliance] || 0) + 1;
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    });

    // Drop-off: find which conversation_state statuses are most common (pre-booking)
    const dropOffs = await sql`
      SELECT status, COUNT(*) as count FROM conversation_state
      WHERE repair_shop_id = ${shopId}
        AND status NOT IN ('BOOKED', 'CANCELLED', 'HUMAN_HANDOFF')
      GROUP BY status ORDER BY count DESC LIMIT 1
    `;

    const completionRate = totalConversations > 0 ? Math.round((totalBookings / totalConversations) * 100) : 0;
    const handoffRate = totalConversations > 0 ? Math.round((totalHandoffs / totalConversations) * 100) : 0;

    return response.status(200).json({
      daily,
      summary: {
        totalConversations,
        totalBookings,
        totalHandoffs,
        completionRate,
        handoffRate,
        avgResponseTimeMs: responseTimeCount > 0 ? Math.round(totalResponseTime / responseTimeCount) : 0,
        mostCommonAppliance: Object.entries(applianceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
        mostCommonIssue: Object.entries(issueCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
        dropOffStage: dropOffs[0]?.status || null,
        bookingCompletionPercent: completionRate,
        humanHandoffPercent: handoffRate,
      },
    });
  } catch (e) {
    console.error("[shop/conversation-analytics] Error:", e.message);
    return response.status(200).json({ daily: [], summary: {
      totalConversations: 0, totalBookings: 0, totalHandoffs: 0,
      completionRate: 0, handoffRate: 0, avgResponseTimeMs: 0,
      mostCommonAppliance: null, mostCommonIssue: null, dropOffStage: null,
      bookingCompletionPercent: 0, humanHandoffPercent: 0,
    }});
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOSE HUMAN HANDOFF — shop marks human interaction as complete
// ═══════════════════════════════════════════════════════════════════════════════
async function handleCloseHumanHandoff(request, response, sql, shopId, body) {
  const { customerNumber } = body;
  if (!customerNumber) return response.status(400).json({ error: "customerNumber required" });

  try {
    await sql`
      UPDATE conversation_state SET
        human_handoff = false,
        handoff_closed_at = now(),
        updated_at = now()
      WHERE customer_number = ${customerNumber} AND repair_shop_id = ${shopId}
    `;

    // Record the takeover event in booking
    const bookingRows = await sql`
      SELECT id, human_takeover_history FROM bookings
      WHERE customer_number = ${customerNumber} AND repair_shop_id = ${shopId}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (bookingRows.length > 0) {
      const existing = bookingRows[0].human_takeover_history || [];
      const history = Array.isArray(existing) ? existing : [];
      history.push({
        type: 'handoff_closed',
        by: 'shop',
        shopId: shopId,
        timestamp: new Date().toISOString(),
      });
      await sql`
        UPDATE bookings SET human_takeover_history = ${JSON.stringify(history)}::jsonb
        WHERE id = ${bookingRows[0].id}
      `;
    }

    return response.status(200).json({ message: "Human handoff closed", handoffClosed: true });
  } catch (e) {
    console.error("[shop/close-human-handoff] Error:", e.message);
    return response.status(500).json({ error: "Failed to close handoff" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAVE EXTENDED AI SETTINGS — shop knowledge base config
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSaveAiSettingsExtended(request, response, sql, shopId, body) {
  const { serviceLocations, brandsRepaired, warrantyPolicy, inspectionPolicy,
    visitingCharges, emergencyAvailability, holidayTimings,
    acceptedPaymentMethods, languagesSpoken } = body;

  try {
    await sql`
      UPDATE ai_settings SET
        service_locations = COALESCE(${serviceLocations || []}, service_locations),
        brands_repaired = COALESCE(${brandsRepaired || []}, brands_repaired),
        warranty_policy = COALESCE(${warrantyPolicy || ''}, warranty_policy),
        inspection_policy = COALESCE(${inspectionPolicy || ''}, inspection_policy),
        visiting_charges = COALESCE(${visitingCharges != null ? visitingCharges : null}::numeric, visiting_charges),
        emergency_availability = COALESCE(${!!emergencyAvailability}, emergency_availability),
        holiday_timings = COALESCE(${JSON.stringify(holidayTimings || {})}::jsonb, holiday_timings),
        accepted_payment_methods = COALESCE(${acceptedPaymentMethods || []}, accepted_payment_methods),
        languages_spoken = COALESCE(${languagesSpoken || []}, languages_spoken),
        updated_at = now()
      WHERE repair_shop_id = ${shopId}
    `;
    return response.status(200).json({ message: "Extended AI settings saved" });
  } catch (e) {
    console.error("[shop/save-ai-settings-extended] Error:", e.message);
    return response.status(500).json({ error: "Failed to save extended AI settings" });
  }
}

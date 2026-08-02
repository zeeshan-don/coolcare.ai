// api/technician.js
// Technician Dashboard API — Repair Lifecycle Management for field technicians.
// The technician-facing front-end of the SAME lifecycle the owner dashboard and
// the Conversation Engine use. No duplicated booking logic:
//   • status changes        → applyBookingStatusChange() in _lib/repair-lifecycle.js
//   • timeline              → booking_timeline table (via _lib/repair-lifecycle.js)
//   • customer notifications → notifyStatusChange() (meaningful milestones only)
//
// Endpoints:
//   GET  /api/technician?action=jobs              → active jobs (shop-wide or the
//                                                   linked technician's when users.technician_id is set)
//   GET  /api/technician?action=booking&id=N      → single booking + full timeline
//   GET  /api/technician?action=stats             → lifecycle counts + avg metrics
//   POST /api/technician { action:"update", bookingId, status, notes? }
//                                                 → move the repair forward
//
// Security: any authenticated account of the shop (owner, manager, editor,
// receptionist, technician) may use it; every query is scoped to the caller's
// repair_shop_id (multi-tenant). Demo shops are read-only.

const { neon } = require("@neondatabase/serverless");
const { requireAuth, requireRole, isDemoShop } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { validate, bookingStatus, z } = require("./_lib/validate");
const {
  ACTORS,
  ACTIVE_STATUSES,
  loadRepairTimeline,
  applyBookingStatusChange,
  listActiveJobs,
  computeRepairStats,
} = require("./_lib/repair-lifecycle");

// Roles allowed to run the technician dashboard (shop staff + technicians).
const TECH_ROLES = ["owner", "shop", "manager", "editor", "receptionist", "technician"];

const technicianUpdateSchema = z.object({
  bookingId: z.coerce.number().int().positive("bookingId is required"),
  status: bookingStatus,
  notes: z.string().max(2000).trim().optional().nullable(),
});

// ─── Resolve the caller's shop id ────────────────────────────────────────────
// Preference order: the DB row from requireRole (authoritative) → JWT claim
// (user accounts carry repair_shop_id) → the account id itself (shop owners,
// where sub IS the shop id).
function resolveShopId(auth, staff) {
  if (staff?.repair_shop_id) return parseInt(staff.repair_shop_id, 10);
  if (auth.repair_shop_id) return parseInt(auth.repair_shop_id, 10);
  return parseInt(auth.sub, 10);
}

// ─── Resolve the caller's linked technician record (optional) ───────────────
async function resolveTechnicianId(sql, auth) {
  if (auth.user_type !== "user") return null;
  try {
    const rows = await sql`SELECT technician_id FROM users WHERE id = ${parseInt(auth.sub, 10)} LIMIT 1`;
    return rows[0]?.technician_id || null;
  } catch (e) {
    return null;
  }
}

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const sql = neon(process.env.DATABASE_URL);
  const staff = await requireRole(auth, sql, response, TECH_ROLES);
  if (!staff) return;

  const shopId = resolveShopId(auth, staff);
  const techId = await resolveTechnicianId(sql, auth);

  // ── DEMO MODE GUARD: read-only for demo shops ───────────────────────────
  const isDemo = auth.isDemo || (await isDemoShop(sql, shopId));
  if (request.method === "POST" && isDemo) {
    return response.status(403).json({ error: "This is a demo account. Changes are not saved.", isDemo: true, demoError: true });
  }

  if (request.method === "GET") {
    const action = request.query?.action || "jobs";

    if (action === "jobs") {
      const jobs = await listActiveJobs(sql, shopId, techId || null);
      return response.status(200).json({ jobs, techId });
    }

    if (action === "booking") {
      const bookingId = parseInt(request.query?.id, 10);
      if (!bookingId || isNaN(bookingId)) return response.status(400).json({ error: "Invalid booking ID" });
      const rows = await sql`
        SELECT b.*, t.name AS assigned_technician_name, t.phone AS assigned_technician_phone
        FROM bookings b LEFT JOIN technicians t ON t.id = b.technician_id
        WHERE b.id = ${bookingId} AND b.repair_shop_id = ${shopId} LIMIT 1
      `;
      if (rows.length === 0) return response.status(404).json({ error: "Booking not found or access denied" });
      const timeline = await loadRepairTimeline(sql, bookingId);
      return response.status(200).json({ booking: rows[0], timeline });
    }

    if (action === "stats") {
      const counts = await sql`SELECT status, COUNT(*) as count FROM bookings WHERE repair_shop_id = ${shopId} GROUP BY status`;
      const statusCounts = { open: 0, accepted: 0, rejected: 0, assigned: 0, on_the_way: 0, arrived: 0, in_progress: 0, waiting_parts: 0, completed: 0, cancelled: 0, payment_received: 0 };
      counts.forEach((r) => { if (statusCounts[r.status] !== undefined) statusCounts[r.status] = parseInt(r.count, 10); });
      const activeCount = ACTIVE_STATUSES.reduce((sum, s) => sum + (statusCounts[s] || 0), 0);
      let assignedToMe = null;
      if (techId) {
        const mine = await sql`SELECT COUNT(*) as c FROM bookings WHERE repair_shop_id = ${shopId} AND technician_id = ${techId} AND status = ANY(${ACTIVE_STATUSES}::text[])`;
        assignedToMe = parseInt(mine[0]?.c || 0, 10);
      }
      const repairStats = await computeRepairStats(sql, shopId);
      return response.status(200).json({
        statusCounts,
        activeCount,
        assignedToMe, // null when the account isn't linked to a roster record → UI shows "All"
        techId,
        avgCompletionHours: repairStats.avgCompletionHours,
        avgTechResponseMinutes: repairStats.avgTechResponseMinutes,
      });
    }

    return response.status(400).json({ error: "Unknown GET action" });
  }

  if (request.method === "POST") {
    if (!allowMethods(request, response, "POST")) return;
    const body = request.body || {};
    if (body.action !== "update") return response.status(400).json({ error: "Unknown POST action" });

    // Status changes gate on an active subscription (same rule as the owner
    // dashboard). Technician accounts are USERS — their JWT sub is the user id,
    // not the shop id — so the shared requireActiveSubscription() (which uses
    // auth.sub as the shop id) would wrongly 403 them. Check the shop directly
    // using the resolved shopId.
    const shopRow = await sql`SELECT subscription_status, approval_status, suspended_at FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    if (shopRow.length === 0) return response.status(403).json({ error: "Account not found." });
    if (shopRow[0].suspended_at) return response.status(403).json({ error: "This account has been suspended.", errorType: "suspended" });
    const subStatus = shopRow[0].subscription_status || "inactive";
    const approvalStatus = shopRow[0].approval_status || "none";
    if (subStatus !== "active" || (approvalStatus !== "approved" && approvalStatus !== "none")) {
      return response.status(403).json({ error: "An active subscription is required to update jobs.", errorType: "subscription_required" });
    }

    const data = validate({ ...request, body }, response, technicianUpdateSchema);
    if (!data) return;

    const rows = await sql`SELECT * FROM bookings WHERE id = ${data.bookingId} AND repair_shop_id = ${shopId} LIMIT 1`;
    if (rows.length === 0) return response.status(404).json({ error: "Booking not found or access denied" });

    const actorType = staff.role === "technician" ? ACTORS.TECHNICIAN : ACTORS.SHOP;
    const result = await applyBookingStatusChange(sql, {
      bookingId: data.bookingId,
      newStatus: data.status,
      actorType,
      actorId: parseInt(auth.sub, 10),
      notes: data.notes || undefined,
    });
    if (!result.ok) return response.status(400).json({ error: result.error });

    console.log(`[technician] booking #${data.bookingId} → ${data.status} by ${staff.role} #${auth.sub} (shop #${shopId})`);
    return response.status(200).json({ updated: true, booking: result.booking, timeline: result.timeline, changed: result.changed });
  }

  return response.status(405).json({ error: "Method not allowed" });
});

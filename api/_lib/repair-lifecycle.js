// api/_lib/repair-lifecycle.js
// ─────────────────────────────────────────────────────────────────────────────
// THE single Repair Lifecycle Management core.
//
// ONE shared module used by every surface of the product so the lifecycle is
// NEVER duplicated:
//   • Owner dashboard       → api/shop.js (status changes, timeline, analytics)
//   • Technician dashboard  → api/technician.js (status buttons, timeline)
//   • Conversation Engine   → api/_lib/conversation-engine.js (status answers)
//   • Notifications         → api/_lib/notify.js (status templates)
//
// The lifecycle EXTENDS the existing booking model — no duplicate tables.
// The repair timeline lives in the existing booking_timeline table.
//
// Lifecycle:
//   open → accepted → assigned → on_the_way → arrived → in_progress
//        → waiting_parts ⇄ in_progress → completed → payment_received
//   open → cancelled | accepted → cancelled | ... → cancelled (any active state)
//
// Every status change records a timeline event:
//   { booking_id, action:'status_change', old_value, new_value, actor_type,
//     actor_id, notes, created_at }
//
// IMPORTANT: The web UI is emoji-free and professional — labels below are
// plain text; status badges render as colored pills, never icons.
// ─────────────────────────────────────────────────────────────────────────────

const { notifyStatusChange } = require("./notify");

// ─── Canonical lifecycle statuses ────────────────────────────────────────────
const REPAIR_STATUSES = [
  "open",           // Pending
  "accepted",       // Accepted
  "rejected",       // Rejected (terminal)
  "assigned",       // Assigned
  "on_the_way",     // Technician On The Way
  "arrived",        // Technician Arrived
  "in_progress",    // Repair In Progress
  "waiting_parts",  // Waiting For Parts
  "completed",      // Completed (terminal)
  "cancelled",      // Cancelled (terminal)
  "payment_received", // Payment Received (terminal — optional)
];

// Human-readable labels (website + API surfaces — no emojis).
const STATUS_LABELS = {
  open: "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
  assigned: "Assigned",
  on_the_way: "Technician On The Way",
  arrived: "Technician Arrived",
  in_progress: "Repair In Progress",
  waiting_parts: "Waiting For Parts",
  completed: "Completed",
  cancelled: "Cancelled",
  payment_received: "Payment Received",
};

// Terminal states — no further lifecycle actions are offered.
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "rejected", "payment_received"]);

// Active states — jobs that are still being worked on.
const ACTIVE_STATUSES = ["open", "accepted", "assigned", "on_the_way", "arrived", "in_progress", "waiting_parts"];

// Statuses that trigger a CUSTOMER notification when reached. Everything else
// (accepted, rejected, in_progress, waiting_parts) stays silent so we never
// spam the customer — meaningful milestones only.
const NOTIFY_CUSTOMER_STATUSES = new Set([
  "assigned", "on_the_way", "arrived", "completed", "cancelled", "payment_received",
]);

// Actor types stored on timeline events (matches booking_timeline CHECK).
const ACTORS = {
  SYSTEM: "system",
  SHOP: "shop",
  CUSTOMER: "customer",
  TECHNICIAN: "technician",
  USER: "user",
};

/**
 * Title-case a status value into its display label ("in_progress" → "Repair In Progress").
 * Falls back to a clean title-cased form of the raw value.
 */
function statusLabel(status) {
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  return String(status || "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Insert one repair-timeline event into booking_timeline (guarded).
 * @param {Function} sql neon query fn
 * @param {object} e
 * @param {number} e.bookingId
 * @param {string} e.action       e.g. 'status_change' | 'booking_created' | 'technician_assigned'
 * @param {string|null} [e.oldValue]
 * @param {string|null} [e.newValue]
 * @param {string} [e.actorType]  'system' | 'shop' | 'customer' | 'technician' | 'user'
 * @param {number|null} [e.actorId]
 * @param {string|null} [e.notes]
 */
async function insertTimelineEvent(sql, { bookingId, action, oldValue = null, newValue = null, actorType = ACTORS.SYSTEM, actorId = null, notes = null }) {
  if (!bookingId) return null;
  try {
    const rows = await sql`
      INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, actor_id, notes)
      VALUES (${bookingId}, ${action}, ${oldValue}, ${newValue}, ${actorType}, ${actorId}, ${notes})
      RETURNING id, booking_id, action, old_value, new_value, actor_type, actor_id, notes, created_at
    `;
    return rows[0] || null;
  } catch (e) {
    console.warn("[repair-lifecycle] timeline insert failed:", e.message);
    return null;
  }
}

/**
 * Resolve readable actor names for timeline rows.
 * Returns a map: actorKey ("technician:12" | "shop:3" | "system" | "customer") → display name.
 */
async function resolveActorNames(sql, entries) {
  const names = { system: "System", customer: "Customer", shop: "Shop" };
  const userIds = new Set();
  const shopIds = new Set();
  const techIds = new Set();

  for (const e of entries || []) {
    if (!e.actor_id) continue;
    const t = e.actor_type;
    if (t === ACTORS.TECHNICIAN || t === ACTORS.USER) userIds.add(parseInt(e.actor_id, 10));
    else if (t === ACTORS.SHOP) shopIds.add(parseInt(e.actor_id, 10));
  }

  try {
    if (userIds.size > 0) {
      const rows = await sql`SELECT id, name FROM users WHERE id = ANY(${[...userIds]}::int[])`;
      rows.forEach((r) => { names[`user:${r.id}`] = r.name; });
    }
  } catch (e) { /* users table may not exist */ }

  try {
    if (shopIds.size > 0) {
      const rows = await sql`SELECT id, shop_name, owner_name FROM repair_shops WHERE id = ANY(${[...shopIds]}::int[])`;
      rows.forEach((r) => { names[`shop:${r.id}`] = r.shop_name || r.owner_name || "Shop"; });
    }
  } catch (e) { /* ok */ }

  return (e) => {
    if (!e.actor_type) return "";
    const key = e.actor_type === ACTORS.USER || e.actor_type === ACTORS.TECHNICIAN
      ? `user:${e.actor_id || 0}`
      : e.actor_type === ACTORS.SHOP
        ? `shop:${e.actor_id || 0}`
        : e.actor_type;
    return names[key] || statusLabel(e.actor_type);
  };
}

/**
 * Load the full repair timeline for a booking, oldest → newest, with
 * readable "performed by" names attached.
 * @returns {Promise<Array>} timeline entries
 */
async function loadRepairTimeline(sql, bookingId) {
  try {
    const rows = await sql`
      SELECT * FROM booking_timeline WHERE booking_id = ${bookingId} ORDER BY created_at ASC, id ASC
    `;
    const nameFor = await resolveActorNames(sql, rows);
    return rows.map((r) => ({
      ...r,
      performed_by: nameFor(r),
      status_from: r.old_value,
      status_to: r.new_value,
    }));
  } catch (e) {
    console.warn("[repair-lifecycle] timeline load failed:", e.message);
    return [];
  }
}

/**
 * Apply a repair status change — THE single place statuses move.
 *  1. Loads the booking (scoped to the shop by the caller beforehand).
 *  2. Updates bookings.status + updated_at.
 *  3. Records a 'status_change' timeline event with actor + optional notes.
 *  4. (optionally) fires the customer notification (fire-and-forget) for
 *     meaningful milestones only.
 * Returns { booking, timeline } — the updated booking row + fresh timeline.
 */
async function applyBookingStatusChange(sql, { bookingId, newStatus, actorType = ACTORS.SHOP, actorId = null, notes = null, notify = true, actorName = null }) {
  const rows = await sql`SELECT * FROM bookings WHERE id = ${bookingId} LIMIT 1`;
  if (rows.length === 0) return { ok: false, error: "Booking not found" };
  const booking = rows[0];
  const oldStatus = booking.status;
  if (oldStatus === newStatus) {
    return { ok: true, changed: false, booking, timeline: await loadRepairTimeline(sql, bookingId) };
  }

  await sql`UPDATE bookings SET status = ${newStatus}, updated_at = now() WHERE id = ${bookingId}`;

  const notesWithActor = notes || (actorName ? `Status updated by ${actorName}` : null);
  await insertTimelineEvent(sql, {
    bookingId,
    action: "status_change",
    oldValue: oldStatus,
    newValue: newStatus,
    actorType,
    actorId,
    notes: notesWithActor,
  });

  const updated = (await sql`SELECT * FROM bookings WHERE id = ${bookingId} LIMIT 1`)[0] || booking;

  // Meaningful milestones only — never spam intermediate states.
  if (notify && NOTIFY_CUSTOMER_STATUSES.has(newStatus)) {
    let shopName = booking.shop_name;
    if (!shopName && updated.repair_shop_id) {
      try {
        const shops = await sql`SELECT shop_name FROM repair_shops WHERE id = ${updated.repair_shop_id} LIMIT 1`;
        shopName = shops[0]?.shop_name || null;
      } catch (e) { /* ok */ }
    }
    notifyStatusChange({ ...updated, shop_name: shopName }, newStatus)
      .catch((err) => console.warn("[repair-lifecycle] notify failed:", err.message));
  }

  const timeline = await loadRepairTimeline(sql, bookingId);
  return { ok: true, changed: true, booking: updated, timeline, oldStatus };
}

/**
 * Repair analytics for the owner dashboard + morning digest.
 * Returns:
 *   { avgCompletionHours, avgTechResponseMinutes }
 * Both are derived from the TIMELINE (booking created_at → assigned /
 * completed event) with a bookings-table fallback when timeline data is
 * missing. Defensive — never throws.
 */
async function computeRepairStats(sql, shopId) {
  const stats = { avgCompletionHours: null, avgTechResponseMinutes: null };

  // ── Average completion time (hours): created_at → 'completed' timeline event
  try {
    const rows = await sql`
      SELECT AVG(EXTRACT(EPOCH FROM (bt.created_at - b.created_at)) / 3600.0) AS avg_hours
      FROM booking_timeline bt
      JOIN bookings b ON b.id = bt.booking_id
      WHERE b.repair_shop_id = ${shopId}
        AND b.status = 'completed'
        AND bt.new_value = 'completed'
        AND bt.created_at >= b.created_at
    `;
    const avg = rows[0]?.avg_hours;
    if (avg != null) stats.avgCompletionHours = Math.round(parseFloat(avg) * 10) / 10;
  } catch (e) { /* ok */ }

  // Fallback: completed bookings without timeline data → updated_at - created_at
  if (stats.avgCompletionHours == null) {
    try {
      const rows = await sql`
        SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600.0) AS avg_hours
        FROM bookings
        WHERE repair_shop_id = ${shopId} AND status = 'completed'
      `;
      const avg = rows[0]?.avg_hours;
      if (avg != null) stats.avgCompletionHours = Math.round(parseFloat(avg) * 10) / 10;
    } catch (e) { /* ok */ }
  }

  // ── Average technician response time (minutes): created_at → first 'assigned'
  try {
    const rows = await sql`
      SELECT AVG(EXTRACT(EPOCH FROM (bt.created_at - b.created_at)) / 60.0) AS avg_min
      FROM (
        SELECT DISTINCT ON (booking_id) booking_id, created_at
        FROM booking_timeline
        WHERE new_value = 'assigned' OR action = 'technician_assigned'
        ORDER BY booking_id, created_at ASC
      ) bt
      JOIN bookings b ON b.id = bt.booking_id
      WHERE b.repair_shop_id = ${shopId}
        AND bt.created_at >= b.created_at
    `;
    const avg = rows[0]?.avg_min;
    if (avg != null) stats.avgTechResponseMinutes = Math.round(parseFloat(avg) * 10) / 10;
  } catch (e) { /* ok */ }

  return stats;
}

/**
 * Active job list for a shop (or a single technician when linked).
 * Reused by the technician dashboard — owner dashboard uses its own paged
 * query for the full list.
 */
async function listActiveJobs(sql, shopId, technicianId = null) {
  const techFilter = technicianId ? sql`AND (b.technician_id = ${technicianId} OR b.technician_id IS NULL)` : sql``;
  const rows = await sql`
    SELECT b.id, b.customer_number, b.customer_name, b.customer_phone, b.service_type,
           b.area, b.address, b.urgency, b.status, b.technician_id, b.technician_name,
           b.estimated_cost, b.final_cost, b.priority, b.created_at, b.updated_at,
           t.name AS assigned_technician_name, t.phone AS assigned_technician_phone
    FROM bookings b
    LEFT JOIN technicians t ON t.id = b.technician_id
    WHERE b.repair_shop_id = ${shopId}
      AND b.status = ANY(${ACTIVE_STATUSES}::text[])
      ${techFilter}
    ORDER BY
      CASE b.status
        WHEN 'arrived' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'waiting_parts' THEN 3
        WHEN 'on_the_way' THEN 4 WHEN 'assigned' THEN 5 WHEN 'open' THEN 6
        ELSE 7 END,
      b.created_at ASC
  `;
  const jobs = rows.map((r) => ({ ...r, status_label: statusLabel(r.status), timeline: [] }));

  // Attach a compact timeline (last 3 events, oldest → newest) for quick context.
  try {
    const events = await sql`
      SELECT bt.booking_id, bt.action, bt.old_value, bt.new_value, bt.actor_type, bt.actor_id, bt.notes, bt.created_at
      FROM booking_timeline bt
      JOIN bookings b ON b.id = bt.booking_id
      WHERE b.repair_shop_id = ${shopId}
        AND b.status = ANY(${ACTIVE_STATUSES}::text[])
      ORDER BY bt.created_at DESC LIMIT 400
    `;
    const nameFor = await resolveActorNames(sql, events);
    const byBooking = new Map();
    for (const e of events) {
      if (!byBooking.has(e.booking_id)) byBooking.set(e.booking_id, []);
      const arr = byBooking.get(e.booking_id);
      if (arr.length < 3) arr.push({ ...e, performed_by: nameFor(e) });
    }
    for (const j of jobs) {
      const evs = byBooking.get(j.id) || [];
      j.timeline = evs.slice().reverse(); // oldest → newest
    }
  } catch (e) { /* timeline is non-fatal */ }

  return jobs;
}

module.exports = {
  REPAIR_STATUSES,
  STATUS_LABELS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  NOTIFY_CUSTOMER_STATUSES,
  ACTORS,
  statusLabel,
  insertTimelineEvent,
  loadRepairTimeline,
  resolveActorNames,
  applyBookingStatusChange,
  computeRepairStats,
  listActiveJobs,
};

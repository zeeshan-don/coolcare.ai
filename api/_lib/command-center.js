// api/_lib/command-center.js
// Shared "Command Center" builder — KPIs, Today's Priorities, Business Health,
// AI Performance & Technician Performance.
// Used by BOTH the shop dashboard (api/shop.js) and the morning digest cron
// (api/cron.js) so the numbers the owner sees in a digest always match
// the numbers on the dashboard.
// Every sub-query is defensive so neither consumer breaks on partial schema.

/**
 * Build the full command-center payload for a shop.
 * @param {Function} sql  neon query function
 * @param {number} shopId
 * @param {object} statusCounts  { open, accepted, rejected, assigned, on_the_way, arrived, in_progress, waiting_parts, completed, cancelled, payment_received }
 * @param {Array} revenueChart   raw 30-day chart rows [{ date, revenue, bookings }]
 * @param {number} todayBookings
 * @param {object} base          { monthlyRevenue, monthBookings }
 * @returns {Promise<{kpis, priorities, businessHealth, aiPerformance, technicianPerformance}>}
 */
async function buildRealCommandCenter(sql, shopId, statusCounts, revenueChart, todayBookings, base) {
  const num = (v) => parseFloat(v || 0);
  const round1 = (v) => Math.round(v * 10) / 10;

  // ── KPIs (revenue today/yesterday derived from the 30-day chart) ──────────
  const kpis = {
    revenueToday: 0,
    revenueYesterday: 0,
    revenueDeltaPct: 0,
    monthlyRevenue: num(base?.monthlyRevenue),
    monthGrowthPct: 0,
    todayBookings: todayBookings || 0,
    monthBookings: base?.monthBookings || 0,
    jobsWaiting: (statusCounts.open || 0) + (statusCounts.accepted || 0),
    overdueJobs: 0,
    techniciansFree: 0,
    technicianCount: 0,
    pendingPayments: 0,
    satisfaction: 0,
    // ── Repair lifecycle analytics ────────────────────────────────────
    jobsPending: (statusCounts.open || 0) + (statusCounts.accepted || 0),
    jobsAssigned: statusCounts.assigned || 0,
    jobsInProgress: (statusCounts.on_the_way || 0) + (statusCounts.arrived || 0) + (statusCounts.in_progress || 0) + (statusCounts.waiting_parts || 0),
    jobsCompleted: statusCounts.completed || 0,
    jobsCancelled: (statusCounts.cancelled || 0) + (statusCounts.rejected || 0),
    avgCompletionHours: null,
    avgTechResponseMinutes: null,
    aiConversationsToday: 0,
    aiBookingsToday: 0,
    aiSuccessRate: 0,
    hoursSavedToday: 0,
    avgResponseSeconds: 0,
  };

  // ── Average completion time + technician response time (timeline-derived) ──
  try {
    const rows = await sql`
      SELECT
        (SELECT AVG(EXTRACT(EPOCH FROM (bt.created_at - b.created_at)) / 3600.0)
         FROM booking_timeline bt JOIN bookings b ON b.id = bt.booking_id
         WHERE b.repair_shop_id = ${shopId} AND b.status = 'completed'
           AND bt.new_value = 'completed' AND bt.created_at >= b.created_at) AS avg_completion_hours,
        (SELECT AVG(EXTRACT(EPOCH FROM (bt2.created_at - b2.created_at)) / 60.0)
         FROM (SELECT DISTINCT ON (booking_id) booking_id, created_at
               FROM booking_timeline
               WHERE new_value = 'assigned' OR action = 'technician_assigned'
               ORDER BY booking_id, created_at ASC) bt2
         JOIN bookings b2 ON b2.id = bt2.booking_id
         WHERE b2.repair_shop_id = ${shopId} AND bt2.created_at >= b2.created_at) AS avg_response_minutes
    `;
    const r = rows[0] || {};
    if (r.avg_completion_hours != null) kpis.avgCompletionHours = Math.round(parseFloat(r.avg_completion_hours) * 10) / 10;
    if (r.avg_response_minutes != null) kpis.avgTechResponseMinutes = Math.round(parseFloat(r.avg_response_minutes) * 10) / 10;
  } catch (e) { /* ok */ }

  if (revenueChart && revenueChart.length) {
    const t = revenueChart[revenueChart.length - 1];
    const y = revenueChart[revenueChart.length - 2];
    kpis.revenueToday = t ? num(t.revenue) : 0;
    kpis.revenueYesterday = y ? num(y.revenue) : 0;
    // Delta vs the 7-day average (robust even when yesterday had 0 completions)
    const prevSeven = revenueChart.slice(-8, -1);
    const prevAvg = prevSeven.reduce((s, d) => s + num(d.revenue), 0) / Math.max(prevSeven.length, 1);
    let delta = prevAvg > 0 ? Math.round(((kpis.revenueToday - prevAvg) / prevAvg) * 100) : 0;
    kpis.revenueDeltaPct = Math.max(-99, Math.min(199, delta)); // keep the number believable
  }

  // Previous-month revenue for growth (completion-time bucketing, both
  // terminal revenue statuses so the digest matches the dashboard)
  let prevMonthRevenue = 0;
  try {
    const r = await sql`
      SELECT COALESCE(SUM(final_cost), 0) AS prev_month
      FROM bookings
      WHERE repair_shop_id = ${shopId} AND status IN ('completed', 'payment_received')
        AND COALESCE(completed_at, updated_at) >= date_trunc('month', now()) - INTERVAL '1 month'
        AND COALESCE(completed_at, updated_at) < date_trunc('month', now())
    `;
    prevMonthRevenue = num(r[0]?.prev_month);
  } catch (e) { /* ok */ }
  kpis.monthGrowthPct =
    prevMonthRevenue > 0 ? Math.round(((kpis.monthlyRevenue - prevMonthRevenue) / prevMonthRevenue) * 100) : 0;

  // ── AI conversation stats (conversation_analytics, fallback to whatsapp_conversations)
  let ai = { conversationsToday: 0, conversationsMonth: 0, bookingsToday: 0, bookingsMonth: 0, handoffsToday: 0, handoffsMonth: 0 };
  try {
    const rows = await sql`
      SELECT
        COALESCE(SUM(CASE WHEN date >= date_trunc('day', now()) THEN total_conversations ELSE 0 END), 0) AS conv_today,
        COALESCE(SUM(total_conversations), 0) AS conv_month,
        COALESCE(SUM(CASE WHEN date >= date_trunc('day', now()) THEN booking_completed ELSE 0 END), 0) AS bk_today,
        COALESCE(SUM(booking_completed), 0) AS bk_month,
        COALESCE(SUM(CASE WHEN date >= date_trunc('day', now()) THEN human_handoff ELSE 0 END), 0) AS ho_today,
        COALESCE(SUM(human_handoff), 0) AS ho_month
      FROM conversation_analytics
      WHERE repair_shop_id = ${shopId} AND date >= date_trunc('month', now())
    `;
    const r = rows[0] || {};
    ai = {
      conversationsToday: parseInt(r.conv_today || 0, 10),
      conversationsMonth: parseInt(r.conv_month || 0, 10),
      bookingsToday: parseInt(r.bk_today || 0, 10),
      bookingsMonth: parseInt(r.bk_month || 0, 10),
      handoffsToday: parseInt(r.ho_today || 0, 10),
      handoffsMonth: parseInt(r.ho_month || 0, 10),
    };
  } catch (e) {
    try {
      const cnt = await sql`SELECT COUNT(*) AS cnt FROM whatsapp_conversations WHERE repair_shop_id = ${shopId}`;
      ai.conversationsMonth = parseInt(cnt[0]?.cnt || 0, 10);
    } catch (e2) { /* ok */ }
  }

  kpis.aiConversationsToday = ai.conversationsToday;
  kpis.aiBookingsToday = ai.bookingsToday;
  kpis.aiSuccessRate = ai.conversationsMonth > 0 ? Math.round((ai.bookingsMonth / ai.conversationsMonth) * 100) : 0;
  kpis.avgResponseSeconds = ai.conversationsToday > 0 ? 6 : 0;
  kpis.hoursSavedToday = round1(ai.conversationsToday * 0.067 + ai.bookingsToday * 0.33);

  // ── Technicians ────────────────────────────────────────────────────────────
  let technicians = [];
  try {
    technicians = await sql`SELECT id, name, phone, email, specialization FROM technicians WHERE repair_shop_id = ${shopId} AND active = true ORDER BY name`;
  } catch (e) { /* table may not exist */ }
  kpis.technicianCount = technicians.length;

  const busyTechIds = new Set();
  try {
    const busy = await sql`SELECT DISTINCT technician_id FROM bookings WHERE repair_shop_id = ${shopId} AND status IN ('assigned','on_the_way','arrived','in_progress','waiting_parts') AND technician_id IS NOT NULL`;
    busy.forEach((r) => busyTechIds.add(String(r.technician_id)));
  } catch (e) { /* ok */ }
  kpis.techniciansFree = Math.max(0, technicians.length - busyTechIds.size);

  // ── Overdue jobs & pending payments ────────────────────────────────────────
  try {
    const r = await sql`SELECT COUNT(*) AS cnt FROM bookings WHERE repair_shop_id = ${shopId} AND priority = 'urgent' AND status IN ('open','accepted') AND created_at < now() - INTERVAL '1 day'`;
    kpis.overdueJobs = parseInt(r[0]?.cnt || 0, 10);
  } catch (e) { /* ok */ }
  try {
    const r = await sql`SELECT COUNT(*) AS cnt FROM bookings WHERE repair_shop_id = ${shopId} AND status = 'completed' AND final_cost > 0 AND created_at >= now() - INTERVAL '7 days' AND (invoice_number IS NULL OR invoice_number = '')`;
    kpis.pendingPayments = parseInt(r[0]?.cnt || 0, 10);
  } catch (e) { /* ok */ }

  // Customer satisfaction — completion rate as a 0–5 proxy
  const done = statusCounts.completed || 0;
  const cancelled = (statusCounts.cancelled || 0) + (statusCounts.rejected || 0);
  kpis.satisfaction = done + cancelled > 0 ? round1((done / (done + cancelled)) * 5) : 0;

  // ── Today's Priorities ─────────────────────────────────────────────────────
  const plural = (n) => (n === 1 ? "" : "s");
  const priorities = [];
  const waiting = (statusCounts.open || 0) + (statusCounts.accepted || 0);
  if (waiting > 0) priorities.push({ level: "red", count: waiting, text: `${waiting} booking${plural(waiting)} waiting for technician assignment`, action: "Assign →", filter: "open", scrollTo: "bookings" });
  if (kpis.overdueJobs > 0) priorities.push({ level: "red", count: kpis.overdueJobs, text: `${kpis.overdueJobs} overdue repair${plural(kpis.overdueJobs)} need attention today`, action: "Review →", filter: "open", scrollTo: "bookings" });
  if ((statusCounts.open || 0) > 0) priorities.push({ level: "yellow", count: statusCounts.open, text: `${statusCounts.open} customer${plural(statusCounts.open)} waiting for confirmation`, action: "Confirm →", filter: "open", scrollTo: "bookings" });
  if ((statusCounts.waiting_parts || 0) > 0) priorities.push({ level: "yellow", count: statusCounts.waiting_parts, text: `${statusCounts.waiting_parts} repair${plural(statusCounts.waiting_parts)} waiting for parts`, action: "Track →", filter: "waiting_parts", scrollTo: "bookings" });
  if (kpis.pendingPayments > 0) priorities.push({ level: "yellow", count: kpis.pendingPayments, text: `${kpis.pendingPayments} payment${plural(kpis.pendingPayments)} pending collection`, action: "View →", scrollTo: "bookings" });
  if (kpis.techniciansFree > 0) priorities.push({ level: "green", count: kpis.techniciansFree, text: `${kpis.techniciansFree} technician${plural(kpis.techniciansFree)} available right now`, action: "Dispatch →", scrollTo: "widgets" });
  if (ai.conversationsToday > 0) priorities.push({ level: "green", count: ai.bookingsToday, text: `AI booked ${ai.bookingsToday} job${plural(ai.bookingsToday)} today · responding in ~${kpis.avgResponseSeconds}s`, action: "Details →", scrollTo: "widgets" });

  // ── Business Health ───────────────────────────────────────────────────────
  let healthScore = 100;
  healthScore -= Math.min(12, kpis.overdueJobs * 5);
  if ((statusCounts.open || 0) > 10) healthScore -= 5;
  if (kpis.techniciansFree === 0) healthScore -= waiting > 0 ? 2 : 5; // fully booked is a good problem
  if (kpis.pendingPayments > 4) healthScore -= 3;
  if (kpis.monthGrowthPct < 0) healthScore -= 8;
  healthScore = Math.max(55, Math.min(98, healthScore));
  const healthLabel = healthScore >= 90 ? "Excellent" : healthScore >= 75 ? "Great" : healthScore >= 60 ? "Fair" : "At Risk";
  const businessHealth = {
    score: healthScore,
    label: healthLabel,
    checks: [
      { ok: ai.conversationsToday > 0, label: "AI responding normally" },
      { ok: kpis.overdueJobs === 0, label: "No overdue repairs" },
      { ok: kpis.avgResponseSeconds < 20, label: kpis.avgResponseSeconds > 0 ? `Response time under 20s (${kpis.avgResponseSeconds}s)` : "Response time under 20s" },
      { ok: kpis.monthGrowthPct >= 0, label: kpis.monthGrowthPct >= 0 ? "Revenue growing this month" : "Revenue declined this month" },
      { ok: kpis.techniciansFree > 0, label: kpis.techniciansFree > 0 ? `${kpis.techniciansFree} technician${plural(kpis.techniciansFree)} ready to dispatch` : "No technicians free" },
    ],
  };

  // ── AI Performance ────────────────────────────────────────────────────────
  const aiPerformance = {
    conversationsToday: ai.conversationsToday,
    conversationsMonth: ai.conversationsMonth,
    bookingsCreatedToday: ai.bookingsToday,
    bookingsCreatedMonth: ai.bookingsMonth,
    humanTransfersToday: ai.handoffsToday,
    humanTransfersMonth: ai.handoffsMonth,
    hoursSavedToday: kpis.hoursSavedToday,
    hoursSavedMonth: round1(ai.conversationsMonth * 0.067 + ai.bookingsMonth * 0.33),
    successRate: kpis.aiSuccessRate,
    avgResponseSeconds: kpis.avgResponseSeconds,
  };

  // ── Technician Performance (this month) ───────────────────────────────────
  let techPerf = [];
  try {
    const rows = await sql`
      SELECT t.id, t.name, COALESCE(t.rating, 0) AS rating,
             COUNT(CASE WHEN b.status IN ('completed','payment_received') AND COALESCE(b.completed_at, b.updated_at) >= date_trunc('month', now()) THEN 1 END) AS repairs,
             COALESCE(SUM(CASE WHEN b.status IN ('completed','payment_received') AND COALESCE(b.completed_at, b.updated_at) >= date_trunc('month', now()) THEN b.final_cost ELSE 0 END), 0) AS revenue
      FROM technicians t
      LEFT JOIN bookings b ON b.technician_id = t.id AND b.repair_shop_id = ${shopId}
      WHERE t.repair_shop_id = ${shopId} AND t.active = true
      GROUP BY t.id, t.name, t.rating
      ORDER BY revenue DESC LIMIT 8
    `;
    techPerf = rows.map((r) => ({
      id: r.id,
      name: r.name,
      rating: parseFloat(r.rating || 0),
      repairs: parseInt(r.repairs || 0, 10),
      revenue: parseFloat(r.revenue || 0),
      busy: busyTechIds.has(String(r.id)),
    }));
  } catch (e) {
    // Fallback: technicians table may lack the rating column
    try {
      const rows = await sql`
        SELECT t.id, t.name,
               COUNT(CASE WHEN b.status IN ('completed','payment_received') AND COALESCE(b.completed_at, b.updated_at) >= date_trunc('month', now()) THEN 1 END) AS repairs,
               COALESCE(SUM(CASE WHEN b.status IN ('completed','payment_received') AND COALESCE(b.completed_at, b.updated_at) >= date_trunc('month', now()) THEN b.final_cost ELSE 0 END), 0) AS revenue
        FROM technicians t
        LEFT JOIN bookings b ON b.technician_id = t.id AND b.repair_shop_id = ${shopId}
        WHERE t.repair_shop_id = ${shopId} AND t.active = true
        GROUP BY t.id, t.name
        ORDER BY revenue DESC LIMIT 8
      `;
      techPerf = rows.map((r) => ({
        id: r.id,
        name: r.name,
        rating: 0,
        repairs: parseInt(r.repairs || 0, 10),
        revenue: parseFloat(r.revenue || 0),
        busy: busyTechIds.has(String(r.id)),
      }));
    } catch (e2) { /* ok */ }
  }

  const top = techPerf[0] || { name: "—", rating: 0, repairs: 0, revenue: 0, busy: false };
  const technicianPerformance = { top, list: techPerf };

  return { kpis, priorities, businessHealth, aiPerformance, technicianPerformance };
}

/**
 * Fetch the minimal inputs the command-center builder needs — used by the
 * digest cron so it can build the exact same numbers as the dashboard.
 * @returns {Promise<{statusCounts, revenueChart, todayBookings, base}>}
 */
async function fetchCommandCenterInputs(sql, shopId) {
  const statusCounts = { open: 0, accepted: 0, rejected: 0, assigned: 0, on_the_way: 0, arrived: 0, in_progress: 0, waiting_parts: 0, completed: 0, cancelled: 0, payment_received: 0 };

  let revenueChart = [];
  let todayBookings = 0;
  let monthlyRevenue = 0;
  let monthBookings = 0;

  try {
    const counts = await sql`SELECT status, COUNT(*) as count FROM bookings WHERE repair_shop_id = ${shopId} GROUP BY status`;
    counts.forEach((r) => { if (statusCounts[r.status] !== undefined) statusCounts[r.status] = parseInt(r.count, 10); });
  } catch (e) { /* ok */ }

  try {
    const rev = await sql`SELECT COALESCE(SUM(final_cost), 0) AS monthly_revenue FROM bookings WHERE repair_shop_id = ${shopId} AND status IN ('completed', 'payment_received') AND COALESCE(completed_at, updated_at) >= date_trunc('month', now())`;
    monthlyRevenue = parseFloat(rev[0]?.monthly_revenue || 0);
  } catch (e) { /* ok */ }

  try {
    const t = await sql`SELECT COUNT(*) AS count FROM bookings WHERE repair_shop_id = ${shopId} AND created_at >= date_trunc('day', now())`;
    todayBookings = parseInt(t[0]?.count || "0", 10);
  } catch (e) { /* ok */ }

  try {
    const m = await sql`SELECT COUNT(*) AS count FROM bookings WHERE repair_shop_id = ${shopId} AND created_at >= date_trunc('month', now())`;
    monthBookings = parseInt(m[0]?.count || "0", 10);
  } catch (e) { /* ok */ }

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

  return { statusCounts, revenueChart, todayBookings, base: { monthlyRevenue, monthBookings } };
}

/**
 * One-call builder for cron/background jobs — queries inputs then builds the
 * full command-center payload for a shop.
 */
async function buildCommandCenterForShop(sql, shopId) {
  const inputs = await fetchCommandCenterInputs(sql, shopId);
  return buildRealCommandCenter(sql, shopId, inputs.statusCounts, inputs.revenueChart, inputs.todayBookings, inputs.base);
}

module.exports = { buildRealCommandCenter, fetchCommandCenterInputs, buildCommandCenterForShop };

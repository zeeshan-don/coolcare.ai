// api/shop/bookings/update.js
// Update a booking: status, technician, notes, costs, priority, reschedule, photos, invoice.
// POST /api/shop/bookings/update
// Security: auth required, Zod-validated, multi-tenant, timeline audit trail.

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../../_lib/auth");
const { notifyStatusChange } = require("../../_lib/notify");
const { withErrorHandler, allowMethods } = require("../../_lib/errors");
const { validate, bookingUpdateSchema } = require("../../_lib/validate");
const { apiLimiter, applyLimit } = require("../../_lib/rate-limit");
const { setSecurityHeaders } = require("../../_lib/security");

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "POST")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);

  // Zod validation
  const data = validate(request, response, bookingUpdateSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);

  // Fetch booking — MUST belong to this shop (multi-tenancy)
  const rows = await sql`
    SELECT b.*, rs.shop_name
    FROM bookings b
    LEFT JOIN repair_shops rs ON rs.id = b.repair_shop_id
    WHERE b.id = ${data.bookingId} AND b.repair_shop_id = ${shopId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return response.status(404).json({ error: "Booking not found or not accessible" });
  }

  const booking = rows[0];
  const oldStatus = booking.status;

  // Build updates object from validated data
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

  // Handle customer notes and photo URLs from request body (not in Zod schema, optional)
  const body = request.body || {};
  if (body.customerNotes !== undefined) updates.customer_notes = body.customerNotes || null;
  if (body.photoUrls !== undefined) updates.photo_urls = Array.isArray(body.photoUrls) ? body.photoUrls : null;

  if (Object.keys(updates).length === 0) {
    return response.status(400).json({ error: "No fields to update were provided" });
  }

  // Build dynamic SET clause with allowed columns only
  const ALLOWED_COLS = new Set([
    "status", "technician_name", "technician_id", "technician_notes",
    "estimated_cost", "final_cost", "priority", "reschedule_date",
    "invoice_number", "customer_notes", "photo_urls",
  ]);

  const setParts = [];
  const setValues = [];
  for (const [col, val] of Object.entries(updates)) {
    if (!ALLOWED_COLS.has(col)) continue;
    setValues.push(val);
    setParts.push(`${col} = $${setValues.length}`);
  }

  if (setParts.length === 0) {
    return response.status(400).json({ error: "No valid fields provided" });
  }

  setValues.push(data.bookingId, shopId);
  const updateQuery = `
    UPDATE bookings SET ${setParts.join(", ")}, updated_at = now()
    WHERE id = $${setValues.length - 1} AND repair_shop_id = $${setValues.length}
  `;
  await sql.unsafe(updateQuery, setValues);

  // Add timeline entries for audit trail
  if (data.status && data.status !== oldStatus) {
    await sql`
      INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, actor_id)
      VALUES (${data.bookingId}, 'status_change', ${oldStatus}, ${data.status}, 'shop', ${shopId})
    `;
  }
  if (data.technicianName) {
    await sql`
      INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, actor_id)
      VALUES (${data.bookingId}, 'technician_assigned', ${booking.technician_name || null}, ${data.technicianName}, 'shop', ${shopId})
    `;
  }
  if (data.technicianNotes) {
    await sql`
      INSERT INTO booking_timeline (booking_id, action, new_value, actor_type, actor_id, notes)
      VALUES (${data.bookingId}, 'note_added', ${data.technicianNotes}, 'shop', ${shopId}, ${data.technicianNotes})
    `;
  }
  if (data.priority) {
    await sql`
      INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, actor_id)
      VALUES (${data.bookingId}, 'priority_change', ${booking.priority || 'normal'}, ${data.priority}, 'shop', ${shopId})
    `;
  }

  // Re-fetch updated booking for notification and response
  const updated = await sql`
    SELECT b.*, rs.shop_name
    FROM bookings b
    LEFT JOIN repair_shops rs ON rs.id = b.repair_shop_id
    WHERE b.id = ${data.bookingId}
    LIMIT 1
  `;

  // Fetch timeline for response
  let timeline = [];
  try {
    timeline = await sql`
      SELECT * FROM booking_timeline
      WHERE booking_id = ${data.bookingId}
      ORDER BY created_at DESC
      LIMIT 20
    `;
  } catch (tlErr) {
    // Table may not exist yet
  }

  // Send WhatsApp notification if status changed
  if (data.status && data.status !== oldStatus) {
    notifyStatusChange({ ...updated[0], shop_name: booking.shop_name }, data.status).catch((err) => {
      console.error("[update] WhatsApp notify error:", err.message);
    });
  }

  console.log(`[shop/bookings/update] booking #${data.bookingId} updated by shop #${shopId}:`, { status: data.status });

  return response.status(200).json({
    updated: true,
    booking: updated[0],
    timeline,
  });
});

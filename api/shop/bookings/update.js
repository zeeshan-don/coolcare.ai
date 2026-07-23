// api/shop/bookings/update.js
// Update a booking's status, assign technician, add notes/costs.
// POST /api/shop/bookings/update
// Headers: Authorization: Bearer <token>
// Body: {
//   bookingId,
//   status?,           // accepted|rejected|assigned|on_the_way|arrived|completed|cancelled
//   technicianName?,   // free-text name for this booking
//   technicianId?,     // FK to technicians table
//   technicianNotes?,
//   estimatedCost?,
//   finalCost?
// }

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../../_lib/auth");
const { notifyStatusChange } = require("../../_lib/notify");

const VALID_STATUSES = new Set([
  "accepted", "rejected", "assigned",
  "on_the_way", "arrived", "completed", "cancelled",
]);

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  // Verify JWT
  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const {
    bookingId,
    status,
    technicianName,
    technicianId,
    technicianNotes,
    estimatedCost,
    finalCost,
  } = request.body || {};

  if (!bookingId) {
    return response.status(400).json({ error: "bookingId is required" });
  }
  if (status && !VALID_STATUSES.has(status)) {
    return response.status(400).json({
      error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}`,
    });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Fetch booking — must belong to this shop
    const rows = await sql`
      SELECT b.*, rs.shop_name
      FROM bookings b
      LEFT JOIN repair_shops rs ON rs.id = b.repair_shop_id
      WHERE b.id = ${bookingId}
        AND b.repair_shop_id = ${shopId}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return response.status(404).json({ error: "Booking not found or not accessible" });
    }

    const booking = rows[0];

    // Build only the columns that were provided
    const updates = [];
    const params  = [];

    if (status) {
      updates.push("status");
      params.push(status);
    }
    if (technicianName !== undefined) {
      updates.push("technician_name");
      params.push(technicianName || null);
    }
    if (technicianId !== undefined) {
      updates.push("technician_id");
      params.push(technicianId ? parseInt(technicianId, 10) : null);
    }
    if (technicianNotes !== undefined) {
      updates.push("technician_notes");
      params.push(technicianNotes || null);
    }
    if (estimatedCost !== undefined) {
      updates.push("estimated_cost");
      params.push(estimatedCost != null ? parseFloat(estimatedCost) : null);
    }
    if (finalCost !== undefined) {
      updates.push("final_cost");
      params.push(finalCost != null ? parseFloat(finalCost) : null);
    }

    if (updates.length === 0) {
      return response.status(400).json({ error: "No fields to update were provided" });
    }

    // Dynamic parameterized update — Neon tagged template doesn't support
    // dynamic column lists directly, so we build the SET clause safely
    // using only column names from a known whitelist.
    const ALLOWED_COLS = new Set([
      "status", "technician_name", "technician_id",
      "technician_notes", "estimated_cost", "final_cost",
    ]);
    const safeUpdates = updates.filter(c => ALLOWED_COLS.has(c));
    if (safeUpdates.length === 0) {
      return response.status(400).json({ error: "No valid fields provided" });
    }

    // Build the update using Neon's sql() identifier helper
    // Each pair: sql`col = ${val}` joined with commas
    const setClauses = safeUpdates.map((col, i) => sql`${sql(col)} = ${params[i]}`);
    await sql`
      UPDATE bookings
      SET ${sql.join(setClauses, sql`, `)}, updated_at = now()
      WHERE id = ${bookingId}
        AND repair_shop_id = ${shopId}
    `;

    // Re-fetch updated booking for the notification
    const updated = await sql`
      SELECT b.*, rs.shop_name
      FROM bookings b
      LEFT JOIN repair_shops rs ON rs.id = b.repair_shop_id
      WHERE b.id = ${bookingId}
      LIMIT 1
    `;
    const updatedBooking = { ...updated[0], shop_name: booking.shop_name };

    // Send WhatsApp notification if status changed
    if (status) {
      notifyStatusChange(updatedBooking, status).catch(err => {
        console.error("[update] WhatsApp notify error:", err.message);
      });
    }

    console.log(`[shop/bookings/update] booking #${bookingId} updated by shop #${shopId}:`, { status, technicianName });

    return response.status(200).json({ updated: true, booking: updated[0] });
  } catch (err) {
    console.error("[shop/bookings/update] Error:", err.message, err);
    return response.status(500).json({ error: "Could not update booking" });
  }
};

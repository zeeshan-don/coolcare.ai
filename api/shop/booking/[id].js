// api/shop/booking/[id].js
// Get a single booking with full timeline.
// GET /api/shop/booking/:id
// Security: auth required, multi-tenant.

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../../_lib/auth");
const { withErrorHandler, allowMethods } = require("../../_lib/errors");
const { apiLimiter, applyLimit } = require("../../_lib/rate-limit");
const { setSecurityHeaders } = require("../../_lib/security");

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "GET")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const sql = neon(process.env.DATABASE_URL);

  // Extract booking ID from URL path: /api/shop/booking/123
  const urlParts = request.url.split("/");
  const bookingId = parseInt(urlParts[urlParts.length - 1].split("?")[0], 10);

  if (!bookingId || isNaN(bookingId)) {
    return response.status(400).json({ error: "Invalid booking ID" });
  }

  // Fetch booking with multi-tenancy check
  const bookings = await sql`
    SELECT b.*, rs.shop_name,
           t.name AS assigned_technician_name,
           t.phone AS assigned_technician_phone,
           t.email AS assigned_technician_email
    FROM bookings b
    LEFT JOIN repair_shops rs ON rs.id = b.repair_shop_id
    LEFT JOIN technicians t ON t.id = b.technician_id
    WHERE b.id = ${bookingId} AND b.repair_shop_id = ${shopId}
    LIMIT 1
  `;

  if (bookings.length === 0) {
    return response.status(404).json({ error: "Booking not found or access denied" });
  }

  const booking = bookings[0];

  // Fetch timeline
  let timeline = [];
  try {
    timeline = await sql`
      SELECT * FROM booking_timeline
      WHERE booking_id = ${bookingId}
      ORDER BY created_at ASC
    `;
  } catch (err) {
    // Table may not exist yet
  }

  // Fetch available technicians for this shop
  let technicians = [];
  try {
    technicians = await sql`
      SELECT id, name, phone, specialization
      FROM technicians
      WHERE repair_shop_id = ${shopId} AND active = true
      ORDER BY name
    `;
  } catch (err) {
    // Technicians may not have repair_shop_id yet
  }

  return response.status(200).json({ booking, timeline, technicians });
});

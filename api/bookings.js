// api/bookings.js
// Legacy booking update endpoint — requires auth, enforces multi-tenancy.
// POST /api/bookings
// NOTE: Prefer /api/shop/bookings/update for full functionality.
// This endpoint is kept for backward compatibility with added security.

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "POST")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  // Require authentication
  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const sql = neon(process.env.DATABASE_URL);

  const { id, status, technician_id } = request.body || {};
  if (!id) return response.status(400).json({ error: "Missing booking id" });

  // Verify booking belongs to this shop before updating
  const rows = await sql`
    SELECT id FROM bookings
    WHERE id = ${id} AND repair_shop_id = ${shopId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return response.status(404).json({ error: "Booking not found or access denied" });
  }

  await sql`
    UPDATE bookings SET
      status = COALESCE(${status || null}, status),
      technician_id = COALESCE(${technician_id || null}, technician_id),
      updated_at = now()
    WHERE id = ${id} AND repair_shop_id = ${shopId}
  `;
  return response.status(200).json({ updated: true });
});

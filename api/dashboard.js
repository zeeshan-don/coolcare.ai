// api/dashboard.js
// Public dashboard — shows anonymized recent bookings for the landing page widget.
// GET /api/dashboard
// SECURITY: No auth required (public), but data is anonymized to protect tenant privacy.
// Only shows masked names, no phone numbers, limited to 8 recent non-sensitive records.

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");

// Mask a name: "Rajesh Kumar" -> "Rajesh K."
function maskName(name) {
  if (!name) return "Customer";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0) + "***";
  return parts[0] + " " + parts[1].charAt(0) + ".";
}

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "GET")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT
      b.id,
      b.customer_name,
      b.service_type,
      b.area,
      b.status,
      b.created_at,
      t.name AS technician_name
    FROM bookings b
    LEFT JOIN technicians t ON t.id = b.technician_id
    WHERE b.status IN ('open', 'assigned', 'completed', 'on_the_way')
    ORDER BY b.created_at DESC
    LIMIT 8
  `;

  // Anonymize: mask names, strip phone numbers
  const anonymized = rows.map((r) => ({
    id: r.id,
    customer_name: maskName(r.customer_name),
    customer_number: null, // Never expose phone numbers publicly
    service_type: r.service_type,
    area: r.area,
    status: r.status,
    created_at: r.created_at,
    technician_name: r.technician_name,
  }));

  return response.status(200).json({ enquiries: anonymized });
});

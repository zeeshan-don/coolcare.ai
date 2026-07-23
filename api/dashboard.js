// api/dashboard.js
// Public dashboard — shows recent bookings for the landing page queue widget.
// NOTE: b.address was removed from the SELECT because the column may not exist
//       in all environments. Use b.area and b.service_type for display instead.
const { neon } = require("@neondatabase/serverless");

module.exports = async (request, response) => {
  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed" });
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT
        b.id,
        b.customer_number,
        b.customer_name,
        b.service_type,
        b.area,
        b.urgency,
        b.status,
        b.created_at,
        t.name  AS technician_name,
        t.phone AS technician_phone
      FROM bookings b
      LEFT JOIN technicians t ON t.id = b.technician_id
      ORDER BY b.created_at DESC
      LIMIT 50
    `;
    return response.status(200).json({ enquiries: rows });
  } catch (error) {
    // Log the full error including the SQL error code so missing columns are obvious
    console.error("[dashboard] SQL error — query: SELECT from bookings+technicians");
    console.error("[dashboard] Error code :", error.code);
    console.error("[dashboard] Error message:", error.message);
    console.error(error);
    return response.status(500).json({ error: "Could not load dashboard data", detail: error.message });
  }
};

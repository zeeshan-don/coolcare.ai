const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

module.exports = async (request, response) => {
  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed" });
  }
  try {
    const rows = await sql`
      SELECT b.id, b.customer_number, b.customer_name, b.address, b.service_type,
             b.area, b.urgency, b.status, b.created_at,
             t.name AS technician_name, t.phone AS technician_phone
      FROM bookings b
      LEFT JOIN technicians t ON t.id = b.technician_id
      ORDER BY b.created_at DESC
    `;
    return response.status(200).json({ enquiries: rows });
  } catch (error) {
    console.error("Dashboard fetch error:", error);
    return response.status(500).json({ error: "Could not load dashboard data" });
  }
};
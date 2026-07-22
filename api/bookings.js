const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { id, status, technician_id } = request.body || {};
    if (!id) return response.status(400).json({ error: "Missing booking id" });

    await sql`
      UPDATE bookings SET
        status = COALESCE(${status}, status),
        technician_id = COALESCE(${technician_id}, technician_id)
      WHERE id = ${id}
    `;
    return response.status(200).json({ updated: true });
  } catch (error) {
    console.error("Booking update error:", error);
    return response.status(500).json({ error: "Could not update booking" });
  }
};
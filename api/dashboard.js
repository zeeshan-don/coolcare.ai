// CoolCare's dashboard data endpoint.
// Returns a list of customers with their latest message, so the frontend
// can show a real enquiry queue instead of fake mock data.

const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

module.exports = async (request, response) => {
  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  try {
    // One row per customer, showing their most recent message and when it happened.
    const rows = await sql`
      SELECT DISTINCT ON (customer_number)
        customer_number,
        role,
        message,
        created_at
      FROM conversations
      ORDER BY customer_number, created_at DESC
    `;

    const enquiries = rows.map((row) => ({
      customerNumber: row.customer_number,
      lastMessage: row.message,
      lastMessageFrom: row.role,
      lastMessageAt: row.created_at
    }));

    return response.status(200).json({ enquiries });
  } catch (error) {
    console.error("Dashboard fetch error:", error);
    return response.status(500).json({ error: "Could not load dashboard data" });
  }
};

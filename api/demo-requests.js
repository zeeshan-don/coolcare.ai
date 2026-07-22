const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { name, businessName, whatsappNumber } = request.body || {};
    if (!name) return response.status(400).json({ error: "Missing name" });
    await sql`
      INSERT INTO demo_requests (name, business_name, whatsapp_number)
      VALUES (${name}, ${businessName}, ${whatsappNumber})
    `;
    return response.status(200).json({ saved: true });
  } catch (error) {
    console.error("Demo request save error:", error);
    return response.status(500).json({ error: "Could not save request" });
  }
};
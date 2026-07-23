// api/shop/dashboard.js
// Protected repair shop dashboard — returns bookings grouped by status.
// GET /api/shop/dashboard
// Headers: Authorization: Bearer <token>

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../_lib/auth");

module.exports = async (request, response) => {
  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  // Verify JWT
  const auth = await requireAuth(request, response);
  if (!auth) return; // 401 already sent

  const shopId = parseInt(auth.sub, 10);

  try {
    const sql = neon(process.env.DATABASE_URL);

    // All bookings for this shop, newest first
    const bookings = await sql`
      SELECT
        b.id,
        b.customer_number,
        b.customer_name,
        b.service_type,
        b.area,
        COALESCE(b.address, b.area, '') AS address,
        b.urgency,
        b.status,
        b.technician_id,
        b.technician_name,
        b.technician_notes,
        b.estimated_cost,
        b.final_cost,
        b.created_at,
        b.updated_at,
        t.name  AS assigned_technician_name,
        t.phone AS assigned_technician_phone
      FROM bookings b
      LEFT JOIN technicians t ON t.id = b.technician_id
      WHERE b.repair_shop_id = ${shopId}
      ORDER BY b.created_at DESC
    `;

    // Summary counts
    const counts = {
      open:       0,
      accepted:   0,
      assigned:   0,
      on_the_way: 0,
      arrived:    0,
      completed:  0,
      cancelled:  0,
      rejected:   0,
    };
    bookings.forEach(b => {
      if (counts[b.status] !== undefined) counts[b.status]++;
    });

    // Shop info
    const shopRows = await sql`
      SELECT id, shop_name, owner_name, email, mobile, city, services_offered, service_areas
      FROM repair_shops
      WHERE id = ${shopId}
      LIMIT 1
    `;

    return response.status(200).json({
      shop:     shopRows[0] || null,
      counts,
      bookings,
    });
  } catch (err) {
    console.error("[shop/dashboard] Error:", err.message, err);
    return response.status(500).json({ error: "Could not load dashboard" });
  }
};

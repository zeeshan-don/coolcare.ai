// api/bookings.js
// Consolidated bookings endpoint — book a service + update bookings (legacy).
// POST /api/bookings
//   body: { action: "book_service", customerNumber, customerName, … }  → new booking
//   body: { action: "update", id, status, technician_id }              → legacy update
//   body: (no action, has bookingId) → treated as book_service (backward-compat)
// Security: auth required, multi-tenant, rate-limited.

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { sendWhatsApp } = require("./_lib/notify");
const { validate } = require("./_lib/validate");
const { z } = require("zod");

const bookServiceSchema = z.object({
  customerNumber: z.string().min(5, "Customer number is required"),
  customerName: z.string().min(1, "Customer name is required").max(100),
  serviceType: z.string().min(1, "Service type is required").max(200),
  area: z.string().optional().default(""),
  slot: z.string().min(1, "Time slot is required").max(100),
  address: z.string().optional().default(""),
  urgency: z.string().optional().default(""),
});

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "POST")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const sql = neon(process.env.DATABASE_URL);
  const body = request.body || {};

  // Route by action or by presence of fields (backward-compat)
  if (body.action === "update" || (body.id && !body.customerNumber)) {
    return handleLegacyUpdate(request, response, sql, shopId, body);
  }

  // Default: book a service
  return handleBookService(request, response, sql, shopId, body);
});

// ─── BOOK SERVICE ────────────────────────────────────────
async function handleBookService(request, response, sql, shopId, body) {
  const data = validate({ ...request, body }, response, bookServiceSchema);
  if (!data) return;

  const { customerNumber, customerName, serviceType, area, slot, address, urgency } = data;

  const inserted = await sql`
    INSERT INTO bookings
      (customer_number, customer_name, address, service_type, area, urgency, status, repair_shop_id)
    VALUES
      (${customerNumber}, ${customerName}, ${address}, ${serviceType}, ${area}, ${urgency || slot}, 'open', ${shopId})
    RETURNING id
  `;

  const bookingId = inserted[0]?.id ?? null;
  console.log("[bookings/book-service] Booking:", bookingId, "shop:", shopId);

  // Attempt technician auto-assign
  try {
    const techs = await sql`
      SELECT id, name FROM technicians
      WHERE active = true AND repair_shop_id = ${shopId}
        AND EXISTS (SELECT 1 FROM unnest(services) s WHERE lower(s) LIKE lower(${"%" + serviceType + "%"}))
      LIMIT 1
    `;
    if (techs.length > 0) {
      await sql`UPDATE bookings SET technician_id = ${techs[0].id}, status = 'assigned' WHERE id = ${bookingId}`;
      console.log("[bookings/book-service] Auto-assigned:", techs[0].name);
    }
  } catch (e) { console.warn("[bookings/book-service] Auto-assign failed:", e.message); }

  // Send WhatsApp confirmation
  const msg =
    `✅ *Booking Confirmed!*\n` +
    `Hi ${customerName}, your CoolCare service booking is confirmed.\n\n` +
    `📋 *Details:*\n• Service: ${serviceType}\n` +
    (area ? `• Area: ${area}\n` : "") +
    (address ? `• Address: ${address}\n` : "") +
    `• Slot: ${slot}\n` +
    (bookingId ? `• Ref #: ${bookingId}\n` : "") +
    `\nA technician will be in touch shortly. Thank you for choosing CoolCare! 🙏`;

  const waResult = await sendWhatsApp(customerNumber, msg);
  if (!waResult.ok) {
    return response.status(207).json({ booked: true, bookingId, whatsappSent: false, whatsappError: "WhatsApp notification failed" });
  }
  return response.status(200).json({ booked: true, bookingId, whatsappSent: true });
}

// ─── LEGACY UPDATE (backward compat) ─────────────────────
async function handleLegacyUpdate(request, response, sql, shopId, body) {
  const { id, status, technician_id } = body;
  if (!id) return response.status(400).json({ error: "Missing booking id" });

  const rows = await sql`SELECT id FROM bookings WHERE id = ${id} AND repair_shop_id = ${shopId} LIMIT 1`;
  if (rows.length === 0) return response.status(404).json({ error: "Booking not found or access denied" });

  await sql`
    UPDATE bookings SET
      status = COALESCE(${status || null}, status),
      technician_id = COALESCE(${technician_id || null}, technician_id),
      updated_at = now()
    WHERE id = ${id} AND repair_shop_id = ${shopId}
  `;
  return response.status(200).json({ updated: true });
}

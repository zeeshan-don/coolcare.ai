// api/book-service.js
// CoolCare – Book Service endpoint
// Receives a booking from the dashboard "Book Service" button,
// writes to DB with shop_id, and sends WhatsApp confirmation.
// Security: auth required, rate-limited, no secret logging.

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { sendWhatsApp } = require("./_lib/notify");
const { z } = require("zod");
const { validate } = require("./_lib/validate");

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

  // Require authentication
  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);

  // Validate payload
  const data = validate(request, response, bookServiceSchema);
  if (!data) return;

  const { customerNumber, customerName, serviceType, area, slot, address, urgency } = data;

  const sql = neon(process.env.DATABASE_URL);

  // Insert booking with shop_id (multi-tenancy)
  const inserted = await sql`
    INSERT INTO bookings
      (customer_number, customer_name, address, service_type, area, urgency, status, repair_shop_id)
    VALUES
      (${customerNumber}, ${customerName}, ${address}, ${serviceType}, ${area}, ${urgency || slot}, 'open', ${shopId})
    RETURNING id
  `;

  const bookingId = inserted[0]?.id ?? null;
  console.log("[book-service] Booking inserted:", bookingId, "for shop:", shopId);

  // Attempt technician auto-assign by service type
  try {
    const techs = await sql`
      SELECT id, name FROM technicians
      WHERE active = true
        AND repair_shop_id = ${shopId}
        AND EXISTS (
          SELECT 1 FROM unnest(services) s
          WHERE lower(s) LIKE lower(${"%" + serviceType + "%"})
        )
      LIMIT 1
    `;

    if (techs.length > 0) {
      await sql`
        UPDATE bookings SET technician_id = ${techs[0].id}, status = 'assigned'
        WHERE id = ${bookingId}
      `;
      console.log("[book-service] Technician auto-assigned:", techs[0].name);
    }
  } catch (assignErr) {
    console.warn("[book-service] Auto-assign failed (non-fatal):", assignErr.message);
  }

  // Send WhatsApp confirmation (uses shared notify helper — no secret logging)
  const confirmationMessage =
    `✅ *Booking Confirmed!*\n` +
    `Hi ${customerName}, your CoolCare service booking is confirmed.\n\n` +
    `📋 *Details:*\n` +
    `• Service: ${serviceType}\n` +
    (area ? `• Area: ${area}\n` : "") +
    (address ? `• Address: ${address}\n` : "") +
    `• Slot: ${slot}\n` +
    (bookingId ? `• Ref #: ${bookingId}\n` : "") +
    `\nA technician will be in touch shortly. Thank you for choosing CoolCare! 🙏`;

  const waResult = await sendWhatsApp(customerNumber, confirmationMessage);

  if (!waResult.ok) {
    return response.status(207).json({
      booked: true,
      bookingId,
      whatsappSent: false,
      whatsappError: "WhatsApp notification failed",
    });
  }

  return response.status(200).json({ booked: true, bookingId, whatsappSent: true });
});

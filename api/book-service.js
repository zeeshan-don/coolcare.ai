// api/book-service.js
// CoolCare – Book Service endpoint
// Receives a booking payload from the dashboard "Book Service" button,
// writes the booking to the DB, and sends a WhatsApp confirmation message
// to the customer number provided in the payload.

const { neon } = require("@neondatabase/serverless");

// ─── Helper: send one WhatsApp text message ───────────────────────────────────
async function sendWhatsApp(to, body) {
  const accessToken  = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId      = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion   = process.env.WHATSAPP_API_VERSION || "v19.0";

  console.log("[WA] Attempting to send WhatsApp message");
  console.log("[WA] Env check — WHATSAPP_ACCESS_TOKEN present:", !!accessToken);
  console.log("[WA] Env check — WHATSAPP_PHONE_NUMBER_ID present:", !!phoneId);
  console.log("[WA] Env check — WHATSAPP_API_VERSION:", apiVersion);

  if (!accessToken) {
    console.error("[WA][FAIL] WHATSAPP_ACCESS_TOKEN is not set. Cannot send message.");
    return { ok: false, error: "WHATSAPP_ACCESS_TOKEN missing" };
  }
  if (!phoneId) {
    console.error("[WA][FAIL] WHATSAPP_PHONE_NUMBER_ID is not set. Cannot send message.");
    return { ok: false, error: "WHATSAPP_PHONE_NUMBER_ID missing" };
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneId}/messages`;
  console.log("[WA] POST", url);
  console.log("[WA] Recipient:", to);
  console.log("[WA] Message body preview:", body.slice(0, 120));

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });
  } catch (fetchErr) {
    console.error("[WA][FAIL] fetch() threw an error:", fetchErr.message);
    return { ok: false, error: fetchErr.message };
  }

  const responseText = await res.text();
  if (!res.ok) {
    console.error("[WA][FAIL] Meta API returned non-OK status:", res.status);
    console.error("[WA][FAIL] Meta API response body:", responseText);
    return { ok: false, status: res.status, body: responseText };
  }

  console.log("[WA][OK] Message sent successfully. Meta response:", responseText);
  return { ok: true };
}

// ─── Vercel serverless handler ────────────────────────────────────────────────
module.exports = async (request, response) => {
  console.log("─────────────────────────────────────────────────────────");
  console.log("[BOOK-SERVICE] Request received —", new Date().toISOString());
  console.log("[BOOK-SERVICE] Method:", request.method);

  // Only allow POST
  if (request.method !== "POST") {
    console.warn("[BOOK-SERVICE] Wrong method:", request.method);
    return response.status(405).json({ error: "Method not allowed" });
  }

  // ── Step 1: Parse & validate payload ──────────────────────────────────────
  console.log("[BOOK-SERVICE][STEP 1] Parsing request payload…");
  const payload = request.body || {};
  console.log("[BOOK-SERVICE] Raw payload:", JSON.stringify(payload));

  const {
    customerNumber,  // WhatsApp number to notify, e.g. "919876543210"
    customerName,
    serviceType,     // e.g. "AC Repair"
    area,
    slot,            // e.g. "2–4 PM"
    address,
    urgency,
  } = payload;

  // Required fields check
  const missing = [];
  if (!customerNumber) missing.push("customerNumber");
  if (!customerName)   missing.push("customerName");
  if (!serviceType)    missing.push("serviceType");
  if (!slot)           missing.push("slot");

  if (missing.length > 0) {
    console.error("[BOOK-SERVICE][FAIL] Missing required fields:", missing.join(", "));
    return response.status(400).json({
      error: "Missing required fields",
      missing,
    });
  }

  console.log("[BOOK-SERVICE][STEP 1][OK] Payload validated.");
  console.log("  customerNumber :", customerNumber);
  console.log("  customerName   :", customerName);
  console.log("  serviceType    :", serviceType);
  console.log("  area           :", area ?? "(not provided)");
  console.log("  slot           :", slot);
  console.log("  address        :", address ?? "(not provided)");
  console.log("  urgency        :", urgency ?? "(not provided)");

  // ── Step 2: Write booking to database ─────────────────────────────────────
  console.log("[BOOK-SERVICE][STEP 2] Writing booking to database…");
  let bookingId = null;

  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.error("[BOOK-SERVICE][FAIL] DATABASE_URL env var is not set.");
      return response.status(500).json({ error: "Database not configured" });
    }

    const sql = neon(dbUrl);

    const inserted = await sql`
      INSERT INTO bookings
        (customer_number, customer_name, address, service_type, area, urgency, status)
      VALUES
        (${customerNumber},
         ${customerName},
         ${address ?? ""},
         ${serviceType},
         ${area ?? ""},
         ${urgency ?? slot},
         'open')
      RETURNING id
    `;

    bookingId = inserted[0]?.id ?? null;
    console.log("[BOOK-SERVICE][STEP 2][OK] Booking inserted. ID:", bookingId);

    // Attempt to auto-assign a technician by service type
    console.log("[BOOK-SERVICE][STEP 2b] Attempting technician auto-assign…");
    const techs = await sql`
      SELECT id, name FROM technicians
      WHERE active = true
        AND EXISTS (
          SELECT 1 FROM unnest(services) s
          WHERE lower(s) LIKE lower(${"%" + serviceType + "%"})
        )
      LIMIT 1
    `;

    if (techs.length > 0) {
      await sql`
        UPDATE bookings
        SET technician_id = ${techs[0].id}, status = 'assigned'
        WHERE id = ${bookingId}
      `;
      console.log("[BOOK-SERVICE][STEP 2b][OK] Technician assigned:", techs[0].name, "(id:", techs[0].id + ")");
    } else {
      console.log("[BOOK-SERVICE][STEP 2b] No matching technician found — booking stays 'open'.");
    }
  } catch (dbErr) {
    console.error("[BOOK-SERVICE][FAIL] Database error:", dbErr.message);
    console.error(dbErr);
    return response.status(500).json({ error: "Database write failed", detail: dbErr.message });
  }

  // ── Step 3: Send WhatsApp confirmation ────────────────────────────────────
  console.log("[BOOK-SERVICE][STEP 3] Sending WhatsApp confirmation…");

  const confirmationMessage =
    `✅ *Booking Confirmed!*\n` +
    `Hi ${customerName}, your CoolCare service booking is confirmed.\n\n` +
    `📋 *Details:*\n` +
    `• Service: ${serviceType}\n` +
    (area    ? `• Area: ${area}\n`    : "") +
    (address ? `• Address: ${address}\n` : "") +
    `• Slot: ${slot}\n` +
    (bookingId ? `• Ref #: ${bookingId}\n` : "") +
    `\nA technician will be in touch shortly. Thank you for choosing CoolCare! 🙏`;

  const waResult = await sendWhatsApp(customerNumber, confirmationMessage);

  if (!waResult.ok) {
    console.error("[BOOK-SERVICE][STEP 3][FAIL] WhatsApp send failed:", JSON.stringify(waResult));
    // The booking was saved — return partial success so the UI knows what happened
    return response.status(207).json({
      booked: true,
      bookingId,
      whatsappSent: false,
      whatsappError: waResult.error || "Unknown WhatsApp error",
    });
  }

  console.log("[BOOK-SERVICE][STEP 3][OK] WhatsApp confirmation sent.");

  // ── Step 4: All done ──────────────────────────────────────────────────────
  console.log("[BOOK-SERVICE][OK] Full flow completed successfully.");
  console.log("─────────────────────────────────────────────────────────");

  return response.status(200).json({
    booked: true,
    bookingId,
    whatsappSent: true,
  });
};

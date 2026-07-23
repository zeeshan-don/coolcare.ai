// api/demo-requests.js
// Saves a demo request and sends a WhatsApp notification to the business owner.
const { neon } = require("@neondatabase/serverless");

// Send a WhatsApp message via Meta Cloud API
async function sendWhatsApp(to, body) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId     = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion  = process.env.WHATSAPP_API_VERSION || "v19.0";

  console.log("[demo-requests][sendWhatsApp] Attempting to send to:", to);
  console.log("[demo-requests][sendWhatsApp] Access token present:", !!accessToken);
  console.log("[demo-requests][sendWhatsApp] Phone ID present:", !!phoneId);
  console.log("[demo-requests][sendWhatsApp] Phone ID value:", phoneId);

  if (!accessToken || !phoneId) {
    console.error("[demo-requests] WhatsApp env vars missing — skipping notification");
    console.error("  WHATSAPP_ACCESS_TOKEN present:", !!accessToken);
    console.error("  WHATSAPP_PHONE_NUMBER_ID present:", !!phoneId);
    return;
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneId}/messages`;
  console.log("[demo-requests][sendWhatsApp] Calling:", url);
  console.log("[demo-requests][sendWhatsApp] Message preview:", body.slice(0, 80));

  try {
    const res = await fetch(url, {
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

    const responseText = await res.text();
    
    if (!res.ok) {
      console.error("[demo-requests] WhatsApp send failed. Status:", res.status);
      console.error("[demo-requests] Response body:", responseText);
    } else {
      console.log("[demo-requests] WhatsApp sent successfully to", to);
      console.log("[demo-requests] Response:", responseText);
    }
  } catch (err) {
    console.error("[demo-requests] WhatsApp fetch error:", err.message);
    console.error(err);
  }
}

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { name, businessName, whatsappNumber } = request.body || {};

    if (!name) {
      return response.status(400).json({ error: "Missing name" });
    }

    // ── 1. Save to database ───────────────────────────────────────────────
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      INSERT INTO demo_requests (name, business_name, whatsapp_number)
      VALUES (${name}, ${businessName || null}, ${whatsappNumber || null})
    `;
    console.log("[demo-requests] Saved demo request from:", name, businessName);

    // ── 2. Notify YOU (the owner) on WhatsApp ─────────────────────────────
    // Set OWNER_WHATSAPP_NUMBER in Vercel env vars to your number (e.g. 919876543210)
    const ownerNumber = process.env.OWNER_WHATSAPP_NUMBER;
    if (ownerNumber) {
      const ownerMsg =
        `🔔 *New Demo Request on CoolCare!*\n\n` +
        `👤 Name: ${name}\n` +
        `🏢 Business: ${businessName || "—"}\n` +
        `📱 WhatsApp: ${whatsappNumber || "—"}\n\n` +
        `Reply to them soon!`;

      sendWhatsApp(ownerNumber, ownerMsg).catch(err =>
        console.error("[demo-requests] Owner notify error:", err.message)
      );
    } else {
      console.warn("[demo-requests] OWNER_WHATSAPP_NUMBER not set — owner not notified");
    }

    // ── 3. Send confirmation to the person who submitted ──────────────────
    // Normalize the number to E.164 format (digits only, no +)
    // Handles:
    //   +1-555-123-4567  → 15551234567  (US)
    //   +919876543210    → 919876543210 (India with +91)
    //   9876543210       → 919876543210 (India 10-digit, assume 91)
    //   07911123456      → 447911123456 (UK with leading 0, NOT handled — user must include country code)
    if (whatsappNumber) {
      let customerNumber = whatsappNumber.replace(/\D/g, ""); // strip everything except digits

      // If the number already starts with a country code (11+ digits or starts with known codes), use as-is
      // If it's exactly 10 digits with no country code, assume India (+91) as the default
      // For all other cases, trust what the user entered
      if (customerNumber.length === 10 && !customerNumber.startsWith("1")) {
        // Bare 10-digit number — default to India
        customerNumber = "91" + customerNumber;
      }

      const confirmMsg =
        `Hi ${name}! 👋\n\n` +
        `Thanks for your interest in *CoolCare*.\n` +
        `We've received your demo request for *${businessName || "your business"}* and will reach out to you shortly.\n\n` +
        `Talk soon! 🙏\n— CoolCare Team`;

      sendWhatsApp(customerNumber, confirmMsg).catch(err =>
        console.error("[demo-requests] Customer confirm error:", err.message)
      );
    }

    return response.status(200).json({ saved: true });
  } catch (error) {
    console.error("[demo-requests] Error:", error.message, error);
    return response.status(500).json({ error: "Could not save request" });
  }
};

// api/demo-requests.js
// Saves a demo request and sends a WhatsApp notification to the business owner.
const { neon } = require("@neondatabase/serverless");

// Send a WhatsApp message via Meta Cloud API
async function sendWhatsApp(to, body) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId     = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion  = process.env.WHATSAPP_API_VERSION || "v19.0";

  if (!accessToken || !phoneId) {
    console.warn("[demo-requests] WhatsApp env vars missing — skipping notification");
    return;
  }

  const res = await fetch(
    `https://graph.facebook.com/${apiVersion}/${phoneId}/messages`,
    {
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
    }
  );

  if (!res.ok) {
    const txt = await res.text();
    console.error("[demo-requests] WhatsApp send failed:", res.status, txt);
  } else {
    console.log("[demo-requests] WhatsApp notification sent to", to);
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
    // Only if they provided a WhatsApp number
    if (whatsappNumber) {
      const customerNumber = whatsappNumber.replace(/\D/g, ""); // strip non-digits
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

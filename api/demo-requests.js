// api/demo-requests.js
// Saves a demo request and sends WhatsApp notifications.
// Uses Node's built-in https module instead of fetch for reliability.

const https   = require("https");
const { neon } = require("@neondatabase/serverless");

// Send a WhatsApp message via Meta Cloud API using https module
function sendWhatsApp(to, messageBody) {
  return new Promise((resolve) => {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId     = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const apiVersion  = process.env.WHATSAPP_API_VERSION || "v19.0";

    console.log("[demo-requests][WA] Sending to:", to);
    console.log("[demo-requests][WA] Token present:", !!accessToken);
    console.log("[demo-requests][WA] Phone ID:", phoneId);

    if (!accessToken || !phoneId) {
      console.error("[demo-requests][WA] Missing env vars — cannot send");
      return resolve({ ok: false, error: "missing env vars" });
    }

    const payload = JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: messageBody },
    });

    const options = {
      hostname: "graph.facebook.com",
      path:     `/${apiVersion}/${phoneId}/messages`,
      method:   "POST",
      headers: {
        "Authorization":  `Bearer ${accessToken}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    console.log("[demo-requests][WA] POST", options.hostname + options.path);

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log("[demo-requests][WA] Sent successfully. Status:", res.statusCode);
          console.log("[demo-requests][WA] Response:", data);
          resolve({ ok: true });
        } else {
          console.error("[demo-requests][WA] Failed. Status:", res.statusCode);
          console.error("[demo-requests][WA] Response:", data);
          resolve({ ok: false, status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", (err) => {
      console.error("[demo-requests][WA] HTTPS request error:", err.message);
      console.error(err);
      resolve({ ok: false, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

// Normalize phone number to E.164 digits (no + or spaces)
function normalizeNumber(raw) {
  const digits = String(raw).replace(/\D/g, "");
  // Bare 10-digit Indian number — prefix with 91
  if (digits.length === 10 && !digits.startsWith("1")) {
    return "91" + digits;
  }
  return digits;
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
    console.log("[demo-requests] Saved:", name, businessName, whatsappNumber);

    // ── 2. Notify owner ───────────────────────────────────────────────────
    const ownerNumber = process.env.OWNER_WHATSAPP_NUMBER;
    if (ownerNumber) {
      const ownerMsg =
        `🔔 *New Demo Request on CoolCare!*\n\n` +
        `👤 Name: ${name}\n` +
        `🏢 Business: ${businessName || "—"}\n` +
        `📱 WhatsApp: ${whatsappNumber || "—"}\n\n` +
        `Reply to them soon!`;
      const result = await sendWhatsApp(ownerNumber, ownerMsg);
      console.log("[demo-requests] Owner notify result:", JSON.stringify(result));
    } else {
      console.warn("[demo-requests] OWNER_WHATSAPP_NUMBER not set — owner not notified");
    }

    // ── 3. Confirm to submitter ───────────────────────────────────────────
    if (whatsappNumber) {
      const customerNumber = normalizeNumber(whatsappNumber);
      const confirmMsg =
        `Hi ${name}! 👋\n\n` +
        `Thanks for your interest in *CoolCare*.\n` +
        `We've received your demo request for *${businessName || "your business"}* and will reach out to you shortly.\n\n` +
        `Talk soon! 🙏\n— CoolCare Team`;
      const result = await sendWhatsApp(customerNumber, confirmMsg);
      console.log("[demo-requests] Customer confirm result:", JSON.stringify(result));
    }

    return response.status(200).json({ saved: true });
  } catch (error) {
    console.error("[demo-requests] Error:", error.message, error);
    return response.status(500).json({ error: "Could not save request" });
  }
};

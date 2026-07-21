// CoolCare's first WhatsApp reply endpoint.
// Secrets are read from Vercel Environment Variables — never put them in this file.

module.exports = async (request, response) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  // Meta sends this once to confirm that the webhook URL belongs to us.
  if (request.method === "GET") {
    const mode = request.query["hub.mode"];
    const token = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];

    if (mode === "subscribe" && token === verifyToken) {
      return response.status(200).send(challenge);
    }

    return response.status(403).send("Webhook verification failed");
  }

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  try {
    const change = request.body?.entry?.[0]?.changes?.[0]?.value;
    const incomingMessage = change?.messages?.[0];
    const phoneNumberId = change?.metadata?.phone_number_id;

    // Delivery receipts and other WhatsApp events do not need a response.
    if (!incomingMessage || incomingMessage.type !== "text") {
      return response.status(200).json({ received: true });
    }

    const customerNumber = incomingMessage.from;
    const customerText = incomingMessage.text?.body?.trim() || "";
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const apiVersion = process.env.WHATSAPP_API_VERSION;

    if (!accessToken || !apiVersion || !phoneNumberId) {
      console.error("WhatsApp environment variables are not configured.");
      return response.status(500).json({ error: "WhatsApp is not configured" });
    }

    const reply = customerText.toLowerCase().includes("ac")
      ? "Thanks for contacting CoolCare. I can help book an AC service visit. Please reply with your area and whether there is water leakage."
      : "Welcome to CoolCare. Please tell us what AC issue you are facing and your area, and we will help book a technician.";

    const metaResponse = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: customerNumber,
          type: "text",
          text: { body: reply }
        })
      }
    );

    if (!metaResponse.ok) {
      console.error("Meta send failed:", await metaResponse.text());
      return response.status(502).json({ error: "Could not send WhatsApp reply" });
    }

    return response.status(200).json({ replied: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return response.status(500).json({ error: "Unexpected webhook error" });
  }
};

// CoolCare's WhatsApp reply endpoint — now powered by Groq instead of canned replies.
// Secrets are read from Vercel Environment Variables — never put them in this file.

const SYSTEM_PROMPT = `You are CoolCare's WhatsApp assistant for an AC service and repair business.

Your job in every reply:
- Figure out what's wrong with the customer's AC (no cooling, water leakage, installation, AMC/service, noise, etc.)
- Get their area/locality so a technician can be assigned.
- Get urgency (today, this week, no rush).
- Once you have issue + area, confirm you're booking a technician and ask if a time like "today evening" or "tomorrow morning" works.

Rules:
- Keep replies short — 1 to 3 sentences, WhatsApp style, no long paragraphs.
- Ask only ONE question at a time, never a checklist.
- Reply in the same language/style the customer used (Hindi, Telugu, Hinglish, English — mirror them).
- Never invent technician names, prices, or exact appointment times — only say a technician will be assigned or confirmed.
- If the message isn't about AC service at all, politely redirect to how you can help with AC issues.`;

async function getGroqReply(customerText) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.error("GROQ_API_KEY is not configured.");
    return "Thanks for messaging CoolCare — we'll get back to you shortly about your AC service request.";
  }

  try {
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: customerText }
        ],
        temperature: 0.4,
        max_tokens: 200
      })
    });

    if (!groqResponse.ok) {
      console.error("Groq request failed:", await groqResponse.text());
      return "Thanks for messaging CoolCare — we'll get back to you shortly about your AC service request.";
    }

    const data = await groqResponse.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    return reply || "Thanks for messaging CoolCare — could you tell us what AC issue you're facing and your area?";
  } catch (error) {
    console.error("Groq call error:", error);
    return "Thanks for messaging CoolCare — we'll get back to you shortly about your AC service request.";
  }
}

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

    // Ask Groq for a reply based on this message.
    // NOTE: this call has no memory of earlier messages yet — each reply is generated
    // fresh from just the latest message. Conversation history is the next step.
    const reply = await getGroqReply(customerText);

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
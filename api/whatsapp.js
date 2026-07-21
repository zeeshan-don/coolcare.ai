const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

const SERVICES_OFFERED = ["AC", "Refrigerator", "Washing Machine", "Microwave", "Mixer", "Chimney", "Induction Cooktop", "Water Purifier", "Electrical works"];

const SYSTEM_PROMPT = `You are CoolCare's WhatsApp assistant for a home appliance repair business.
This shop repairs: ${SERVICES_OFFERED.join(", ")}. Do not offer to help with anything outside this list —
if a customer asks about something else, politely say this shop doesn't handle that.

Your job across the conversation:
- Figure out which appliance the issue is about (must be one of: ${SERVICES_OFFERED.join(", ")}).
- Figure out what's wrong with it.
- Get their area/locality so a technician can be assigned.
- Get urgency (today, this week, no rush).
- You have the full conversation history — do NOT ask for something already given earlier in this chat.

You must ALWAYS reply with ONLY a valid JSON object, no other text, in this exact shape:
{
  "reply": "short WhatsApp-style message, 1-3 sentences",
  "service_type": "one of [${SERVICES_OFFERED.join(", ")}] or null",
  "area": "area/locality text or null",
  "urgency": "today | this week | no rush | null",
  "ready_to_book": true or false (true ONLY once service_type, area, and urgency are ALL known)
}

Rules:
- Short, WhatsApp style, 1-3 sentences.
- Ask only ONE question at a time.
- Analyze the problem and reply based on that.
- Don't mix up the problems of one appliance to the other.
- Reply politely and be very kind natured.
- The customer should feel happy by using you as ai assistant and call you back again.
- Reply in the same language/style the customer used.
- Never invent technician names, prices, or exact times.
- Once ready_to_book is true, the reply should confirm a technician is being assigned.`;

async function getConversationHistory(customerNumber) {
  const rows = await sql`
    SELECT role, message FROM conversations
    WHERE customer_number = ${customerNumber}
    ORDER BY created_at ASC LIMIT 20
  `;
  return rows.map((r) => ({ role: r.role === "bot" ? "assistant" : "user", content: r.message }));
}

async function saveMessage(customerNumber, role, message) {
  await sql`INSERT INTO conversations (customer_number, role, message) VALUES (${customerNumber}, ${role}, ${message})`;
}

async function hasOpenBooking(customerNumber) {
  const rows = await sql`SELECT id FROM bookings WHERE customer_number = ${customerNumber} AND status = 'open' LIMIT 1`;
  return rows.length > 0;
}

async function assignTechnician(serviceType) {
  const rows = await sql`
    SELECT t.id, t.name FROM technicians t
    WHERE t.active = true AND ${serviceType} = ANY(t.services)
    ORDER BY (SELECT COUNT(*) FROM bookings b WHERE b.technician_id = t.id) ASC
    LIMIT 1
  `;
  return rows[0] || null;
}

async function createBooking(customerNumber, serviceType, area, urgency) {
  const technician = await assignTechnician(serviceType);
  await sql`
    INSERT INTO bookings (customer_number, service_type, area, urgency, status, technician_id)
    VALUES (${customerNumber}, ${serviceType}, ${area}, ${urgency}, ${technician ? "assigned" : "open"}, ${technician ? technician.id : null})
  `;
  return technician;
}

async function getGroqReply(customerNumber, customerText) {
  const groqKey = process.env.GROQ_API_KEY;
  const fallback = { reply: "Thanks for messaging CoolCare — we'll get back to you shortly.", service_type: null, area: null, urgency: null, ready_to_book: false };
  if (!groqKey) { console.error("GROQ_API_KEY missing."); return fallback; }

  try {
    const history = await getConversationHistory(customerNumber);
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: customerText }],
        temperature: 0.3,
        max_tokens: 250,
        response_format: { type: "json_object" }
      })
    });
    if (!res.ok) { console.error("Groq failed:", await res.text()); return fallback; }
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
    return { ...fallback, ...parsed };
  } catch (error) {
    console.error("Groq call error:", error);
    return fallback;
  }
}

module.exports = async (request, response) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (request.method === "GET") {
    const mode = request.query["hub.mode"];
    const token = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];
    if (mode === "subscribe" && token === verifyToken) return response.status(200).send(challenge);
    return response.status(403).send("Webhook verification failed");
  }

  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed" });

  try {
    const change = request.body?.entry?.[0]?.changes?.[0]?.value;
    const incomingMessage = change?.messages?.[0];
    const phoneNumberId = change?.metadata?.phone_number_id;

    if (!incomingMessage || incomingMessage.type !== "text") return response.status(200).json({ received: true });

    const customerNumber = incomingMessage.from;
    const customerText = incomingMessage.text?.body?.trim() || "";
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const apiVersion = process.env.WHATSAPP_API_VERSION;

    if (!accessToken || !apiVersion || !phoneNumberId) {
      console.error("WhatsApp env vars missing.");
      return response.status(500).json({ error: "WhatsApp is not configured" });
    }

    await saveMessage(customerNumber, "customer", customerText);

    const result = await getGroqReply(customerNumber, customerText);
    let replyText = result.reply;

    const alreadyBooked = await hasOpenBooking(customerNumber);
    if (result.ready_to_book && !alreadyBooked && result.service_type && result.area && result.urgency) {
      const technician = await createBooking(customerNumber, result.service_type, result.area, result.urgency);
      if (technician) {
        replyText += ` A technician has been assigned for your ${result.service_type} issue in ${result.area}.`;
      }
    }

    await saveMessage(customerNumber, "bot", replyText);

    const metaResponse = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: customerNumber, type: "text", text: { body: replyText } })
    });

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

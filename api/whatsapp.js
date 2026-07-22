// CoolCare's WhatsApp reply endpoint — powered by Groq, with conversation memory in Neon.
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

const SYSTEM_PROMPT = `You are CoolCare's WhatsApp assistant for a home appliance service and repair business.

Appliances you handle: AC, refrigerator, washing machine, geyser/water heater, microwave, TV, RO/water purifier, dishwasher, air cooler, ceiling/table fan, and all other electrical home appliances.

Your job across the conversation:
- First, find out WHICH appliance has the problem.
- Then figure out what's wrong with it (e.g. AC — no cooling, water leakage, noise; Refrigerator — not cooling, ice buildup, compressor noise; Geyser — no hot water, leaking, not switching on; Washing Machine — not spinning, water not draining, error code; etc.)
- Get their name.
- Get their exact address (house/flat number, street, locality) — not just area.
- Get their area/locality so a technician can be assigned.
- Get urgency (today, this week, no rush).
- Once you have name + appliance + issue + address + area, confirm you're booking a technician and ask if a time like "today evening" or "tomorrow morning" works.
- You have the full conversation history below — do NOT ask for something the customer already told you earlier in this chat.

Rules:
- Keep replies short — 1 to 3 sentences, WhatsApp style, no long paragraphs.
- Ask only ONE question at a time, never a checklist.
- Reply in the same language/style the customer used (Hindi, Telugu, Hinglish, English — mirror them).
- Never invent technician names, prices, or exact appointment times — only say a technician will be assigned or confirmed.
- If the message is not about any home appliance repair or service, politely say you handle home appliance repairs and ask how you can help.`;

const EXTRACTION_PROMPT = `You extract structured booking details from a customer support chat about home appliance repair.
Return ONLY a JSON object, nothing else, in this exact shape:
{"name": string|null, "address": string|null, "area": string|null, "service_type": string|null, "urgency": string|null, "ready_to_book": boolean}

Rules:
- Fill a field only if the customer clearly stated it anywhere in the conversation.
- "service_type" is a short label that includes the appliance and issue, e.g. "AC no cooling", "Refrigerator not cooling", "Geyser no hot water", "Washing machine not spinning", "TV no display", "RO not working", "Fan not working", "Microwave not heating".
- "ready_to_book" is true once you have at least service_type AND area.
- Return valid JSON only — no markdown fences, no explanation.`;

async function getConversationHistory(customerNumber) {
  const rows = await sql`
    SELECT role, message FROM conversations
    WHERE customer_number = ${customerNumber}
    ORDER BY created_at ASC
    LIMIT 20
  `;
  return rows.map((row) => ({
    role: row.role === "bot" ? "assistant" : "user",
    content: row.message
  }));
}

async function saveMessage(customerNumber, role, message) {
  await sql`
    INSERT INTO conversations (customer_number, role, message)
    VALUES (${customerNumber}, ${role}, ${message})
  `;
}

async function callGroq(messages, jsonMode = false) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return null;

  const body = {
    model: "llama-3.3-70b-versatile",
    messages,
    temperature: jsonMode ? 0 : 0.4,
    max_tokens: jsonMode ? 300 : 200
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    console.error("Groq request failed:", await res.text());
    return null;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

async function getGroqReply(history, customerText) {
  const reply = await callGroq([
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: customerText }
  ]);
  return reply || "Thanks for messaging CoolCare! 👋 We repair AC, refrigerator, geyser, washing machine, microwave, TV, fan, RO, and all home appliances. Which appliance needs service, and what's the issue?";
}

async function extractAndSaveBooking(customerNumber, history, customerText) {
  try {
    const raw = await callGroq(
      [
        { role: "system", content: EXTRACTION_PROMPT },
        ...history,
        { role: "user", content: customerText }
      ],
      true
    );
    if (!raw) return;

    const info = JSON.parse(raw);
    if (!info.service_type && !info.area) return; // nothing useful yet

    const existing = await sql`
      SELECT id, technician_id FROM bookings
      WHERE customer_number = ${customerNumber} AND status IN ('open', 'assigned')
      ORDER BY created_at DESC LIMIT 1
    `;

    let bookingId;
    if (existing.length > 0) {
      await sql`
        UPDATE bookings SET
          customer_name = COALESCE(${info.name}, customer_name),
          address = COALESCE(${info.address}, address),
          service_type = COALESCE(${info.service_type}, service_type),
          area = COALESCE(${info.area}, area),
          urgency = COALESCE(${info.urgency}, urgency)
        WHERE id = ${existing[0].id}
      `;
      bookingId = existing[0].id;
    } else {
      const inserted = await sql`
        INSERT INTO bookings (customer_number, customer_name, address, service_type, area, urgency, status)
        VALUES (${customerNumber}, ${info.name}, ${info.address}, ${info.service_type}, ${info.area}, ${info.urgency}, 'open')
        RETURNING id
      `;
      bookingId = inserted[0].id;
    }

    // Auto-assign a technician once we know enough
    if (info.ready_to_book && info.service_type) {
      const techs = await sql`
        SELECT id FROM technicians
        WHERE active = true AND ${info.service_type} = ANY(services)
        LIMIT 1
      `;
      if (techs.length > 0) {
        await sql`
          UPDATE bookings SET technician_id = ${techs[0].id}, status = 'assigned'
          WHERE id = ${bookingId} AND technician_id IS NULL
        `;
      }
    }
  } catch (error) {
    // Extraction is best-effort — never let it break the customer's actual reply
    console.error("Booking extraction error:", error);
  }
}

module.exports = async (request, response) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

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

    await saveMessage(customerNumber, "customer", customerText);
    const history = await getConversationHistory(customerNumber);

    const [reply] = await Promise.all([
      getGroqReply(history, customerText),
      extractAndSaveBooking(customerNumber, history, customerText)
    ]);

    await saveMessage(customerNumber, "bot", reply);

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
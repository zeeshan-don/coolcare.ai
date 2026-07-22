// CoolCare WhatsApp bot — structured state management
// State is stored in DB (conversation_state table), NOT inferred from raw history.
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

// ─── Steps in order ──────────────────────────────────────────────────────────
const STEPS = ["appliance", "issue", "name", "address", "area", "urgency", "confirm"];

// ─── What to ask at each step ────────────────────────────────────────────────
const STEP_QUESTIONS = {
  appliance: "Hi! 👋 Welcome to CoolCare. Which appliance needs repair? (AC, refrigerator, geyser, washing machine, microwave, TV, RO, fan, etc.)",
  issue:     (state) => `What's the problem with your ${state.appliance}?`,
  name:      "Got it! May I know your name?",
  address:   (state) => `Thanks ${state.customer_name}! Please share your full address (flat/house number, street, locality).`,
  area:      "Which area or locality are you in? (So we can assign the nearest technician.)",
  urgency:   "When do you need the service? (Today, tomorrow, this week, or no rush?)",
  confirm:   (state) =>
    `Here's your booking summary:\n` +
    `• Appliance: ${state.appliance}\n` +
    `• Issue: ${state.issue}\n` +
    `• Name: ${state.customer_name}\n` +
    `• Address: ${state.address}, ${state.area}\n` +
    `• When: ${state.urgency}\n\n` +
    `Shall I confirm this booking? Reply *Yes* to confirm or *No* to cancel.`
};

// ─── Load state from DB ───────────────────────────────────────────────────────
async function loadState(customerNumber) {
  const rows = await sql`
    SELECT * FROM conversation_state
    WHERE customer_number = ${customerNumber}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rows[0];
}

// ─── Save / update state ──────────────────────────────────────────────────────
async function saveState(customerNumber, updates) {
  const existing = await sql`
    SELECT id FROM conversation_state WHERE customer_number = ${customerNumber}
  `;
  if (existing.length > 0) {
    await sql`
      UPDATE conversation_state SET
        step          = COALESCE(${updates.step          ?? null}, step),
        appliance     = COALESCE(${updates.appliance     ?? null}, appliance),
        issue         = COALESCE(${updates.issue         ?? null}, issue),
        customer_name = COALESCE(${updates.customer_name ?? null}, customer_name),
        address       = COALESCE(${updates.address       ?? null}, address),
        area          = COALESCE(${updates.area          ?? null}, area),
        urgency       = COALESCE(${updates.urgency       ?? null}, urgency),
        updated_at    = now()
      WHERE customer_number = ${customerNumber}
    `;
  } else {
    await sql`
      INSERT INTO conversation_state
        (customer_number, step, appliance, issue, customer_name, address, area, urgency)
      VALUES
        (${customerNumber},
         ${updates.step          ?? "appliance"},
         ${updates.appliance     ?? null},
         ${updates.issue         ?? null},
         ${updates.customer_name ?? null},
         ${updates.address       ?? null},
         ${updates.area          ?? null},
         ${updates.urgency       ?? null})
    `;
  }
}

// ─── Reset state (new session) ────────────────────────────────────────────────
async function resetState(customerNumber) {
  await sql`DELETE FROM conversation_state WHERE customer_number = ${customerNumber}`;
}

// ─── Save chat message ────────────────────────────────────────────────────────
async function saveMessage(customerNumber, role, message) {
  await sql`
    INSERT INTO conversations (customer_number, role, message)
    VALUES (${customerNumber}, ${role}, ${message})
  `;
}

// ─── Use LLM only for natural language extraction, never for logic ────────────
async function callGroq(messages, jsonMode = false) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return null;

  const body = {
    model: "llama-3.3-70b-versatile",
    messages,
    temperature: 0,
    max_tokens: jsonMode ? 150 : 100
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

// ─── Extract a single field from one user message ────────────────────────────
// LLM is ONLY used to normalize free text. Business logic stays in code.
async function extractField(step, userText, state) {
  const prompts = {
    appliance: `The user said: "${userText}"
Extract the home appliance they want repaired. Reply with ONLY a JSON object: {"value": "appliance name or null"}
Use a clean name like: AC, Refrigerator, Geyser, Washing Machine, Microwave, TV, RO, Fan, Dishwasher, Air Cooler.
If no appliance is mentioned, return {"value": null}.`,

    issue: `The user said: "${userText}"
They have a ${state.appliance}. What is the problem/issue they described?
Reply with ONLY a JSON: {"value": "short issue description or null"}
Examples: "Not cooling", "Water leaking", "Not heating", "Making noise", "Not turning on".
If no issue is clearly stated, return {"value": null}.`,

    name: `The user said: "${userText}"
Extract the person's name. Reply with ONLY a JSON: {"value": "name or null"}
If no name is mentioned, return {"value": null}.`,

    address: `The user said: "${userText}"
Extract the full address (house/flat number, street, locality). Reply with ONLY a JSON: {"value": "address or null"}
If no address is mentioned, return {"value": null}.`,

    area: `The user said: "${userText}"
Extract the area, locality, or neighborhood name. Reply with ONLY a JSON: {"value": "area name or null"}
If no area is mentioned, return {"value": null}.`,

    urgency: `The user said: "${userText}"
Extract the urgency or preferred time for service. Reply with ONLY a JSON: {"value": "urgency or null"}
Examples: "Today", "Tomorrow", "This week", "No rush", "Today evening", "Tomorrow morning".
If not mentioned, return {"value": null}.`
  };

  const prompt = prompts[step];
  if (!prompt) return null;

  try {
    const raw = await callGroq(
      [{ role: "user", content: prompt }],
      true
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.value || null;
  } catch {
    return null;
  }
}

// ─── Format a step question ───────────────────────────────────────────────────
function getQuestion(step, state) {
  const q = STEP_QUESTIONS[step];
  return typeof q === "function" ? q(state) : q;
}

// ─── Create booking in DB ─────────────────────────────────────────────────────
async function createBooking(customerNumber, state) {
  try {
    const inserted = await sql`
      INSERT INTO bookings
        (customer_number, customer_name, address, service_type, area, urgency, status)
      VALUES
        (${customerNumber},
         ${state.customer_name},
         ${state.address + ", " + state.area},
         ${state.appliance + " — " + state.issue},
         ${state.area},
         ${state.urgency},
         'open')
      RETURNING id
    `;
    const bookingId = inserted[0].id;

    // Try to assign a technician by matching appliance name (case-insensitive)
    const techs = await sql`
      SELECT id FROM technicians
      WHERE active = true
        AND EXISTS (
          SELECT 1 FROM unnest(services) s
          WHERE lower(s) LIKE lower(${"%" + state.appliance + "%"})
        )
      LIMIT 1
    `;
    if (techs.length > 0) {
      await sql`
        UPDATE bookings SET technician_id = ${techs[0].id}, status = 'assigned'
        WHERE id = ${bookingId}
      `;
    }
    return bookingId;
  } catch (err) {
    console.error("Booking creation error:", err);
    return null;
  }
}

// ─── Main message handler ─────────────────────────────────────────────────────
async function handleMessage(customerNumber, userText) {
  const text = userText.trim();
  const lowerText = text.toLowerCase();

  // Allow user to reset conversation at any time
  if (
    lowerText.includes("reset") ||
    lowerText.includes("start over") ||
    lowerText.includes("new complaint") ||
    lowerText.includes("forget") ||
    lowerText.includes("cancel")
  ) {
    await resetState(customerNumber);
    return "Sure! Let's start fresh. 👋 Which appliance needs repair? (AC, refrigerator, geyser, washing machine, microwave, TV, RO, fan, etc.)";
  }

  let state = await loadState(customerNumber);

  // New conversation
  if (!state) {
    await saveState(customerNumber, { step: "appliance" });
    state = await loadState(customerNumber);
    return getQuestion("appliance", state);
  }

  const currentStep = state.step;

  // ── Confirmation step ────────────────────────────────────────────────────
  if (currentStep === "confirm") {
    if (lowerText === "yes" || lowerText === "y" || lowerText.includes("confirm") || lowerText.includes("ok")) {
      const bookingId = await createBooking(customerNumber, state);
      await resetState(customerNumber); // clear state after booking
      if (bookingId) {
        return `✅ Booking confirmed! (Ref #${bookingId})\nA CoolCare technician will be assigned for your ${state.appliance} repair (${state.issue}).\nWe'll contact you at this number to confirm the visit time. 🙏`;
      } else {
        return `✅ Booking received! A CoolCare technician will be assigned for your ${state.appliance} repair. We'll contact you shortly. 🙏`;
      }
    } else if (lowerText === "no" || lowerText === "n" || lowerText.includes("cancel")) {
      await resetState(customerNumber);
      return "No problem! Your booking has been cancelled. Type anything to start a new request. 👍";
    } else {
      // They said something else — re-ask
      return `Please reply *Yes* to confirm or *No* to cancel your booking.`;
    }
  }

  // ── All other steps: extract the field, move to next step ───────────────
  const extracted = await extractField(currentStep, text, state);

  if (!extracted) {
    // Couldn't extract — re-ask with a gentle nudge
    const retryMessages = {
      appliance: `I didn't catch which appliance. Could you tell me which one needs repair? (e.g. AC, Geyser, Refrigerator, Washing Machine…)`,
      issue:     `Could you describe the problem with your ${state.appliance}? (e.g. not cooling, water leaking, not turning on…)`,
      name:      `Could you share your name please?`,
      address:   `Please share your full address including flat/house number, street and locality.`,
      area:      `Which area or locality are you in?`,
      urgency:   `When would you like the service? (Today, tomorrow, this week…)`
    };
    return retryMessages[currentStep] || getQuestion(currentStep, state);
  }

  // Save the extracted value for this step
  const fieldMap = {
    appliance:  "appliance",
    issue:      "issue",
    name:       "customer_name",
    address:    "address",
    area:       "area",
    urgency:    "urgency"
  };
  const fieldName = fieldMap[currentStep];
  const nextStep = STEPS[STEPS.indexOf(currentStep) + 1];

  await saveState(customerNumber, {
    [fieldName]: extracted,
    step: nextStep
  });

  // Reload state so next question has all filled values
  const updatedState = await loadState(customerNumber);

  return getQuestion(nextStep, updatedState);
}

// ─── Webhook handler ──────────────────────────────────────────────────────────
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

    // Save customer message BEFORE handling (for audit log only — NOT fed back to LLM)
    await saveMessage(customerNumber, "customer", customerText);

    const reply = await handleMessage(customerNumber, customerText);

    // Save bot reply for audit log
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

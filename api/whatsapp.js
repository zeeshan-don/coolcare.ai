// CoolCare WhatsApp bot — full state machine with out-of-flow Q&A, BOOKED state, modifications
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

// ─── State machine statuses ───────────────────────────────────────────────────
const STATUS = {
  COLLECTING_APPLIANCE : "COLLECTING_APPLIANCE",
  COLLECTING_ISSUE     : "COLLECTING_ISSUE",
  COLLECTING_NAME      : "COLLECTING_NAME",
  COLLECTING_ADDRESS   : "COLLECTING_ADDRESS",
  COLLECTING_LOCALITY  : "COLLECTING_LOCALITY",
  COLLECTING_DATE      : "COLLECTING_DATE",
  CONFIRMATION_PENDING : "CONFIRMATION_PENDING",
  BOOKED               : "BOOKED",
  CANCELLED            : "CANCELLED",
};

// Ordered steps used during collection phase
const COLLECTION_STEPS = [
  STATUS.COLLECTING_APPLIANCE,
  STATUS.COLLECTING_ISSUE,
  STATUS.COLLECTING_NAME,
  STATUS.COLLECTING_ADDRESS,
  STATUS.COLLECTING_LOCALITY,
  STATUS.COLLECTING_DATE,
  STATUS.CONFIRMATION_PENDING,
];

// Field name in DB that each status collects
const STEP_FIELD = {
  [STATUS.COLLECTING_APPLIANCE] : "appliance",
  [STATUS.COLLECTING_ISSUE]     : "issue",
  [STATUS.COLLECTING_NAME]      : "customer_name",
  [STATUS.COLLECTING_ADDRESS]   : "address",
  [STATUS.COLLECTING_LOCALITY]  : "area",
  [STATUS.COLLECTING_DATE]      : "urgency",
};

// Static or dynamic prompt per step
const STEP_QUESTION = {
  [STATUS.COLLECTING_APPLIANCE] : () =>
    "Hi! 👋 Welcome to CoolCare. Which appliance needs repair?\n(AC, Refrigerator, Geyser, Washing Machine, Microwave, TV, RO, Fan, etc.)",
  [STATUS.COLLECTING_ISSUE]     : (s) => `What's the problem with your ${s.appliance}?`,
  [STATUS.COLLECTING_NAME]      : () => "Got it! May I know your name?",
  [STATUS.COLLECTING_ADDRESS]   : (s) => `Thanks ${s.customer_name}! Please share your full address (flat/house no., street, locality).`,
  [STATUS.COLLECTING_LOCALITY]  : () => "Which area or locality are you in? (Helps us assign the nearest technician.)",
  [STATUS.COLLECTING_DATE]      : () => "When do you need the service? (Today, tomorrow, this week, or no rush?)",
  [STATUS.CONFIRMATION_PENDING] : (s) =>
    `Here's your booking summary:\n` +
    `• Appliance: ${s.appliance}\n` +
    `• Issue: ${s.issue}\n` +
    `• Name: ${s.customer_name}\n` +
    `• Address: ${s.address}, ${s.area}\n` +
    `• When: ${s.urgency}\n\n` +
    `Shall I confirm this booking? Reply *Yes* to confirm or *No* to cancel.`,
};

function askStep(status, state) {
  const fn = STEP_QUESTION[status];
  return fn ? fn(state) : "Could you please continue?";
}

// ─── DB: load state ───────────────────────────────────────────────────────────
async function loadState(customerNumber) {
  const rows = await sql`
    SELECT * FROM conversation_state
    WHERE customer_number = ${customerNumber}
    LIMIT 1
  `;
  return rows.length ? rows[0] : null;
}

// ─── DB: save / upsert state ──────────────────────────────────────────────────
async function saveState(customerNumber, updates) {
  const exists = await sql`
    SELECT id FROM conversation_state WHERE customer_number = ${customerNumber}
  `;
  if (exists.length > 0) {
    await sql`
      UPDATE conversation_state SET
        status        = COALESCE(${updates.status        ?? null}, status),
        appliance     = COALESCE(${updates.appliance     ?? null}, appliance),
        issue         = COALESCE(${updates.issue         ?? null}, issue),
        customer_name = COALESCE(${updates.customer_name ?? null}, customer_name),
        address       = COALESCE(${updates.address       ?? null}, address),
        area          = COALESCE(${updates.area          ?? null}, area),
        urgency       = COALESCE(${updates.urgency       ?? null}, urgency),
        booking_id    = COALESCE(${updates.booking_id    ?? null}, booking_id),
        updated_at    = now()
      WHERE customer_number = ${customerNumber}
    `;
  } else {
    await sql`
      INSERT INTO conversation_state
        (customer_number, status, appliance, issue, customer_name, address, area, urgency, booking_id)
      VALUES
        (${customerNumber},
         ${updates.status        ?? STATUS.COLLECTING_APPLIANCE},
         ${updates.appliance     ?? null},
         ${updates.issue         ?? null},
         ${updates.customer_name ?? null},
         ${updates.address       ?? null},
         ${updates.area          ?? null},
         ${updates.urgency       ?? null},
         ${updates.booking_id    ?? null})
    `;
  }
}

// ─── DB: hard reset (new booking intent) ─────────────────────────────────────
async function resetState(customerNumber) {
  await sql`DELETE FROM conversation_state WHERE customer_number = ${customerNumber}`;
}

// ─── DB: overwrite a specific field (for modifications) ──────────────────────
async function forceUpdateState(customerNumber, field, value) {
  // Only allow known safe field names to prevent SQL injection
  const allowed = ["appliance", "issue", "customer_name", "address", "area", "urgency", "status", "booking_id"];
  if (!allowed.includes(field)) return;
  // Use a map so we can pass a dynamic column safely
  await saveState(customerNumber, { [field]: value });
}

// ─── DB: save message to audit log ───────────────────────────────────────────
async function saveMessage(customerNumber, role, message) {
  await sql`
    INSERT INTO conversations (customer_number, role, message)
    VALUES (${customerNumber}, ${role}, ${message})
  `;
}


// ─── LLM: base caller ─────────────────────────────────────────────────────────
async function callGroq(messages, jsonMode = false, maxTokens = 200) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return null;

  const body = {
    model: "llama-3.3-70b-versatile",
    messages,
    temperature: jsonMode ? 0 : 0.4,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error("Groq error:", await res.text());
    return null;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

// ─── LLM: classify what the user's message is ────────────────────────────────
// Returns one of: "answer_field" | "out_of_flow_question" | "confirm_yes" |
//                 "confirm_no" | "modify_booking" | "new_booking" | "cancel_booking" | "thanks"
async function classifyIntent(userText, currentStatus, state) {
  const stateContext = `Current booking state:
- Status: ${currentStatus}
- Appliance: ${state?.appliance ?? "not yet collected"}
- Issue: ${state?.issue ?? "not yet collected"}
- Name: ${state?.customer_name ?? "not yet collected"}
- Address: ${state?.address ?? "not yet collected"}
- Area: ${state?.area ?? "not yet collected"}
- When: ${state?.urgency ?? "not yet collected"}`;

  const prompt = `You are classifying a WhatsApp message intent for a home appliance repair booking bot.

${stateContext}

User message: "${userText}"

Classify the intent as exactly ONE of these labels:
- "answer_field"         — The user is directly answering the current collection step (appliance name, issue, name, address, area, date)
- "out_of_flow_question" — The user is asking a question (price, warranty, timing, how it works, etc.) instead of answering the current step
- "confirm_yes"          — The user is confirming/agreeing (yes, ok, confirm, proceed, sure, haan, theek hai)
- "confirm_no"           — The user is declining/cancelling (no, nahi, don't want, cancel)
- "modify_booking"       — The user wants to change something in an existing booking (wrong appliance, change address, change date, etc.)
- "cancel_booking"       — The user explicitly wants to cancel their booking
- "new_booking"          — The user clearly wants to start a completely new/separate booking (reset, start over, new booking, book another)
- "thanks"               — The user is just saying thank you or goodbye

Reply with ONLY a JSON object: {"intent": "<label>"}`;

  try {
    const raw = await callGroq([{ role: "user", content: prompt }], true, 50);
    if (!raw) return "answer_field";
    const parsed = JSON.parse(raw);
    return parsed.intent || "answer_field";
  } catch {
    return "answer_field";
  }
}

// ─── LLM: extract a single field from a user message ─────────────────────────
async function extractField(step, userText, state) {
  const prompts = {
    [STATUS.COLLECTING_APPLIANCE]: `User said: "${userText}"
Extract the home appliance they want repaired.
Reply ONLY as JSON: {"value": "appliance or null"}
Use a clean label: AC, Refrigerator, Geyser, Washing Machine, Microwave, TV, RO, Fan, Dishwasher, Air Cooler.
If no appliance is clearly mentioned, return {"value": null}.`,

    [STATUS.COLLECTING_ISSUE]: `User said: "${userText}"
The appliance is: ${state.appliance}.
What problem/issue did they describe?
Reply ONLY as JSON: {"value": "short issue or null"}
Examples: "Not cooling", "Water leaking", "Not heating", "Making noise", "Not turning on", "Dirty water".
If no issue is clearly stated, return {"value": null}.`,

    [STATUS.COLLECTING_NAME]: `User said: "${userText}"
Extract the person's name.
Reply ONLY as JSON: {"value": "name or null"}
If no name is mentioned, return {"value": null}.`,

    [STATUS.COLLECTING_ADDRESS]: `User said: "${userText}"
Extract the full address (flat/house number, street, locality).
Reply ONLY as JSON: {"value": "address or null"}
If no address is mentioned, return {"value": null}.`,

    [STATUS.COLLECTING_LOCALITY]: `User said: "${userText}"
Extract the area, locality, or neighborhood.
Reply ONLY as JSON: {"value": "area or null"}
If not mentioned, return {"value": null}.`,

    [STATUS.COLLECTING_DATE]: `User said: "${userText}"
Extract the preferred service date/time.
Reply ONLY as JSON: {"value": "date preference or null"}
Examples: "Today", "Tomorrow", "This week", "No rush", "Today evening", "Tomorrow morning".
If not mentioned, return {"value": null}.`,
  };

  const prompt = prompts[step];
  if (!prompt) return null;

  try {
    const raw = await callGroq([{ role: "user", content: prompt }], true, 80);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.value || null;
  } catch {
    return null;
  }
}

// ─── LLM: answer an out-of-flow question, then re-ask the current step ───────
async function answerQuestion(userText, state, currentStatus) {
  const stepQuestion = askStep(currentStatus, state);
  const bookingContext = `The customer has an ongoing repair booking:
- Appliance: ${state?.appliance ?? "not yet provided"}
- Issue: ${state?.issue ?? "not yet provided"}
- Name: ${state?.customer_name ?? "not yet provided"}
- Address: ${state?.address ?? "not yet provided"}
- Area: ${state?.area ?? "not yet provided"}
- Preferred time: ${state?.urgency ?? "not yet provided"}`;

  const systemPrompt = `You are CoolCare's WhatsApp customer support assistant for home appliance repair (AC, refrigerator, geyser, washing machine, microwave, TV, RO, fan, etc.).

${bookingContext}

Rules:
- Keep replies short — 2 to 4 sentences, WhatsApp style.
- NEVER invent or quote specific prices. Pricing depends on the service partner, spare parts needed, and inspection findings. Always say the technician will provide an estimate after inspection.
- Never confirm a technician name or exact arrival time — only say one will be assigned.
- If asked about warranty, say it depends on the spare parts used and the service partner.
- If asked about cancellation, say they can cancel by replying "Cancel".
- Reply in the same language the customer used (Hindi, Hinglish, English, Telugu — mirror their style).
- After answering, end your reply by asking the current pending question again.

Current pending question you must re-ask at the end: "${stepQuestion}"`;

  const reply = await callGroq(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    false,
    250
  );

  return reply || `Good question! Our technician will be able to give you a full estimate after inspection. ${stepQuestion}`;
}

// ─── LLM: answer a question in BOOKED state ───────────────────────────────────
async function answerBookedQuestion(userText, state) {
  const systemPrompt = `You are CoolCare's WhatsApp customer support assistant for home appliance repair.

The customer already has a confirmed booking:
- Appliance: ${state.appliance}
- Issue: ${state.issue}
- Name: ${state.customer_name}
- Address: ${state.address}, ${state.area}
- When: ${state.urgency}
- Booking ID: ${state.booking_id ?? "pending"}

Rules:
- Keep replies short — 2 to 4 sentences, WhatsApp style.
- NEVER invent or quote specific prices. Always say the technician will provide an estimate after inspection.
- Never invent a technician name or exact arrival time.
- If asked about cancellation, tell them to reply "Cancel my booking".
- If asked about changing the date/address/appliance, tell them to say "Change <what they want to change>".
- Reply in the same language the customer used (Hindi, Hinglish, English — mirror their style).`;

  const reply = await callGroq(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    false,
    200
  );

  return reply || "Our team will contact you shortly to confirm the visit details. Is there anything else I can help you with?";
}

// ─── LLM: extract what the user wants to modify ──────────────────────────────
async function extractModification(userText, state) {
  const prompt = `A customer with an existing home appliance repair booking wants to change something.

Current booking:
- Appliance: ${state.appliance}
- Issue: ${state.issue}
- Address: ${state.address}
- Area: ${state.area}
- When: ${state.urgency}

User said: "${userText}"

What do they want to change? Reply ONLY as JSON:
{"field": "appliance|issue|address|area|urgency|null", "new_value": "the new value or null"}

Examples:
- "Actually it's a refrigerator" → {"field": "appliance", "new_value": "Refrigerator"}
- "Change address to 45 MG Road" → {"field": "address", "new_value": "45 MG Road"}
- "Make it tomorrow morning" → {"field": "urgency", "new_value": "Tomorrow morning"}
- "I meant AC, not geyser" → {"field": "appliance", "new_value": "AC"}
If nothing specific is identifiable, return {"field": null, "new_value": null}.`;

  try {
    const raw = await callGroq([{ role: "user", content: prompt }], true, 100);
    if (!raw) return { field: null, new_value: null };
    return JSON.parse(raw);
  } catch {
    return { field: null, new_value: null };
  }
}


// ─── Booking: create ──────────────────────────────────────────────────────────
async function createBooking(customerNumber, state) {
  try {
    const inserted = await sql`
      INSERT INTO bookings
        (customer_number, customer_name, address, service_type, area, urgency, status)
      VALUES
        (${customerNumber},
         ${state.customer_name},
         ${(state.address ?? "") + (state.area ? ", " + state.area : "")},
         ${(state.appliance ?? "") + (state.issue ? " — " + state.issue : "")},
         ${state.area},
         ${state.urgency},
         'open')
      RETURNING id
    `;
    const bookingId = inserted[0].id;

    // Assign technician by appliance name match
    const techs = await sql`
      SELECT id FROM technicians
      WHERE active = true
        AND EXISTS (
          SELECT 1 FROM unnest(services) s
          WHERE lower(s) LIKE lower(${"%" + (state.appliance ?? "") + "%"})
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
    console.error("createBooking error:", err);
    return null;
  }
}

// ─── Booking: cancel ──────────────────────────────────────────────────────────
async function cancelBooking(bookingId) {
  try {
    await sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${bookingId}`;
    return true;
  } catch (err) {
    console.error("cancelBooking error:", err);
    return false;
  }
}

// ─── Booking: modify a field in the bookings table ───────────────────────────
async function modifyBooking(bookingId, field, value) {
  try {
    // Map state field names to bookings column names
    const colMap = {
      appliance     : null,   // handled below as part of service_type
      issue         : null,   // handled below as part of service_type
      customer_name : "customer_name",
      address       : "address",
      area          : "area",
      urgency       : "urgency",
    };

    if (field === "appliance" || field === "issue") {
      // service_type is "Appliance — Issue", need to fetch current row first
      const rows = await sql`SELECT service_type FROM bookings WHERE id = ${bookingId}`;
      if (!rows.length) return false;
      const parts = (rows[0].service_type ?? " — ").split(" — ");
      const newAppliance = field === "appliance" ? value : parts[0];
      const newIssue     = field === "issue"     ? value : parts[1] ?? "";
      await sql`
        UPDATE bookings SET service_type = ${newAppliance + " — " + newIssue}
        WHERE id = ${bookingId}
      `;
    } else {
      const col = colMap[field];
      if (!col) return false;
      // Safe: col is from a known-safe map
      await sql`UPDATE bookings SET ${sql(col)} = ${value} WHERE id = ${bookingId}`;
    }
    return true;
  } catch (err) {
    console.error("modifyBooking error:", err);
    return false;
  }
}


// ─── Main message handler — full state machine ────────────────────────────────
async function handleMessage(customerNumber, userText) {
  const text      = userText.trim();
  const lowerText = text.toLowerCase();

  let state = await loadState(customerNumber);

  // ── No state yet — start fresh ─────────────────────────────────────────────
  if (!state) {
    await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE });
    return askStep(STATUS.COLLECTING_APPLIANCE, {});
  }

  const currentStatus = state.status;

  // ══════════════════════════════════════════════════════════════════════════
  // BOOKED state — session stays alive, answer questions, allow modifications
  // ══════════════════════════════════════════════════════════════════════════
  if (currentStatus === STATUS.BOOKED) {
    // Explicit new booking request
    if (
      lowerText.includes("new booking") ||
      lowerText.includes("book another") ||
      lowerText.includes("start over") ||
      lowerText.includes("reset")
    ) {
      await resetState(customerNumber);
      await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE });
      return "Sure! Let's create a new booking. 👋\n" + askStep(STATUS.COLLECTING_APPLIANCE, {});
    }

    // Explicit cancel request
    if (
      lowerText.includes("cancel") ||
      lowerText === "cancel my booking"
    ) {
      if (state.booking_id) {
        await cancelBooking(state.booking_id);
      }
      await saveState(customerNumber, { status: STATUS.CANCELLED });
      return `Your booking has been cancelled. 😔 If you need a repair in the future, just message us again! 👍`;
    }

    // Modification request
    const intent = await classifyIntent(text, currentStatus, state);
    if (intent === "modify_booking") {
      const mod = await extractModification(text, state);
      if (mod.field && mod.new_value) {
        // Update state
        await forceUpdateState(customerNumber, mod.field, mod.new_value);
        // Update bookings table if a booking record exists
        if (state.booking_id) {
          await modifyBooking(state.booking_id, mod.field, mod.new_value);
        }
        const reloadedState = await loadState(customerNumber);
        return (
          `✅ Updated! Your booking now shows:\n` +
          `• Appliance: ${reloadedState.appliance}\n` +
          `• Issue: ${reloadedState.issue}\n` +
          `• Address: ${reloadedState.address}, ${reloadedState.area}\n` +
          `• When: ${reloadedState.urgency}\n\n` +
          `Anything else you'd like to change?`
        );
      }
      return "I'd be happy to update your booking — could you be more specific? (e.g. 'Change address to 45 MG Road' or 'Change to tomorrow morning')";
    }

    // Thanks / goodbye
    if (intent === "thanks") {
      return "You're welcome! 😊 Our technician will be in touch soon. Have a great day! 🙏";
    }

    // Everything else — answer as a support question
    return await answerBookedQuestion(text, state);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CANCELLED state — offer to start fresh
  // ══════════════════════════════════════════════════════════════════════════
  if (currentStatus === STATUS.CANCELLED) {
    await resetState(customerNumber);
    await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE });
    return "Welcome back! 👋 Let's start a new booking.\n" + askStep(STATUS.COLLECTING_APPLIANCE, {});
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIRMATION_PENDING — waiting for Yes / No (but answer questions too)
  // ══════════════════════════════════════════════════════════════════════════
  if (currentStatus === STATUS.CONFIRMATION_PENDING) {
    const intent = await classifyIntent(text, currentStatus, state);

    if (intent === "confirm_yes") {
      const bookingId = await createBooking(customerNumber, state);
      await saveState(customerNumber, {
        status     : STATUS.BOOKED,
        booking_id : bookingId ? String(bookingId) : null,
      });
      return (
        `✅ Booking confirmed!${bookingId ? ` (Ref #${bookingId})` : ""}\n` +
        `A CoolCare technician will be assigned for your *${state.appliance}* repair (${state.issue}).\n` +
        `We'll contact you at this number to confirm the visit time. 🙏\n\n` +
        `Feel free to ask if you have any questions about your booking.`
      );
    }

    if (intent === "confirm_no" || intent === "cancel_booking") {
      await saveState(customerNumber, { status: STATUS.CANCELLED });
      return "No problem! Booking cancelled. 👍 Just message us whenever you need help with an appliance repair.";
    }

    if (intent === "new_booking") {
      await resetState(customerNumber);
      await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE });
      return "Starting fresh! 👋\n" + askStep(STATUS.COLLECTING_APPLIANCE, {});
    }

    if (intent === "modify_booking") {
      const mod = await extractModification(text, state);
      if (mod.field && mod.new_value) {
        await forceUpdateState(customerNumber, mod.field, mod.new_value);
        const reloadedState = await loadState(customerNumber);
        return (
          `Updated! Here's your revised booking summary:\n` +
          `• Appliance: ${reloadedState.appliance}\n` +
          `• Issue: ${reloadedState.issue}\n` +
          `• Name: ${reloadedState.customer_name}\n` +
          `• Address: ${reloadedState.address}, ${reloadedState.area}\n` +
          `• When: ${reloadedState.urgency}\n\n` +
          `Shall I confirm this booking? Reply *Yes* to confirm or *No* to cancel.`
        );
      }
    }

    // Out-of-flow question during confirmation — answer it, then re-ask Yes/No
    return await answerQuestion(text, state, STATUS.CONFIRMATION_PENDING);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COLLECTION steps — gather each field one at a time
  // ══════════════════════════════════════════════════════════════════════════
  if (COLLECTION_STEPS.includes(currentStatus)) {
    // Explicit reset
    if (
      lowerText.includes("reset") ||
      lowerText.includes("start over") ||
      lowerText.includes("new booking") ||
      lowerText.includes("book another")
    ) {
      await resetState(customerNumber);
      await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE });
      return "Sure! Starting fresh. 👋\n" + askStep(STATUS.COLLECTING_APPLIANCE, {});
    }

    const intent = await classifyIntent(text, currentStatus, state);

    // Out-of-flow question — answer it and re-ask the current step
    if (intent === "out_of_flow_question") {
      return await answerQuestion(text, state, currentStatus);
    }

    // Modification during collection (e.g. "Actually I meant geyser" after entering AC)
    if (intent === "modify_booking") {
      const mod = await extractModification(text, state);
      if (mod.field && mod.new_value) {
        await forceUpdateState(customerNumber, mod.field, mod.new_value);
        const reloadedState = await loadState(customerNumber);
        return `Got it, updated to *${mod.new_value}*. ` + askStep(currentStatus, reloadedState);
      }
    }

    // Try to extract the expected field
    const extracted = await extractField(currentStatus, text, state);

    if (!extracted) {
      // Couldn't extract — re-ask gently
      const retryMsg = {
        [STATUS.COLLECTING_APPLIANCE] : `I didn't catch the appliance. Which one needs repair? (AC, Geyser, Refrigerator, Washing Machine, TV, RO, Fan, Microwave…)`,
        [STATUS.COLLECTING_ISSUE]     : `Could you describe the problem with your ${state.appliance}? (e.g. not cooling, water leaking, not turning on…)`,
        [STATUS.COLLECTING_NAME]      : `Could you share your name please?`,
        [STATUS.COLLECTING_ADDRESS]   : `Please share your full address including flat/house number, street and locality.`,
        [STATUS.COLLECTING_LOCALITY]  : `Which area or locality are you in?`,
        [STATUS.COLLECTING_DATE]      : `When would you like the service? (Today, tomorrow, this week…)`,
      };
      return retryMsg[currentStatus] || askStep(currentStatus, state);
    }

    // Save the extracted value and advance to the next step
    const fieldName = STEP_FIELD[currentStatus];
    const nextStatus = COLLECTION_STEPS[COLLECTION_STEPS.indexOf(currentStatus) + 1];

    await saveState(customerNumber, {
      [fieldName] : extracted,
      status      : nextStatus,
    });

    const updatedState = await loadState(customerNumber);
    return askStep(nextStatus, updatedState);
  }

  // Fallback — should never reach here
  return "Something went wrong. Please send *reset* to start over.";
}


// ─── Vercel serverless export ─────────────────────────────────────────────────
module.exports = async (request, response) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  // Meta webhook verification (GET)
  if (request.method === "GET") {
    const mode      = request.query["hub.mode"];
    const token     = request.query["hub.verify_token"];
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
    const change          = request.body?.entry?.[0]?.changes?.[0]?.value;
    const incomingMessage = change?.messages?.[0];
    const phoneNumberId   = change?.metadata?.phone_number_id;

    // Ignore non-text messages (images, stickers, etc.)
    if (!incomingMessage || incomingMessage.type !== "text") {
      return response.status(200).json({ received: true });
    }

    const customerNumber = incomingMessage.from;
    const customerText   = incomingMessage.text?.body?.trim() || "";
    const accessToken    = process.env.WHATSAPP_ACCESS_TOKEN;
    const apiVersion     = process.env.WHATSAPP_API_VERSION;

    if (!accessToken || !apiVersion || !phoneNumberId) {
      console.error("WhatsApp env vars not configured.");
      return response.status(500).json({ error: "WhatsApp is not configured" });
    }

    // Save inbound message to audit log (NOT fed into LLM prompts)
    await saveMessage(customerNumber, "customer", customerText);

    // Run state machine
    const reply = await handleMessage(customerNumber, customerText);

    // Save outbound reply to audit log
    await saveMessage(customerNumber, "bot", reply);

    // Send reply via WhatsApp Cloud API
    const metaRes = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: customerNumber,
          type: "text",
          text: { body: reply },
        }),
      }
    );

    if (!metaRes.ok) {
      console.error("Meta send failed:", await metaRes.text());
      return response.status(502).json({ error: "Could not send WhatsApp reply" });
    }

    return response.status(200).json({ replied: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return response.status(500).json({ error: "Unexpected webhook error" });
  }
};

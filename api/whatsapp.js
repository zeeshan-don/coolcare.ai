// api/whatsapp.js
// CoolCare WhatsApp bot — full state machine with i18n, session timeout, typing indicator.
// Phase 6+15: Multi-language (en, hi, ta, ar), session timeout, typing, error recovery,
// production Cloud API with retry mechanism.

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { webhookLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");

// ─── i18n: Multi-language support ─────────────────────────────────────────────
const I18N = {
  en: {
    welcome: "Hi! 👋 Welcome to CoolCare. Which appliance needs repair?\n(AC, Refrigerator, Geyser, Washing Machine, Microwave, TV, RO, Fan, etc.)",
    whatProblem: (s) => `What's the problem with your ${s.appliance}?`,
    askName: "Got it! May I know your name?",
    askAddress: (s) => `Thanks ${s.customer_name}! Please share your full address (flat/house no., street, locality).`,
    askArea: "Which area or locality are you in? (Helps us assign the nearest technician.)",
    askDate: "When do you need the service? (Today, tomorrow, this week, or no rush?)",
    confirmBooking: (s) =>
      `Here's your booking summary:\n• Appliance: ${s.appliance}\n• Issue: ${s.issue}\n• Name: ${s.customer_name}\n• Address: ${s.address}, ${s.area}\n• When: ${s.urgency}\n\nShall I confirm this booking? Reply *Yes* to confirm or *No* to cancel.`,
    bookingConfirmed: (s, id) =>
      `✅ Booking confirmed!${id ? ` (Ref #${id})` : ""}\nA CoolCare technician will be assigned for your *${s.appliance}* repair (${s.issue}).\nWe'll contact you at this number to confirm the visit time. 🙏\n\nFeel free to ask if you have any questions about your booking.`,
    cancelled: "No problem! Booking cancelled. 👍 Just message us whenever you need help with an appliance repair.",
    sessionExpired: "Your previous session has expired. Let's start fresh! 👋\n",
    fallback: "I didn't understand that. You can say *reset* to start over, or *status* to check your booking.",
    statusMsg: (s) => `Your booking (Ref #${s.booking_id}) is confirmed. A technician will contact you soon. Type *cancel* to cancel or *new booking* to book another service.`,
    noBooking: "You don't have an active booking. Let's create one! 👋\n",
    viewStatus: "status",
    cancelBooking: "cancel",
    newBooking: "new booking",
    restart: "reset",
  },
  hi: {
    welcome: "नमस्ते! 👋 CoolCare में आपका स्वागत है। कौन सा उपकरण ठीक कराना है?\n(AC, फ्रिज, गीज़र, वॉशिंग मशीन, माइक्रोवेव, TV, RO, पंखा, आदि)",
    whatProblem: (s) => `आपके ${s.appliance} में क्या समस्या है?`,
    askName: "ठीक है! आपका नाम क्या है?",
    askAddress: (s) => `धन्यवाद ${s.customer_name}! कृपया अपना पूरा पता बताएं (मकान नंबर, गली, इलाका)।`,
    askArea: "आप किस इलाके में हैं? (नज़दीकी टेक्नीशियन असाइन करने में मदद मिलेगी।)",
    askDate: "आपको सेवा कब चाहिए? (आज, कल, इस हफ्ते, या जल्दी नहीं?)",
    confirmBooking: (s) =>
      `आपकी बुकिंग का सारांश:\n• उपकरण: ${s.appliance}\n• समस्या: ${s.issue}\n• नाम: ${s.customer_name}\n• पता: ${s.address}, ${s.area}\n• कब: ${s.urgency}\n\nक्या मैं यह बुकिंग कन्फर्म करूं? *हाँ* लिखें कन्फर्म करने के लिए या *नहीं* रद्द करने के लिए।`,
    bookingConfirmed: (s, id) =>
      `✅ बुकिंग कन्फर्म!${id ? ` (Ref #${id})` : ""}\nCoolCare टेक्नीशियन आपके *${s.appliance}* रिपेयर (${s.issue}) के लिए असाइन किया जाएगा।\nहम visit का समय कन्फर्म करने के लिए आपसे संपर्क करेंगे। 🙏`,
    cancelled: "कोई बात नहीं! बुकिंग रद्द हो गई। 👍 जब भी ज़रूरत हो, बस मैसेज करें।",
    sessionExpired: "आपका पिछला सत्र समाप्त हो गया है। चलिए नए सिरे से शुरू करते हैं! 👋\n",
    fallback: "मैं समझ नहीं पाया। *reset* लिखें दोबारा शुरू करने के लिए, या *status* बुकिंग देखने के लिए।",
    statusMsg: (s) => `आपकी बुकिंग (Ref #${s.booking_id}) कन्फर्म है। टेक्नीशियन जल्द संपर्क करेगा।`,
    noBooking: "आपके पास कोई सक्रिय बुकिंग नहीं है। चलिए एक बनाते हैं! 👋\n",
    viewStatus: "status",
    cancelBooking: "cancel",
    newBooking: "new booking",
    restart: "reset",
  },
  ta: {
    welcome: "வணக்கம்! 👋 CoolCare-க்கு வரவேற்கிறோம். எந்த சாதனத்தை பழுது பார்க்க வேண்டும்?\n(AC, ஃப்ரிட்ஜ், கீசர், வாஷிங் மெஷின், மைக்ரோவேவ், TV, RO, ஃபேன்)",
    whatProblem: (s) => `உங்கள் ${s.appliance}-ல் என்ன பிரச்சனை?`,
    askName: "சரி! உங்கள் பெயர் என்ன?",
    askAddress: (s) => `நன்றி ${s.customer_name}! உங்கள் முழு முகவரியைப் பகிரவும்.`,
    askArea: "நீங்கள் எந்த பகுதியில் உள்ளீர்கள்?",
    askDate: "சேவை எப்போது வேண்டும்? (இன்று, நாளை, இந்த வாரம்)",
    confirmBooking: (s) =>
      `உங்கள் முன்பதிவு சுருக்கம்:\n• சாதனம்: ${s.appliance}\n• பிரச்சனை: ${s.issue}\n• பெயர்: ${s.customer_name}\n• முகவரி: ${s.address}, ${s.area}\n• எப்போது: ${s.urgency}\n\nஉறுதிப்படுத்த *Yes* அல்லது ரத்து செய்ய *No* என பதிலளிக்கவும்.`,
    bookingConfirmed: (s, id) =>
      `✅ முன்பதிவு உறுதி!${id ? ` (Ref #${id})` : ""}\nCoolCare தொழில்நுட்பர் விரைவில் தொடர்பு கொள்வார். 🙏`,
    cancelled: "முன்பதிவு ரத்து செய்யப்பட்டது. 👍",
    sessionExpired: "உங்கள் முந்தைய அமர்வு முடிந்தது. புதிதாக தொடங்குவோம்! 👋\n",
    fallback: "*reset* என தட்டச்சு செய்து மீண்டும் தொடங்கவும்.",
    statusMsg: (s) => `உங்கள் முன்பதிவு (Ref #${s.booking_id}) உறுதி செய்யப்பட்டது.`,
    noBooking: "உங்களுக்கு செயலில் முன்பதிவு இல்லை. ஒன்றை உருவாக்குவோம்! 👋\n",
    viewStatus: "status",
    cancelBooking: "cancel",
    newBooking: "new booking",
    restart: "reset",
  },
  ar: {
    welcome: "مرحباً! 👋 أهلاً بك في CoolCare. أي جهاز يحتاج إصلاح؟\n(مكيف، ثلاجة، سخان، غسالة، ميكروويف، تلفزيون، فلتر مياه، مروحة)",
    whatProblem: (s) => `ما المشكلة في ${s.appliance}؟`,
    askName: "تمام! ما اسمك؟",
    askAddress: (s) => `شكراً ${s.customer_name}! شارك عنوانك الكامل.`,
    askArea: "في أي منطقة أنت؟",
    askDate: "متى تحتاج الخدمة؟ (اليوم، غداً، هذا الأسبوع)",
    confirmBooking: (s) =>
      `ملخص الحجز:\n• الجهاز: ${s.appliance}\n• المشكلة: ${s.issue}\n• الاسم: ${s.customer_name}\n• العنوان: ${s.address}, ${s.area}\n• متى: ${s.urgency}\n\nللتأكيد اكتب *نعم* أو للإلغاء اكتب *لا*.`,
    bookingConfirmed: (s, id) =>
      `✅ تم تأكيد الحجز!${id ? ` (مرجع #${id})` : ""}\nسيتواصل معك فني CoolCare قريباً. 🙏`,
    cancelled: "تم إلغاء الحجز. 👍",
    sessionExpired: "انتهت جلستك السابقة. لنبدأ من جديد! 👋\n",
    fallback: "اكتب *reset* للبدء من جديد أو *status* لمعرفة حالة الحجز.",
    statusMsg: (s) => `حجزك (مرجع #${s.booking_id}) مؤكد. سيتواصل معك الفني قريباً.`,
    noBooking: "ليس لديك حجز نشط. لنُنشئ واحداً! 👋\n",
    viewStatus: "status",
    cancelBooking: "cancel",
    newBooking: "new booking",
    restart: "reset",
  },
};

// Detect language from user message (basic heuristic)
function detectLanguage(text) {
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[\u0B80-\u0BFF]/.test(text)) return "ta";
  if (/[\u0900-\u097F]/.test(text)) return "hi";
  return "en";
}

// Get i18n strings for a language
function t(lang) { return I18N[lang] || I18N.en; }

// ─── State machine statuses ───────────────────────────────────────────────────
const STATUS = {
  COLLECTING_APPLIANCE: "COLLECTING_APPLIANCE",
  COLLECTING_ISSUE: "COLLECTING_ISSUE",
  COLLECTING_NAME: "COLLECTING_NAME",
  COLLECTING_ADDRESS: "COLLECTING_ADDRESS",
  COLLECTING_LOCALITY: "COLLECTING_LOCALITY",
  COLLECTING_DATE: "COLLECTING_DATE",
  CONFIRMATION_PENDING: "CONFIRMATION_PENDING",
  BOOKED: "BOOKED",
  CANCELLED: "CANCELLED",
};

const COLLECTION_STEPS = [
  STATUS.COLLECTING_APPLIANCE, STATUS.COLLECTING_ISSUE,
  STATUS.COLLECTING_NAME, STATUS.COLLECTING_ADDRESS,
  STATUS.COLLECTING_LOCALITY, STATUS.COLLECTING_DATE,
  STATUS.CONFIRMATION_PENDING,
];

const STEP_FIELD = {
  [STATUS.COLLECTING_APPLIANCE]: "appliance",
  [STATUS.COLLECTING_ISSUE]: "issue",
  [STATUS.COLLECTING_NAME]: "customer_name",
  [STATUS.COLLECTING_ADDRESS]: "address",
  [STATUS.COLLECTING_LOCALITY]: "area",
  [STATUS.COLLECTING_DATE]: "urgency",
};

// Session timeout: 2 hours
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// ─── DB helpers ───────────────────────────────────────────────────────────────
let _sql = null;
function getSql() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

async function loadState(customerNumber) {
  const rows = await getSql()`SELECT * FROM conversation_state WHERE customer_number = ${customerNumber} LIMIT 1`;
  return rows.length ? rows[0] : null;
}

async function saveState(customerNumber, updates) {
  const sql = getSql();
  const exists = await sql`SELECT id FROM conversation_state WHERE customer_number = ${customerNumber}`;
  if (exists.length > 0) {
    await sql`
      UPDATE conversation_state SET
        status = COALESCE(${updates.status ?? null}, status),
        appliance = COALESCE(${updates.appliance ?? null}, appliance),
        issue = COALESCE(${updates.issue ?? null}, issue),
        customer_name = COALESCE(${updates.customer_name ?? null}, customer_name),
        address = COALESCE(${updates.address ?? null}, address),
        area = COALESCE(${updates.area ?? null}, area),
        urgency = COALESCE(${updates.urgency ?? null}, urgency),
        booking_id = COALESCE(${updates.booking_id ?? null}, booking_id),
        language = COALESCE(${updates.language ?? null}, language),
        updated_at = now()
      WHERE customer_number = ${customerNumber}
    `;
  } else {
    await sql`
      INSERT INTO conversation_state
        (customer_number, status, appliance, issue, customer_name, address, area, urgency, booking_id, language)
      VALUES
        (${customerNumber}, ${updates.status ?? STATUS.COLLECTING_APPLIANCE},
         ${updates.appliance ?? null}, ${updates.issue ?? null},
         ${updates.customer_name ?? null}, ${updates.address ?? null},
         ${updates.area ?? null}, ${updates.urgency ?? null},
         ${updates.booking_id ?? null}, ${updates.language ?? "en"})
    `;
  }
}

async function resetState(customerNumber) {
  await getSql()`DELETE FROM conversation_state WHERE customer_number = ${customerNumber}`;
}

async function forceUpdateState(customerNumber, field, value) {
  const allowed = ["appliance", "issue", "customer_name", "address", "area", "urgency", "status", "booking_id"];
  if (!allowed.includes(field)) return;
  await saveState(customerNumber, { [field]: value });
}

async function saveMessage(customerNumber, role, message) {
  await getSql()`INSERT INTO conversations (customer_number, role, message) VALUES (${customerNumber}, ${role}, ${message})`;
}

// ─── LLM: Groq API caller with retry ─────────────────────────────────────────
async function callGroq(messages, jsonMode = false, maxTokens = 200, retries = 2) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const body = {
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: jsonMode ? 0 : 0.4,
        max_tokens: maxTokens,
      };
      if (jsonMode) body.response_format = { type: "json_object" };

      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok) {
        const data = await res.json();
        return data?.choices?.[0]?.message?.content?.trim() || null;
      }

      if (res.status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      console.error("[Groq] API error:", res.status);
      return null;
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      console.error("[Groq] Fetch error:", err.message);
      return null;
    }
  }
  return null;
}

// ─── Intent classification ────────────────────────────────────────────────────
async function classifyIntent(userText, currentStatus, state) {
  const stateContext = `Status: ${currentStatus}, Appliance: ${state?.appliance ?? "none"}, Issue: ${state?.issue ?? "none"}, Name: ${state?.customer_name ?? "none"}`;
  const prompt = `Classify this WhatsApp message intent. State: ${stateContext}\nMessage: "${userText}"\nReply ONLY as JSON: {"intent": "answer_field|out_of_flow_question|confirm_yes|confirm_no|modify_booking|cancel_booking|new_booking|thanks|view_status"}`;

  try {
    const raw = await callGroq([{ role: "user", content: prompt }], true, 50);
    if (!raw) return "answer_field";
    return JSON.parse(raw).intent || "answer_field";
  } catch { return "answer_field"; }
}

// ─── Name validation (regex, no LLM) ─────────────────────────────────────────
function validateName(raw) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 50) return null;
  if (/https?:\/\/|www\./i.test(trimmed) || /\d/.test(trimmed)) return null;
  if (!/\p{L}/u.test(trimmed)) return null;
  if (!/^[\p{L}\s'\-\.]+$/u.test(trimmed)) return null;
  return trimmed;
}

// ─── Field extraction via LLM ─────────────────────────────────────────────────
async function extractField(step, userText, state) {
  if (step === STATUS.COLLECTING_NAME) return validateName(userText);

  const prompts = {
    [STATUS.COLLECTING_APPLIANCE]: `User: "${userText}"\nExtract appliance. JSON: {"value": "AC|Refrigerator|Geyser|Washing Machine|Microwave|TV|RO|Fan|Dishwasher|Air Cooler or null"}`,
    [STATUS.COLLECTING_ISSUE]: `User: "${userText}"\nAppliance: ${state.appliance}. Extract issue. JSON: {"value": "short issue or null"}`,
    [STATUS.COLLECTING_ADDRESS]: `User: "${userText}"\nExtract full address. JSON: {"value": "address or null"}`,
    [STATUS.COLLECTING_LOCALITY]: `User: "${userText}"\nExtract area/locality. JSON: {"value": "area or null"}`,
    [STATUS.COLLECTING_DATE]: `User: "${userText}"\nExtract service date preference. JSON: {"value": "date or null"}`,
  };

  const prompt = prompts[step];
  if (!prompt) return null;

  try {
    const raw = await callGroq([{ role: "user", content: prompt }], true, 80);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.value != null && parsed.value !== "" ? parsed.value : null;
  } catch { return null; }
}

// ─── Answer out-of-flow questions ─────────────────────────────────────────────
async function answerQuestion(userText, state, currentStatus, lang) {
  const langStrings = t(lang);
  const stepQuestion = getStepQuestion(currentStatus, state, lang);
  const systemPrompt = `You are CoolCare's WhatsApp support for home appliance repair. Keep replies short (2-4 sentences). Mirror the user's language. After answering, re-ask: "${stepQuestion}". NEVER invent prices.`;
  const reply = await callGroq([{ role: "system", content: systemPrompt }, { role: "user", content: userText }], false, 250);
  return reply || `Good question! Our technician will provide details after inspection. ${stepQuestion}`;
}

// ─── Answer questions in BOOKED state ─────────────────────────────────────────
async function answerBookedQuestion(userText, state, lang) {
  const systemPrompt = `You are CoolCare's WhatsApp support. Customer has booking Ref #${state.booking_id ?? "pending"}. Keep replies short. Mirror language. NEVER invent prices or technician names.`;
  const reply = await callGroq([{ role: "system", content: systemPrompt }, { role: "user", content: userText }], false, 200);
  return reply || "Our team will contact you shortly. Anything else I can help with?";
}

// ─── Extract modification ─────────────────────────────────────────────────────
async function extractModification(userText, state) {
  const prompt = `Customer wants to change booking. Current: Appliance=${state.appliance}, Issue=${state.issue}, Address=${state.address}, Area=${state.area}, When=${state.urgency}\nUser: "${userText}"\nJSON: {"field": "appliance|issue|address|area|urgency|null", "new_value": "value or null"}`;
  try {
    const raw = await callGroq([{ role: "user", content: prompt }], true, 100);
    if (!raw) return { field: null, new_value: null };
    return JSON.parse(raw);
  } catch { return { field: null, new_value: null }; }
}

// ─── Get step question in current language ────────────────────────────────────
function getStepQuestion(status, state, lang) {
  const s = t(lang);
  switch (status) {
    case STATUS.COLLECTING_APPLIANCE: return s.welcome;
    case STATUS.COLLECTING_ISSUE: return s.whatProblem(state);
    case STATUS.COLLECTING_NAME: return s.askName;
    case STATUS.COLLECTING_ADDRESS: return s.askAddress(state);
    case STATUS.COLLECTING_LOCALITY: return s.askArea;
    case STATUS.COLLECTING_DATE: return s.askDate;
    case STATUS.CONFIRMATION_PENDING: return s.confirmBooking(state);
    default: return s.fallback;
  }
}

// ─── Create booking ───────────────────────────────────────────────────────────
async function createBooking(customerNumber, state) {
  try {
    const sql = getSql();
    const inserted = await sql`
      INSERT INTO bookings (customer_number, customer_name, address, service_type, area, urgency, status)
      VALUES (${customerNumber}, ${state.customer_name},
              ${(state.address ?? "") + (state.area ? ", " + state.area : "")},
              ${(state.appliance ?? "") + (state.issue ? " — " + state.issue : "")},
              ${state.area}, ${state.urgency}, 'open')
      RETURNING id
    `;
    const bookingId = inserted[0].id;

    const techs = await sql`
      SELECT id FROM technicians WHERE active = true
      AND EXISTS (SELECT 1 FROM unnest(services) s WHERE lower(s) LIKE lower(${"%" + (state.appliance ?? "") + "%"}))
      LIMIT 1
    `;
    if (techs.length > 0) {
      await sql`UPDATE bookings SET technician_id = ${techs[0].id}, status = 'assigned' WHERE id = ${bookingId}`;
    }
    return bookingId;
  } catch (err) {
    console.error("[createBooking] error:", err.message);
    return null;
  }
}

async function cancelBooking(bookingId) {
  try { await getSql()`UPDATE bookings SET status = 'cancelled' WHERE id = ${bookingId}`; return true; }
  catch { return false; }
}

async function modifyBooking(bookingId, field, value) {
  try {
    const sql = getSql();
    if (field === "appliance" || field === "issue") {
      const rows = await sql`SELECT service_type FROM bookings WHERE id = ${bookingId}`;
      if (!rows.length) return false;
      const parts = (rows[0].service_type ?? " — ").split(" — ");
      const a = field === "appliance" ? value : parts[0];
      const i = field === "issue" ? value : parts[1] ?? "";
      await sql`UPDATE bookings SET service_type = ${a + " — " + i} WHERE id = ${bookingId}`;
    } else {
      const colMap = { customer_name: "customer_name", address: "address", area: "area", urgency: "urgency" };
      const col = colMap[field];
      if (!col) return false;
      await sql.unsafe(`UPDATE bookings SET ${col} = $1 WHERE id = $2`, [value, bookingId]);
    }
    return true;
  } catch (err) { console.error("[modifyBooking] error:", err.message); return false; }
}

// ─── Send typing indicator ────────────────────────────────────────────────────
async function sendTypingIndicator(phoneNumberId, customerNumber, accessToken, apiVersion) {
  try {
    await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: customerNumber,
        type: "interactive",
        interactive: { type: "button", body: { text: "Typing..." } },
      }),
    }).catch(() => {});
  } catch { /* typing indicator is best-effort */ }
}

// ─── Main message handler ─────────────────────────────────────────────────────
async function handleMessage(customerNumber, userText) {
  const text = userText.trim();
  const lowerText = text.toLowerCase();
  const lang = detectLanguage(text);

  let state = await loadState(customerNumber);
  const s = t(lang);

  // ── No state — start fresh ─────────────────────────────────────────────
  if (!state) {
    await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE, language: lang });
    return s.welcome;
  }

  // ── Session timeout check ──────────────────────────────────────────────
  if (state.updated_at) {
    const lastUpdate = new Date(state.updated_at).getTime();
    if (Date.now() - lastUpdate > SESSION_TIMEOUT_MS && state.status !== STATUS.BOOKED) {
      await resetState(customerNumber);
      await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE, language: lang });
      return s.sessionExpired + s.welcome;
    }
  }

  const currentStatus = state.status;

  // ── Global commands ────────────────────────────────────────────────────
  if (lowerText === s.viewStatus || lowerText === "status") {
    if (state.booking_id) return s.statusMsg(state);
    return s.noBooking + s.welcome;
  }

  // ── BOOKED state ───────────────────────────────────────────────────────
  if (currentStatus === STATUS.BOOKED) {
    if (lowerText.includes("new booking") || lowerText.includes("book another") || lowerText.includes("reset")) {
      await resetState(customerNumber);
      await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE, language: lang });
      return s.welcome;
    }

    if (lowerText.includes("cancel")) {
      if (state.booking_id) await cancelBooking(state.booking_id);
      await saveState(customerNumber, { status: STATUS.CANCELLED });
      return s.cancelled;
    }

    const intent = await classifyIntent(text, currentStatus, state);
    if (intent === "modify_booking") {
      const mod = await extractModification(text, state);
      if (mod.field && mod.new_value) {
        await forceUpdateState(customerNumber, mod.field, mod.new_value);
        if (state.booking_id) await modifyBooking(state.booking_id, mod.field, mod.new_value);
        const reloaded = await loadState(customerNumber);
        return `✅ Updated!\n• Appliance: ${reloaded.appliance}\n• Issue: ${reloaded.issue}\n• Address: ${reloaded.address}, ${reloaded.area}`;
      }
    }

    if (intent === "thanks") return "🙏 Thank you! Have a great day!";
    return await answerBookedQuestion(text, state, lang);
  }

  // ── CANCELLED state ────────────────────────────────────────────────────
  if (currentStatus === STATUS.CANCELLED) {
    await resetState(customerNumber);
    await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE, language: lang });
    return s.welcome;
  }

  // ── CONFIRMATION_PENDING ───────────────────────────────────────────────
  if (currentStatus === STATUS.CONFIRMATION_PENDING) {
    const intent = await classifyIntent(text, currentStatus, state);

    if (intent === "confirm_yes") {
      const bookingId = await createBooking(customerNumber, state);
      await saveState(customerNumber, { status: STATUS.BOOKED, booking_id: bookingId ? String(bookingId) : null });
      return s.bookingConfirmed(state, bookingId);
    }

    if (intent === "confirm_no" || intent === "cancel_booking") {
      await saveState(customerNumber, { status: STATUS.CANCELLED });
      return s.cancelled;
    }

    if (intent === "modify_booking") {
      const mod = await extractModification(text, state);
      if (mod.field && mod.new_value) {
        await forceUpdateState(customerNumber, mod.field, mod.new_value);
        const reloaded = await loadState(customerNumber);
        return s.confirmBooking(reloaded);
      }
    }

    return await answerQuestion(text, state, STATUS.CONFIRMATION_PENDING, lang);
  }

  // ── COLLECTION steps ───────────────────────────────────────────────────
  if (COLLECTION_STEPS.includes(currentStatus)) {
    if (lowerText.includes("reset") || lowerText.includes("start over")) {
      await resetState(customerNumber);
      await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE, language: lang });
      return s.welcome;
    }

    const intent = await classifyIntent(text, currentStatus, state);
    if (intent === "out_of_flow_question") return await answerQuestion(text, state, currentStatus, lang);

    if (intent === "modify_booking") {
      const mod = await extractModification(text, state);
      if (mod.field && mod.new_value) {
        await forceUpdateState(customerNumber, mod.field, mod.new_value);
        const reloaded = await loadState(customerNumber);
        return getStepQuestion(currentStatus, reloaded, lang);
      }
    }

    const extracted = await extractField(currentStatus, text, state);
    if (!extracted) {
      const retryMsg = {
        [STATUS.COLLECTING_APPLIANCE]: "I didn't catch the appliance. Which one needs repair?",
        [STATUS.COLLECTING_ISSUE]: `Could you describe the problem with your ${state.appliance}?`,
        [STATUS.COLLECTING_NAME]: "Could you share your name please?",
        [STATUS.COLLECTING_ADDRESS]: "Please share your full address.",
        [STATUS.COLLECTING_LOCALITY]: "Which area are you in?",
        [STATUS.COLLECTING_DATE]: "When would you like the service?",
      };
      return retryMsg[currentStatus] || getStepQuestion(currentStatus, state, lang);
    }

    const fieldName = STEP_FIELD[currentStatus];
    const nextStatus = COLLECTION_STEPS[COLLECTION_STEPS.indexOf(currentStatus) + 1];
    await saveState(customerNumber, { [fieldName]: extracted, status: nextStatus, language: lang });

    const updatedState = await loadState(customerNumber);
    return getStepQuestion(nextStatus, updatedState, lang);
  }

  return s.fallback;
}

// ─── Vercel serverless handler ────────────────────────────────────────────────
module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  // Meta webhook verification (GET)
  if (request.method === "GET") {
    const mode = request.query["hub.mode"];
    const token = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];
    if (mode === "subscribe" && token === verifyToken) {
      return response.status(200).send(challenge);
    }
    return response.status(403).send("Webhook verification failed");
  }

  if (!allowMethods(request, response, "POST")) return;
  if (!applyLimit(request, response, webhookLimiter)) return;

  const change = request.body?.entry?.[0]?.changes?.[0]?.value;
  const incomingMessage = change?.messages?.[0];
  const phoneNumberId = change?.metadata?.phone_number_id;

  if (!incomingMessage || incomingMessage.type !== "text") {
    return response.status(200).json({ received: true });
  }

  const customerNumber = incomingMessage.from;
  const customerText = incomingMessage.text?.body?.trim() || "";
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion = process.env.WHATSAPP_API_VERSION || "v19.0";

  if (!accessToken || !apiVersion || !phoneNumberId) {
    console.error("[WhatsApp] Missing env vars");
    return response.status(500).json({ error: "WhatsApp not configured" });
  }

  // Save inbound message
  await saveMessage(customerNumber, "customer", customerText);

  // Send typing indicator (best-effort)
  await sendTypingIndicator(phoneNumberId, customerNumber, accessToken, apiVersion);

  // Run state machine
  const reply = await handleMessage(customerNumber, customerText);

  // Save outbound reply
  await saveMessage(customerNumber, "bot", reply);

  // Send reply via WhatsApp Cloud API with retry
  let metaRes;
  for (let attempt = 0; attempt < 2; attempt++) {
    metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: customerNumber, type: "text", text: { body: reply } }),
      signal: AbortSignal.timeout(10000),
    });
    if (metaRes.ok) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
  }

  if (!metaRes?.ok) {
    console.error("[WhatsApp] Send failed after retries");
    return response.status(502).json({ error: "Could not send WhatsApp reply" });
  }

  return response.status(200).json({ replied: true });
});

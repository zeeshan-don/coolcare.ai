// api/whatsapp.js
// CoolCare WhatsApp bot — full state machine with i18n, session timeout, typing indicator.
// Phase 6+15: Multi-language (en, hi, ta, ar), session timeout, typing, error recovery,
// production Cloud API with retry mechanism.
// Phase 7: Image support, human handoff, shop knowledge base, smart scheduling,
// AI memory, empathetic responses, file support, conversation analytics.

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { webhookLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders, verifyWebhookSignature } = require("./_lib/security");
const { decrypt } = require("./_lib/encrypt");

// ─── i18n: Multi-language support ─────────────────────────────────────────────
const I18N = {
  en: {
    welcome: "Hi! 👋 Welcome to CoolCare. Which appliance needs repair?\n(AC, Refrigerator, Geyser, Washing Machine, Microwave, TV, RO, Fan, etc.)",
    whatProblem: (s) => `What's the problem with your ${s.appliance}?`,
    askPhoto: "Could you please send a photo of the appliance or the issue? (Optional — you can skip by saying 'no photo')",
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
    humanHandoff: "I understand you'd like to speak with a human. Let me transfer you to our team. They'll be with you shortly. 🙏",
    handoffClosed: "Welcome back! Your conversation with our team has ended. How can I help you today?",
    noInfo: "I'll let our team confirm that.",
  },
  hi: {
    welcome: "नमस्ते! 👋 CoolCare में आपका स्वागत है। कौन सा उपकरण ठीक कराना है?\n(AC, फ्रिज, गीज़र, वॉशिंग मशीन, माइक्रोवेव, TV, RO, पंखा, आदि)",
    whatProblem: (s) => `आपके ${s.appliance} में क्या समस्या है?`,
    askPhoto: "कृपया उपकरण या समस्या की फोटो भेजें? (वैकल्पिक — 'no photo' कहकर छोड़ सकते हैं)",
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
    humanHandoff: "मैं समझ गया कि आप किसी व्यक्ति से बात करना चाहते हैं। मैं आपको हमारी टीम से जोड़ रहा हूं। 🙏",
    handoffClosed: "आपकी टीम के साथ बातचीत समाप्त हो गई है। आज मैं आपकी कैसे मदद कर सकता हूं?",
    noInfo: "मैं इसकी पुष्टि हमारी टीम से करवा दूंगा।",
  },
  ta: {
    welcome: "வணக்கம்! 👋 CoolCare-க்கு வரவேற்கிறோம். எந்த சாதனத்தை பழுது பார்க்க வேண்டும்?\n(AC, ஃப்ரிட்ஜ், கீசர், வாஷிங் மெஷின், மைக்ரோவேவ், TV, RO, ஃபேன்)",
    whatProblem: (s) => `உங்கள் ${s.appliance}-ல் என்ன பிரச்சனை?`,
    askPhoto: "சாதனம் அல்லது பிரச்சனையின் புகைப்படத்தை அனுப்பவும்? (விரும்பினால் மட்டும் — 'no photo' என்று கூறலாம்)",
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
    humanHandoff: "நீங்கள் ஒருவரிடம் பேச விரும்புகிறீர்கள் என்பதை புரிந்துகொண்டேன். எங்கள் குழுவினருடன் இணைக்கிறேன். 🙏",
    handoffClosed: "எங்கள் குழுவினருடனான உரையாடல் முடிந்துவிட்டது. நான் உங்களுக்கு எவ்வாறு உதவ முடியும்?",
    noInfo: "எங்கள் குழு அதை உறுதிப்படுத்தும்.",
  },
  ar: {
    welcome: "مرحباً! 👋 أهلاً بك في CoolCare. أي جهاز يحتاج إصلاح؟\n(مكيف، ثلاجة، سخان، غسالة، ميكروويف، تلفزيون، فلتر مياه، مروحة)",
    whatProblem: (s) => `ما المشكلة في ${s.appliance}؟`,
    askPhoto: "هل يمكنك إرسال صورة للجهاز أو المشكلة؟ (اختياري — يمكنك تخطي بقول 'no photo')",
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
    humanHandoff: "أتفهم أنك تريد التحدث مع أحد الموظفين. سأحولك إلى فريقنا. سيكونون معك قريباً. 🙏",
    handoffClosed: "مرحباً بعودتك! انتهت محادثتك مع فريقنا. كيف يمكنني مساعدتك اليوم؟",
    noInfo: "سأجعل فريقنا يؤكد ذلك.",
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

// ─── Human handoff keywords ──────────────────────────────────────────────────
const HUMAN_HANDOFF_KEYWORDS = [
  "talk to a human", "speak to a person", "customer care", "customer support",
  "agent", "representative", "real person", "human agent", "call me",
  "talk to someone", "talk to the owner", "speak to manager", "human please",
  "talk to support", "i want to complain", "complaint", "escalate",
  "talk to a real person", "i need a human",
];

// ─── State machine statuses ───────────────────────────────────────────────────
const STATUS = {
  COLLECTING_APPLIANCE: "COLLECTING_APPLIANCE",
  COLLECTING_ISSUE: "COLLECTING_ISSUE",
  COLLECTING_PHOTO: "COLLECTING_PHOTO",
  COLLECTING_NAME: "COLLECTING_NAME",
  COLLECTING_ADDRESS: "COLLECTING_ADDRESS",
  COLLECTING_LOCALITY: "COLLECTING_LOCALITY",
  COLLECTING_DATE: "COLLECTING_DATE",
  SELECTING_SLOT: "SELECTING_SLOT",
  CONFIRMATION_PENDING: "CONFIRMATION_PENDING",
  BOOKED: "BOOKED",
  CANCELLED: "CANCELLED",
  HUMAN_HANDOFF: "HUMAN_HANDOFF",
};

const COLLECTION_STEPS = [
  STATUS.COLLECTING_APPLIANCE, STATUS.COLLECTING_ISSUE,
  STATUS.COLLECTING_NAME, STATUS.COLLECTING_ADDRESS,
  STATUS.COLLECTING_LOCALITY, STATUS.COLLECTING_DATE,
  STATUS.SELECTING_SLOT, STATUS.CONFIRMATION_PENDING,
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
        image_urls = COALESCE(${updates.image_urls ?? null}, image_urls),
        file_urls = COALESCE(${updates.file_urls ?? null}, file_urls),
        human_handoff = COALESCE(${updates.human_handoff ?? null}, human_handoff),
        handoff_closed_at = COALESCE(${updates.handoff_closed_at ?? null}, handoff_closed_at),
        ai_memory = COALESCE(${updates.ai_memory ?? null}::jsonb, ai_memory),
        selected_slot = COALESCE(${updates.selected_slot ?? null}, selected_slot),
        updated_at = now()
      WHERE customer_number = ${customerNumber}
    `;
  } else {
    await sql`
      INSERT INTO conversation_state
        (customer_number, status, appliance, issue, customer_name, address, area, urgency, booking_id, language,
         image_urls, file_urls, human_handoff, ai_memory, selected_slot)
      VALUES
        (${customerNumber}, ${updates.status ?? STATUS.COLLECTING_APPLIANCE},
         ${updates.appliance ?? null}, ${updates.issue ?? null},
         ${updates.customer_name ?? null}, ${updates.address ?? null},
         ${updates.area ?? null}, ${updates.urgency ?? null},
         ${updates.booking_id ?? null}, ${updates.language ?? "en"},
         ${updates.image_urls ?? []}, ${updates.file_urls ?? []},
         ${updates.human_handoff ?? false}, ${updates.ai_memory ?? "{}"},
         ${updates.selected_slot ?? null})
    `;
  }
}

async function resetState(customerNumber) {
  await getSql()`DELETE FROM conversation_state WHERE customer_number = ${customerNumber}`;
}

async function forceUpdateState(customerNumber, field, value) {
  const allowed = ["appliance", "issue", "customer_name", "address", "area", "urgency", "status", "booking_id", "image_urls", "file_urls", "human_handoff", "ai_memory", "selected_slot"];
  if (!allowed.includes(field)) return;
  await saveState(customerNumber, { [field]: value });
}

async function saveMessage(customerNumber, role, message) {
  await getSql()`INSERT INTO conversations (customer_number, role, message) VALUES (${customerNumber}, ${role}, ${message})`;
}

// ─── Load shop knowledge base (ai_settings) ──────────────────────────────────
async function loadShopKnowledge(repairShopId) {
  if (!repairShopId) return null;
  try {
    const rows = await getSql()`SELECT * FROM ai_settings WHERE repair_shop_id = ${repairShopId} LIMIT 1`;
    if (rows.length > 0) return rows[0];
  } catch (e) {
    console.warn("[whatsapp] Failed to load shop knowledge:", e.message);
  }
  return null;
}

// ─── Build shop knowledge context for LLM prompts ────────────────────────────
function buildKnowledgeContext(settings) {
  if (!settings) return "";
  const parts = [];
  if (settings.business_hours && Object.keys(settings.business_hours).length > 0) {
    try {
      const bh = typeof settings.business_hours === "string" ? JSON.parse(settings.business_hours) : settings.business_hours;
      const hours = Object.entries(bh).map(([day, h]) => `${day}: ${h.open}-${h.close}`).join(", ");
      parts.push(`Business hours: ${hours}`);
    } catch (e) { /* ignore */ }
  }
  if (settings.service_locations && settings.service_locations.length > 0) {
    parts.push(`Service locations: ${settings.service_locations.join(", ")}`);
  }
  if (settings.brands_repaired && settings.brands_repaired.length > 0) {
    parts.push(`Brands repaired: ${settings.brands_repaired.join(", ")}`);
  }
  if (settings.warranty_policy) parts.push(`Warranty: ${settings.warranty_policy}`);
  if (settings.inspection_policy) parts.push(`Inspection: ${settings.inspection_policy}`);
  if (settings.visiting_charges > 0) parts.push(`Visiting charge: ₹${settings.visiting_charges}`);
  if (settings.emergency_availability) parts.push(`Emergency service available: Yes`);
  if (settings.holiday_timings && Object.keys(settings.holiday_timings).length > 0) {
    try {
      const ht = typeof settings.holiday_timings === "string" ? JSON.parse(settings.holiday_timings) : settings.holiday_timings;
      const hols = Object.entries(ht).map(([day, h]) => `${day}: ${h.open}-${h.close}`).join(", ");
      parts.push(`Holiday hours: ${hols}`);
    } catch (e) { /* ignore */ }
  }
  if (settings.accepted_payment_methods && settings.accepted_payment_methods.length > 0) {
    parts.push(`Payment methods: ${settings.accepted_payment_methods.join(", ")}`);
  }
  if (settings.languages_spoken && settings.languages_spoken.length > 0) {
    parts.push(`Languages: ${settings.languages_spoken.join(", ")}`);
  }
  if (settings.knowledge_base) parts.push(`About us: ${settings.knowledge_base}`);
  if (settings.greeting_message) parts.push(`Greeting: ${settings.greeting_message}`);
  return parts.join("\n");
}

// ─── Load conversation history for AI memory ────────────────────────────────
async function loadConversationHistory(customerNumber, limit = 10) {
  try {
    const rows = await getSql()`
      SELECT role, message, created_at FROM conversations
      WHERE customer_number = ${customerNumber}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.reverse().map(r => ({ role: r.role, content: r.message }));
  } catch (e) {
    console.warn("[whatsapp] Failed to load conversation history:", e.message);
    return [];
  }
}

// ─── Check technician availability (smart scheduling) ───────────────────────
async function findAvailableSlots(repairShopId, appliance, date) {
  if (!repairShopId) return null;
  try {
    const sql = getSql();
    // Check if shop has scheduling configured
    const shopCheck = await sql`
      SELECT id FROM ai_settings WHERE repair_shop_id = ${repairShopId} LIMIT 1
    `;
    if (shopCheck.length === 0) return null;

    // Generate available time slots for the requested date
    const slots = [];
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);
    const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const dayName = dayNames[targetDate.getDay()];

    // Get business hours from ai_settings
    const settings = await sql`SELECT business_hours FROM ai_settings WHERE repair_shop_id = ${repairShopId} LIMIT 1`;
    if (settings.length === 0) return null;

    const businessHours = typeof settings[0].business_hours === "string"
      ? JSON.parse(settings[0].business_hours)
      : settings[0].business_hours;

    const todayHours = businessHours[dayName];
    if (!todayHours || !todayHours.open || !todayHours.close) return null;

    const [openH, openM] = todayHours.open.split(":").map(Number);
    const [closeH, closeM] = todayHours.close.split(":").map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;
    const slotDuration = 120; // 2-hour slots

    // Check existing bookings for double booking prevention
    const existingSlots = await sql`
      SELECT selected_slot FROM conversation_state
      WHERE repair_shop_id = ${repairShopId}
        AND selected_slot IS NOT NULL
        AND selected_slot >= ${targetDate.toISOString()}
        AND selected_slot < ${new Date(targetDate.getTime() + 86400000).toISOString()}
        AND status != 'CANCELLED'
    `;
    const bookedSlots = new Set(existingSlots.map(r =>
      r.selected_slot ? new Date(r.selected_slot).getTime() : null
    ).filter(Boolean));

    for (let m = openMinutes; m + slotDuration <= closeMinutes; m += slotDuration) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      const slotDate = new Date(targetDate);
      slotDate.setHours(h, min, 0, 0);
      if (!bookedSlots.has(slotDate.getTime())) {
        const endDate = new Date(slotDate.getTime() + slotDuration * 60000);
        slots.push({
          start: slotDate.toISOString(),
          end: endDate.toISOString(),
          label: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")} - ${String(endDate.getHours()).padStart(2, "0")}:${String(endDate.getMinutes()).padStart(2, "0")}`,
        });
      }
    }

    return slots.length > 0 ? slots : null;
  } catch (e) {
    console.warn("[whatsapp] Failed to find slots:", e.message);
    return null;
  }
}

// ─── Notify shop about human handoff ─────────────────────────────────────────
async function notifyHumanHandoff(repairShopId, customerNumber, customerName) {
  if (!repairShopId) return;
  try {
    const sql = getSql();
    await sql`
      INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
      VALUES (${repairShopId}, 'human_handoff', 'Human Handoff Requested 🙋',
              ${`Customer ${customerName || customerNumber} has requested to speak with a human. Open the conversation to respond.`},
              '/shop-dashboard.html')
    `;
  } catch (e) {
    console.warn("[whatsapp] Failed to notify shop about handoff:", e.message);
  }
}

// ─── Track conversation analytics ────────────────────────────────────────────
async function trackAnalytics(repairShopId, field, value) {
  if (!repairShopId) return;
  try {
    const sql = getSql();
    const today = new Date().toISOString().slice(0, 10);
    await sql`
      INSERT INTO conversation_analytics (repair_shop_id, date, ${field === "booking_completed" ? "booking_completed" : field === "human_handoff" ? "human_handoff" : "total_conversations"})
      VALUES (${repairShopId}, ${today}, 1)
      ON CONFLICT (repair_shop_id, date)
      DO UPDATE SET ${field === "booking_completed" ? "booking_completed" : field === "human_handoff" ? "human_handoff" : "total_conversations"} =
        COALESCE(conversation_analytics.${field === "booking_completed" ? "booking_completed" : field === "human_handoff" ? "human_handoff" : "total_conversations"}, 0) + 1
    `;
  } catch (e) {
    console.warn("[whatsapp] Failed to track analytics:", e.message);
  }
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

// ─── Intent classification (updated for human handoff + empathy) ─────────────
async function classifyIntent(userText, currentStatus, state) {
  const stateContext = `Status: ${currentStatus}, Appliance: ${state?.appliance ?? "none"}, Issue: ${state?.issue ?? "none"}, Name: ${state?.customer_name ?? "none"}`;
  const prompt = `Classify this WhatsApp message intent. State: ${stateContext}\nMessage: "${userText}"\nReply ONLY as JSON: {"intent": "answer_field|out_of_flow_question|confirm_yes|confirm_no|modify_booking|cancel_booking|new_booking|thanks|view_status|human_handoff|random_message"}`;

  try {
    const raw = await callGroq([{ role: "user", content: prompt }], true, 50);
    if (!raw) return "answer_field";
    return JSON.parse(raw).intent || "answer_field";
  } catch { return "answer_field"; }
}

// ─── Check if message is a human handoff request ────────────────────────────
function isHumanHandoffRequest(text) {
  const lower = text.toLowerCase().trim();
  return HUMAN_HANDOFF_KEYWORDS.some(kw => lower.includes(kw)) || lower.startsWith("human") || lower === "agent" || lower === "support";
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

  // Build AI memory context — helps bot understand references like "also" or "and"
  const aiMemory = state?.ai_memory || {};
  const memoryContext = Object.keys(aiMemory).length > 0
    ? `\nPreviously collected: ${JSON.stringify(aiMemory)}. If user says "also" or "and", merge with existing values.`
    : "";

  const prompts = {
    [STATUS.COLLECTING_APPLIANCE]: `User: "${userText}"${memoryContext}\nExtract appliance. JSON: {"value": "AC|Refrigerator|Geyser|Washing Machine|Microwave|TV|RO|Fan|Dishwasher|Air Cooler or null"}`,
    [STATUS.COLLECTING_ISSUE]: `User: "${userText}"\nAppliance: ${state?.appliance}${memoryContext}\nExtract issue. If user says "also" or "and" without repeating the appliance, it refers to the same appliance. Combine with existing issue if mentioned. JSON: {"value": "short combined issue or null"}`,
    [STATUS.COLLECTING_ADDRESS]: `User: "${userText}"${memoryContext}\nExtract full address. JSON: {"value": "address or null"}`,
    [STATUS.COLLECTING_LOCALITY]: `User: "${userText}"${memoryContext}\nExtract area/locality. JSON: {"value": "area or null"}`,
    [STATUS.COLLECTING_DATE]: `User: "${userText}"${memoryContext}\nExtract service date preference. JSON: {"value": "date or null"}`,
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

// ─── Answer out-of-flow questions with empathy + shop knowledge ─────────────
async function answerQuestion(userText, state, currentStatus, lang, knowledgeContext) {
  const langStrings = t(lang);
  const stepQuestion = getStepQuestion(currentStatus, state, lang, null);
  const knowledge = knowledgeContext ? `\n\nShop info:\n${knowledgeContext}\n\nIMPORTANT: ONLY answer using the above shop info. If the information is not available there, respond with: "${langStrings.noInfo}"` : "";
  const systemPrompt = `You are CoolCare's empathetic WhatsApp support for home appliance repair. Be warm, professional, and understanding. Acknowledge the customer's feelings. Keep replies short (2-4 sentences). Mirror the user's language. After answering, re-ask: "${stepQuestion}". NEVER invent prices, technician names, or specific availability.${knowledge}`;
  const reply = await callGroq([{ role: "system", content: systemPrompt }, { role: "user", content: userText }], false, 300);
  return reply || `Good question! Our technician will provide details after inspection. ${stepQuestion}`;
}

// ─── Answer questions in BOOKED state with empathy ──────────────────────────
async function answerBookedQuestion(userText, state, lang, knowledgeContext) {
  const knowledge = knowledgeContext ? `\n\nShop info:\n${knowledgeContext}` : "";
  const systemPrompt = `You are CoolCare's empathetic WhatsApp support. Customer has booking Ref #${state.booking_id ?? "pending"}. Be warm and understanding. Keep replies short. Mirror language. NEVER invent prices or technician names.${knowledge}`;
  const reply = await callGroq([{ role: "system", content: systemPrompt }, { role: "user", content: userText }], false, 200);
  return reply || "Our team will contact you shortly. Anything else I can help with?";
}

// ─── Handle random / non-sequitur messages (graceful recovery) ──────────────
async function handleRandomMessage(userText, state, currentStatus, lang) {
  const stepQuestion = getStepQuestion(currentStatus, state, lang, null);
  const prompt = `User said: "${userText}"\nCurrent booking context: Appliance=${state?.appliance || "none"}, Issue=${state?.issue || "none"}, Name=${state?.customer_name || "none"}, Status=${currentStatus}\n\nThe user sent something unrelated to their booking. Be friendly, acknowledge briefly, then guide them back to the booking process. Reply short (1-2 sentences).`;
  const reply = await callGroq([{ role: "user", content: prompt }], false, 150);
  if (reply) return `${reply}\n\n${stepQuestion}`;
  return `No worries! 😊\n\nComing back to your booking—${stepQuestion}`;
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
function getStepQuestion(status, state, lang, slots) {
  const s = t(lang);
  switch (status) {
    case STATUS.COLLECTING_APPLIANCE: return s.welcome;
    case STATUS.COLLECTING_ISSUE: return s.whatProblem(state);
    case STATUS.COLLECTING_PHOTO: return s.askPhoto;
    case STATUS.COLLECTING_NAME: return s.askName;
    case STATUS.COLLECTING_ADDRESS: return s.askAddress(state);
    case STATUS.COLLECTING_LOCALITY: return s.askArea;
    case STATUS.COLLECTING_DATE: return s.askDate;
    case STATUS.SELECTING_SLOT:
      if (slots && slots.length > 0) {
        const slotOptions = slots.map((s, i) => `${i + 1}. ${s.label}`).join("\n");
        return `Here are the available slots today:\n${slotOptions}\n\nPlease reply with the number of your preferred slot, or tell me a different time.`;
      }
      return s.askDate;
    case STATUS.CONFIRMATION_PENDING: return s.confirmBooking(state);
    default: return s.fallback;
  }
}

// ─── Create booking (updated with images, files, knowledge context) ──────────
async function createBooking(customerNumber, state) {
  try {
    const sql = getSql();

    if (state.repair_shop_id) {
      try {
        const shopCheck = await sql`
          SELECT subscription_status FROM repair_shops WHERE id = ${state.repair_shop_id} LIMIT 1
        `;
        if (shopCheck.length > 0 && shopCheck[0].subscription_status !== 'active') {
          console.warn("[whatsapp] Booking blocked — shop subscription inactive:", state.repair_shop_id);
          return null;
        }
      } catch (e) { /* table may not have column yet */ }
    }

    const imageUrls = Array.isArray(state.image_urls) ? state.image_urls : [];
    const fileUrls = Array.isArray(state.file_urls) ? state.file_urls : [];

    const inserted = await sql`
      INSERT INTO bookings (customer_number, customer_name, address, service_type, area, urgency, status,
        image_urls, file_urls, customer_sentiment, repair_shop_id)
      VALUES (${customerNumber}, ${state.customer_name},
              ${(state.address ?? "") + (state.area ? ", " + state.area : "")},
              ${(state.appliance ?? "") + (state.issue ? " — " + state.issue : "")},
              ${state.area}, ${state.urgency}, 'open',
              ${imageUrls.length > 0 ? imageUrls : []},
              ${fileUrls.length > 0 ? fileUrls : []}, 'neutral',
              ${state.repair_shop_id || null})
      RETURNING id
    `;
    const bookingId = inserted[0].id;

    // Try to auto-assign technician
    const techs = await sql`
      SELECT id FROM technicians WHERE active = true
      AND EXISTS (SELECT 1 FROM unnest(services) s WHERE lower(s) LIKE lower(${"%" + (state.appliance ?? "") + "%"}))
      LIMIT 1
    `;
    if (techs.length > 0) {
      await sql`UPDATE bookings SET technician_id = ${techs[0].id}, status = 'assigned' WHERE id = ${bookingId}`;
    }

    // Track analytics
    await trackAnalytics(state.repair_shop_id, "booking_completed");

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
      await sql(`UPDATE bookings SET ${col} = $1 WHERE id = $2`, value, bookingId);
    }
    return true;
  } catch (err) { console.error("[modifyBooking] error:", err.message); return false; }
}

// ─── Update conversation summary via AI ─────────────────────────────────────
async function updateConversationSummary(customerNumber, bookingId) {
  try {
    const history = await loadConversationHistory(customerNumber, 20);
    if (history.length < 3) return;

    const context = history.map(m => `${m.role}: ${m.content}`).join("\n");
    const prompt = `Summarize this customer service conversation in 2-3 sentences. Include the appliance, issue, and resolution status.\n\n${context}\n\nJSON: {"summary": "short summary", "sentiment": "positive|neutral|negative|frustrated"}`;
    const raw = await callGroq([{ role: "user", content: prompt }], true, 150);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (parsed.summary) {
      await getSql()`UPDATE bookings SET conversation_summary = ${parsed.summary}, customer_sentiment = ${parsed.sentiment || "neutral"} WHERE id = ${bookingId}`;
    }
  } catch (e) {
    console.warn("[whatsapp] Failed to update conversation summary:", e.message);
  }
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

// ─── Main message handler (with all Phase 7 enhancements) ────────────────────
async function handleMessage(customerNumber, userText, messageType, mediaData) {
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
    if (Date.now() - lastUpdate > SESSION_TIMEOUT_MS && state.status !== STATUS.BOOKED && state.status !== STATUS.HUMAN_HANDOFF) {
      await resetState(customerNumber);
      await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE, language: lang });
      return s.sessionExpired + s.welcome;
    }
  }

  const currentStatus = state.status;
  const knowledgeSettings = state.repair_shop_id ? await loadShopKnowledge(state.repair_shop_id) : null;
  const knowledgeContext = buildKnowledgeContext(knowledgeSettings);

  // ── HUMAN HANDOFF state ────────────────────────────────────────────────
  if (currentStatus === STATUS.HUMAN_HANDOFF) {
    // Check if handoff has been closed by the shop
    if (state.handoff_closed_at) {
      await saveState(customerNumber, {
        status: state.booking_id ? STATUS.BOOKED : COLLECTION_STEPS[0],
        human_handoff: false,
      });
      return s.handoffClosed;
    }
    // In human handoff — AI is paused. Notify shop again if customer sends more.
    return "Your conversation has been passed to our team. They'll respond to you shortly. 🙏";
  }

  // ── Handle image/document messages ─────────────────────────────────────
  if (messageType === "image" && mediaData) {
    const existing = Array.isArray(state.image_urls) ? state.image_urls : [];
    existing.push(mediaData.id || mediaData.link);
    await saveState(customerNumber, { image_urls: existing });

    if (currentStatus === STATUS.COLLECTING_PHOTO) {
      // Move to next step after receiving photo
      const nextStatus = COLLECTION_STEPS[Math.max(0, COLLECTION_STEPS.indexOf(currentStatus))];
      await saveState(customerNumber, { status: nextStatus });
      const updatedState = await loadState(customerNumber);
      return `Thanks for the photo! I can see the issue. ${getStepQuestion(nextStatus, updatedState, lang, null)}`;
    }
    if (currentStatus === STATUS.COLLECTING_ISSUE) {
      // Photo received while describing issue — skip to name
      const nextStatus = STATUS.COLLECTING_NAME;
      await saveState(customerNumber, { status: nextStatus });
      const updatedState = await loadState(customerNumber);
      return `Thanks for the photo! That helps me understand the issue better. ${getStepQuestion(nextStatus, updatedState, lang, null)}`;
    }
    return "📸 Thanks for the image! I've saved it with your conversation.";
  }

  if (messageType === "document" && mediaData) {
    const existing = Array.isArray(state.file_urls) ? state.file_urls : [];
    existing.push(mediaData.id || mediaData.link);
    await saveState(customerNumber, { file_urls: existing });
    return "📄 Thanks! I've saved the document with your details.";
  }

  // ── Global commands ────────────────────────────────────────────────────
  if (lowerText === s.viewStatus || lowerText === "status") {
    if (state.booking_id) return s.statusMsg(state);
    return s.noBooking + s.welcome;
  }

  // ── Human handoff check (for ALL non-handoff states) ───────────────────
  if (currentStatus !== STATUS.HUMAN_HANDOFF && isHumanHandoffRequest(text)) {
    await saveState(customerNumber, {
      status: STATUS.HUMAN_HANDOFF,
      human_handoff: true,
      handoff_closed_at: null,
    });
    await notifyHumanHandoff(state.repair_shop_id, customerNumber, state.customer_name);
    await trackAnalytics(state.repair_shop_id, "human_handoff");
    return s.humanHandoff;
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

    if (intent === "thanks") return "🙏 You're welcome! Have a great day! 😊";
    return await answerBookedQuestion(text, state, lang, knowledgeContext);
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
      // Generate conversation summary in background
      if (bookingId) {
        updateConversationSummary(customerNumber, bookingId).catch(() => {});
      }
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

    return await answerQuestion(text, state, STATUS.CONFIRMATION_PENDING, lang, knowledgeContext);
  }

  // ── COLLECTION steps ───────────────────────────────────────────────────
  if (COLLECTION_STEPS.includes(currentStatus)) {
    if (lowerText.includes("reset") || lowerText.includes("start over")) {
      await resetState(customerNumber);
      await saveState(customerNumber, { status: STATUS.COLLECTING_APPLIANCE, language: lang });
      return s.welcome;
    }

    const intent = await classifyIntent(text, currentStatus, state);

    // Handle random/non-sequitur messages gracefully (don't reset)
    if (intent === "random_message") {
      return await handleRandomMessage(text, state, currentStatus, lang);
    }

    if (intent === "out_of_flow_question") return await answerQuestion(text, state, currentStatus, lang, knowledgeContext);

    if (intent === "modify_booking") {
      const mod = await extractModification(text, state);
      if (mod.field && mod.new_value) {
        await forceUpdateState(customerNumber, mod.field, mod.new_value);
        const reloaded = await loadState(customerNumber);
        return getStepQuestion(currentStatus, reloaded, lang, null);
      }
    }

    // After collecting issue, optionally ask for photo
    if (currentStatus === STATUS.COLLECTING_ISSUE) {
      const extracted = await extractField(currentStatus, text, state);
      if (!extracted) {
        return `Could you describe the problem with your ${state.appliance}?`;
      }
      const fieldName = STEP_FIELD[currentStatus];
      await saveState(customerNumber, { [fieldName]: extracted, status: STATUS.COLLECTING_PHOTO, language: lang });
      return s.askPhoto;
    }

    // Handle photo collection step
    if (currentStatus === STATUS.COLLECTING_PHOTO) {
      if (lowerText.includes("no photo") || lowerText.includes("skip") || lowerText.includes("no picture") || lowerText.includes("nope") || lowerText === "no") {
        // Skip photo, go to next step
        const nextStatus = STATUS.COLLECTING_NAME;
        await saveState(customerNumber, { status: nextStatus });
        const updatedState = await loadState(customerNumber);
        return getStepQuestion(nextStatus, updatedState, lang, null);
      }
      // If they sent an image, it's handled above; if they sent text, pass through
      const nextStatus = STATUS.COLLECTING_NAME;
      await saveState(customerNumber, { status: nextStatus });
      const updatedState = await loadState(customerNumber);
      return `No problem! ${getStepQuestion(nextStatus, updatedState, lang, null)}`;
    }

    // Smart scheduling: after collecting date, check for available slots
    if (currentStatus === STATUS.COLLECTING_DATE) {
      const extracted = await extractField(currentStatus, text, state);
      if (!extracted) {
        return "When would you like the service? (Today, tomorrow, this week, or no rush?)";
      }

      const fieldName = STEP_FIELD[currentStatus];
      await saveState(customerNumber, { [fieldName]: extracted, language: lang });

      // Try smart scheduling if repair_shop_id exists
      if (state.repair_shop_id) {
        const slots = await findAvailableSlots(state.repair_shop_id, state.appliance, null);
        if (slots && slots.length > 0) {
          await saveState(customerNumber, { status: STATUS.SELECTING_SLOT });
          return getStepQuestion(STATUS.SELECTING_SLOT, await loadState(customerNumber), lang, slots);
        }
      }

      // Fallback: go directly to confirmation
      const nextStatus = STATUS.CONFIRMATION_PENDING;
      await saveState(customerNumber, { status: nextStatus });
      const updatedState = await loadState(customerNumber);
      return getStepQuestion(nextStatus, updatedState, lang, null);
    }

    // Handle slot selection
    if (currentStatus === STATUS.SELECTING_SLOT) {
      const slotIndex = parseInt(text, 10) - 1;
      const slots = await findAvailableSlots(state.repair_shop_id, state.appliance, null);
      if (slots && slotIndex >= 0 && slotIndex < slots.length) {
        const selectedSlot = slots[slotIndex];
        await saveState(customerNumber, {
          selected_slot: selectedSlot.start,
          urgency: selectedSlot.label,
          status: STATUS.CONFIRMATION_PENDING,
        });
        const updatedState = await loadState(customerNumber);
        return `Great choice! Your visit is scheduled for ${selectedSlot.label}.\n\n${s.confirmBooking(updatedState)}`;
      }
      // If slots failed, go to confirmation
      await saveState(customerNumber, { status: STATUS.CONFIRMATION_PENDING });
      const updatedState = await loadState(customerNumber);
      return getStepQuestion(STATUS.CONFIRMATION_PENDING, updatedState, lang, null);
    }

    const extracted = await extractField(currentStatus, text, state);
    if (!extracted) {
      const retryMsg = {
        [STATUS.COLLECTING_APPLIANCE]: "I didn't catch the appliance. Which one needs repair?",
        [STATUS.COLLECTING_ISSUE]: `Could you describe the problem with your ${state?.appliance}?`,
        [STATUS.COLLECTING_NAME]: "Could you share your name please?",
        [STATUS.COLLECTING_ADDRESS]: "Please share your full address.",
        [STATUS.COLLECTING_LOCALITY]: "Which area are you in?",
        [STATUS.COLLECTING_DATE]: "When would you like the service?",
      };
      return retryMsg[currentStatus] || getStepQuestion(currentStatus, state, lang, null);
    }

    const fieldName = STEP_FIELD[currentStatus];
    const nextStatus = COLLECTION_STEPS[COLLECTION_STEPS.indexOf(currentStatus) + 1];
    await saveState(customerNumber, { [fieldName]: extracted, status: nextStatus, language: lang });

    const updatedState = await loadState(customerNumber);
    return getStepQuestion(nextStatus, updatedState, lang, null);
  }

  return s.fallback;
}

// ─── Look up WhatsApp connection for a phone number ID ────────────────────
async function lookupConnection(phoneNumberId) {
  const sql = neon(process.env.DATABASE_URL);

  try {
    const rows = await sql`
      SELECT * FROM repair_shop_whatsapp WHERE phone_number_id = ${phoneNumberId} LIMIT 1
    `;
    if (rows.length > 0) {
      const row = rows[0];
      const accessToken = decrypt(row.access_token_enc);
      if (accessToken) {
        return {
          accessToken,
          phoneNumberId: row.phone_number_id,
          apiVersion: process.env.META_API_VERSION || process.env.WHATSAPP_API_VERSION || "v19.0",
          repairShopId: row.repair_shop_id,
          wabaId: row.waba_id,
        };
      }
    }
  } catch (err) {
    console.error("[WhatsApp] DB lookup error:", err.message);
  }

  const globalToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const globalPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (globalToken && globalPhoneId) {
    if (!phoneNumberId || phoneNumberId === globalPhoneId) {
      return {
        accessToken: globalToken,
        phoneNumberId: globalPhoneId,
        apiVersion: process.env.META_API_VERSION || process.env.WHATSAPP_API_VERSION || "v19.0",
        repairShopId: null,
        wabaId: null,
      };
    }
  }

  return null;
}

// ─── Get media URL from WhatsApp ────────────────────────────────────────────
async function getMediaUrl(mediaId, accessToken, apiVersion) {
  if (!mediaId) return null;
  try {
    // First get the media URL
    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      id: mediaId,
      link: data.url || null,
      mime_type: data.mime_type || null,
      file_size: data.file_size || null,
      filename: data.filename || null,
    };
  } catch (e) {
    console.warn("[WhatsApp] Failed to get media URL:", e.message);
    return null;
  }
}

// ─── Get the raw request body for signature verification ────────────────────
function getRawBody(req) {
  if (req.body != null) {
    if (typeof req.body === "string") return Promise.resolve(req.body);
    return Promise.resolve(JSON.stringify(req.body));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

  const rawBody = await getRawBody(request);
  if (!rawBody) {
    console.error("[WhatsApp] Empty request body");
    return response.status(400).json({ error: "Empty request body" });
  }

  const appSecret = process.env.META_APP_SECRET;
  const metaSignature = request.headers["x-hub-signature-256"];

  if (appSecret) {
    if (!metaSignature) {
      console.error("[WhatsApp] Missing X-Hub-Signature-256 header");
      return response.status(403).json({ error: "Missing webhook signature" });
    }
    const isValid = await verifyWebhookSignature(rawBody, metaSignature, appSecret);
    if (!isValid) {
      console.error("[WhatsApp] Invalid X-Hub-Signature-256");
      return response.status(403).json({ error: "Invalid webhook signature" });
    }
  } else {
    console.warn("[WhatsApp] META_APP_SECRET not set — skipping webhook signature verification");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    console.error("[WhatsApp] Failed to parse request body JSON:", err.message);
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  const change = body?.entry?.[0]?.changes?.[0]?.value;
  const incomingMessage = change?.messages?.[0];
  const phoneNumberId = change?.metadata?.phone_number_id;

  // Handle non-text messages (images, documents)
  if (incomingMessage) {
    const msgType = incomingMessage.type;

    // Accept images and documents alongside text
    if (msgType === "image" || msgType === "document" || msgType === "text") {
      // Process the message below
    } else {
      return response.status(200).json({ received: true });
    }
  } else {
    return response.status(200).json({ received: true });
  }

  const customerNumber = incomingMessage.from;
  let customerText = "";
  let messageType = incomingMessage.type || "text";
  let mediaData = null;

  // Extract media data for images and documents
  if (messageType === "image" && incomingMessage.image) {
    customerText = incomingMessage.image.caption || "(sent an image)";
  } else if (messageType === "document" && incomingMessage.document) {
    customerText = incomingMessage.document.caption || "(sent a document)";
  } else if (messageType === "text") {
    customerText = incomingMessage.text?.body?.trim() || "";
  }

  const connection = await lookupConnection(phoneNumberId);

  if (!connection) {
    console.error("[WhatsApp] No WhatsApp connection found for phone_number_id:", phoneNumberId);
    return response.status(200).json({ received: true, warning: "No matching WhatsApp connection" });
  }

  const { accessToken, apiVersion, repairShopId } = connection;

  // Resolve media URL if there's an image or document
  if (messageType === "image" && incomingMessage.image?.id) {
    mediaData = await getMediaUrl(incomingMessage.image.id, accessToken, apiVersion);
  } else if (messageType === "document" && incomingMessage.document?.id) {
    mediaData = await getMediaUrl(incomingMessage.document.id, accessToken, apiVersion);
  }

  // Save inbound message
  await saveMessage(customerNumber, "customer", customerText);

  // Send typing indicator
  await sendTypingIndicator(phoneNumberId, customerNumber, accessToken, apiVersion);

  // Set repair_shop_id on conversation state if available
  if (repairShopId) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      const existing = await sql`
        SELECT id FROM conversation_state WHERE customer_number = ${customerNumber} LIMIT 1
      `;
      if (existing.length > 0) {
        await sql`
          UPDATE conversation_state SET repair_shop_id = ${repairShopId}, updated_at = now()
          WHERE customer_number = ${customerNumber} AND repair_shop_id IS NULL
        `;
      }
    } catch (err) {
      console.warn("[WhatsApp] Failed to set repair_shop_id:", err.message);
    }
  }

  // Run enhanced state machine
  const reply = await handleMessage(customerNumber, customerText, messageType, mediaData);

  // Save outbound reply
  await saveMessage(customerNumber, "bot", reply);

  // Send reply via WhatsApp Cloud API with retry
  let metaRes;
  for (let attempt = 0; attempt < 2; attempt++) {
    const payload = { messaging_product: "whatsapp", to: customerNumber, type: "text", text: { body: reply } };
    metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

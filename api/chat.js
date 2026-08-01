// api/chat.js
// 🌐 CoolCare Website Live Chat — public widget API.
// The SECOND front-end into the shared conversation engine
// (api/_lib/conversation-engine.js) alongside 💬 WhatsApp (api/whatsapp.js).
//
// Endpoints (all public — the widget runs on the customer's own website):
//   GET /api/chat?shopId=123            → widget config (branding, hours, enabled)
//   GET /api/chat?action=poll&shopId=..&visitorId=..&after=<iso>
//                                      → poll for new bot messages (history/reconnect)
//   POST /api/chat { action: "start", shopId, visitorId }
//                                      → begin a visitor session, get welcome
//   POST /api/chat { action: "send", shopId, visitorId, message }
//                                      → run the shared AI engine, return reply
//   POST /api/chat { action: "upload", shopId, visitorId, imageData }
//                                      → sanitize + return a storable image URL
//
// Security:
//   - CORS enabled for * (widget lives on arbitrary customer domains)
//   - Rate-limited per IP (chatLimiter) + visitor token sanity checks
//   - shopId validated: shop exists, widget enabled, subscription active
//   - Input sanitized (HTML/control chars stripped, length capped)
//   - Image uploads: allowlist MIME + base64 decode + size cap
//   - Prompt injection: handled in the engine's system prompts

const { neon } = require("@neondatabase/serverless");
const jwt = require("jsonwebtoken");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { chatLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const {
  handleMessage,
  saveState,
  loadState,
  saveMessage,
  loadShopKnowledge,
} = require("./_lib/conversation-engine");

// ─── CORS (public widget API) ────────────────────────────────────────────────
function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Max-Age", "86400");
}

// ─── Input sanitizers ─────────────────────────────────────────────────────────
function sanitizeText(value, maxLen = 2000) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\0/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

const VISITOR_RE = /^web_[A-Za-z0-9\-]{8,64}$/;

/**
 * Verify a signed Developer-Sandbox ticket. Only requests carrying a valid
 * JWT issued by /api/shop?action=sandbox-ticket (scoped to THIS shop) may
 * run the engine while the widget is disabled.
 */
async function isSandboxTicketValid(token, shopId) {
  if (!token || !process.env.JWT_SECRET) return false;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return !!(
      payload &&
      payload.scope === "sandbox" &&
      payload.channel === "website" &&
      parseInt(payload.shopId, 10) === parseInt(shopId, 10)
    );
  } catch (e) {
    return false;
  }
}

// ─── Allowed image MIME types + magic-byte checks ─────────────────────────────
const IMAGE_MIME = new Map([
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/webp", [0x52, 0x49, 0x46, 0x46]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
]);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB decoded

// ─── Allowed document MIME types + signature checks ───────────────────────────
const DOC_MIME = new Map([
  ["application/pdf", [0x25, 0x50, 0x44, 0x46]], // %PDF
  ["text/plain", null],
  ["text/csv", null],
  ["application/msword", null], // .doc
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", null], // .docx
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", null], // .xlsx
]);
const MAX_DOC_BYTES = 3 * 1024 * 1024; // 3 MB decoded — keep base64 body under Vercel's ~4.5MB request limit

/**
 * Validate a base64 data URL document. Returns { url, mimeType } or throws.
 */
function sanitizeDocumentData(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    const err = new Error("Invalid file data");
    err.statusCode = 400;
    throw err;
  }
  const comma = dataUrl.indexOf(",");
  if (comma === -1) { const e = new Error("Malformed file data"); e.statusCode = 400; throw e; }
  const header = dataUrl.slice(5, comma);
  const mime = header.split(";")[0];
  if (!DOC_MIME.has(mime)) {
    const e = new Error("Unsupported file type. Use PDF, TXT, CSV, DOC, DOCX or XLSX.");
    e.statusCode = 400;
    throw e;
  }
  const b64 = dataUrl.slice(comma + 1);
  let buffer;
  try {
    buffer = Buffer.from(b64, "base64");
  } catch {
    const e = new Error("Invalid base64 file data"); e.statusCode = 400; throw e;
  }
  if (buffer.length === 0) { const e = new Error("Empty file"); e.statusCode = 400; throw e; }
  if (buffer.length > MAX_DOC_BYTES) {
    const e = new Error("File is too large (max 3 MB)"); e.statusCode = 413; throw e;
  }
  // Magic byte check (only for formats with a known signature)
  const magic = DOC_MIME.get(mime);
  if (magic) {
    for (let i = 0; i < magic.length; i++) {
      if (buffer[i] !== magic[i]) {
        const e = new Error("File content does not match its declared type"); e.statusCode = 400; throw e;
      }
    }
  }
  return { url: dataUrl, mimeType: mime };
}

/**
 * Validate a base64 data URL image. Returns { url, mimeType } or throws.
 */
function sanitizeImageData(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    const err = new Error("Invalid image data");
    err.statusCode = 400;
    throw err;
  }
  const comma = dataUrl.indexOf(",");
  if (comma === -1) { const e = new Error("Malformed image data"); e.statusCode = 400; throw e; }
  const header = dataUrl.slice(5, comma);
  const mime = header.split(";")[0];
  if (!IMAGE_MIME.has(mime)) {
    const e = new Error("Unsupported image type. Use JPEG, PNG, WebP or GIF.");
    e.statusCode = 400;
    throw e;
  }
  const b64 = dataUrl.slice(comma + 1);
  let buffer;
  try {
    buffer = Buffer.from(b64, "base64");
  } catch {
    const e = new Error("Invalid base64 image data"); e.statusCode = 400; throw e;
  }
  if (buffer.length === 0) { const e = new Error("Empty image"); e.statusCode = 400; throw e; }
  if (buffer.length > MAX_IMAGE_BYTES) {
    const e = new Error("Image is too large (max 2 MB)"); e.statusCode = 413; throw e;
  }
  // Magic byte check (first bytes)
  const magic = IMAGE_MIME.get(mime);
  for (let i = 0; i < magic.length; i++) {
    if (buffer[i] !== magic[i]) {
      const e = new Error("File content does not match its declared type"); e.statusCode = 400; throw e;
    }
  }
  // webp: RIFF....WEBP — the WEBP signature sits 8 bytes in
  if (mime === "image/webp" && buffer.slice(8, 12).toString("ascii") !== "WEBP") {
    const e = new Error("File content does not match its declared type"); e.statusCode = 400; throw e;
  }
  return { url: dataUrl, mimeType: mime };
}

// ─── Load widget settings (with defaults) ────────────────────────────────────
async function loadWidgetSettings(sql, shopId) {
  let ws = null;
  try {
    const rows = await sql`SELECT * FROM widget_settings WHERE repair_shop_id = ${shopId} LIMIT 1`;
    ws = rows[0] || null;
  } catch (e) { /* table may not exist yet */ }
  if (!ws) {
    ws = {
      enabled: false,
      business_name: null,
      welcome_message: "",
      offline_message: "",
      primary_color: "#22c55e",
      accent_color: "#16a34a",
      widget_position: "bottom-right",
      logo_url: "",
      theme: "auto",
      show_avatar: true,
      auto_open: false,
      language: "en",
    };
  }
  return ws;
}

// ─── Business hours check (shop-local time) ───────────────────────────────────
async function isShopOpenNow(sql, shopId, aiSettings) {
  try {
    const shopRows = await sql`SELECT timezone FROM repair_shops WHERE id = ${shopId} LIMIT 1`;
    const tz = shopRows[0]?.timezone || "Asia/Kolkata";
    const settings = aiSettings || (await loadShopKnowledge(shopId));
    const bh = settings?.business_hours;
    if (!bh) return true; // no hours configured → assume open
    const hours = typeof bh === "string" ? JSON.parse(bh) : bh;
    if (!hours || Object.keys(hours).length === 0) return true;

    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const day = (get("weekday") || "").toLowerCase().slice(0, 3); // mon, tue...
    const hour = parseInt(get("hour"), 10) % 24;
    const minute = parseInt(get("minute"), 10) || 0;
    const today = hours[day];
    if (!today || !today.open || !today.close) return false;
    const toMin = (s) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
    const nowMin = hour * 60 + minute;
    const openMin = toMin(today.open);
    const closeMin = toMin(today.close);
    return nowMin >= openMin && nowMin <= closeMin;
  } catch (e) {
    console.warn("[chat] Business hours check failed:", e.message);
    return true;
  }
}

// ─── Validate shop for widget access ─────────────────────────────────────────
async function validateShop(sql, shopId, widget) {
  const rows = await sql`
    SELECT id, is_active, suspended_at, subscription_status, approval_status,
           shop_name, logo_url
    FROM repair_shops WHERE id = ${shopId} LIMIT 1
  `;
  const shop = rows[0];
  if (!shop || !shop.is_active || shop.suspended_at) {
    const e = new Error("Shop not found or inactive"); e.statusCode = 404; throw e;
  }
  if (widget !== undefined && !widget.enabled) {
    const e = new Error("Website chat is disabled for this shop"); e.statusCode = 403; throw e;
  }
  const subOk = shop.subscription_status === "active" || shop.subscription_status === "trial";
  if (!subOk) {
    const e = new Error("Subscription inactive"); e.statusCode = 403; throw e;
  }
  return shop;
}

// ─── Log a message to the unified dashboard log (whatsapp_conversations) ─────
async function logToConversations(sql, shopId, customerNumber, direction, messageText, channel = "website") {
  try {
    await sql`
      INSERT INTO whatsapp_conversations
        (repair_shop_id, customer_number, direction, message_text, channel, status, created_at)
      VALUES (${shopId}, ${customerNumber}, ${direction}, ${messageText}, ${channel}, 'delivered', now())
    `;
  } catch (e) {
    console.warn("[chat] Failed to log conversation row:", e.message);
  }
}

// ─── GET: widget config + poll ───────────────────────────────────────────────
async function handleGet(request, response) {
  setCors(response);
  const sql = neon(process.env.DATABASE_URL);
  const shopId = parseInt(request.query?.shopId, 10);
  if (!shopId || isNaN(shopId)) return response.status(400).json({ error: "Invalid shopId" });

  const widget = await loadWidgetSettings(sql, shopId);

  // Config request (default)
  if (!request.query?.action || request.query.action === "config") {
    // Even if disabled, return config so the widget can hide itself.
    if (!widget.enabled) return response.status(200).json({ enabled: false, shopId });
    const shop = await validateShop(sql, shopId, widget);
    const aiSettings = await loadShopKnowledge(shopId);
    const isOpen = await isShopOpenNow(sql, shopId, aiSettings);
    return response.status(200).json({
      enabled: true,
      shopId,
      businessName: widget.business_name || shop.shop_name,
      logoUrl: widget.logo_url || shop.logo_url || "",
      primaryColor: widget.primary_color || "#22c55e",
      accentColor: widget.accent_color || "#16a34a",
      widgetPosition: widget.widget_position || "bottom-right",
      theme: widget.theme || "auto",
      showAvatar: widget.show_avatar !== false,
      autoOpen: !!widget.auto_open,
      language: widget.language || "en",
      welcomeMessage: widget.welcome_message || "",
      offlineMessage: widget.offline_message ||
        "We've received your request. Our team is currently offline. Your booking has been recorded and a technician will contact you once the business opens.",
      greetingMessage: aiSettings?.greeting_message || "",
      isOpen,
      businessHours: aiSettings?.business_hours || {},
      workingDays: aiSettings?.working_days || ["mon", "tue", "wed", "thu", "fri", "sat"],
      languagesSpoken: aiSettings?.languages_spoken || [],
    });
  }

  // Poll for new bot messages (history sync / reconnect)
  if (request.query.action === "poll") {
    if (!widget.enabled) return response.status(200).json({ messages: [] });
    const visitorId = String(request.query?.visitorId || "");
    const after = String(request.query?.after || "");
    if (!VISITOR_RE.test(visitorId)) return response.status(400).json({ error: "Invalid visitor" });
    try {
      const afterDate = after ? new Date(after) : new Date(0);
      const rows = await sql`
        SELECT id, role, message, channel, created_at
        FROM conversations
        WHERE customer_number = ${visitorId} AND role = 'bot'
          AND created_at > ${afterDate}
        ORDER BY created_at ASC LIMIT 50
      `;
      return response.status(200).json({ messages: rows });
    } catch (e) {
      return response.status(200).json({ messages: [] });
    }
  }

  return response.status(400).json({ error: "Unknown GET action" });
}

// ─── POST: start / send / upload ─────────────────────────────────────────────
async function handlePost(request, response) {
  setCors(response);
  const sql = neon(process.env.DATABASE_URL);
  const body = request.body || {};
  const action = body.action;

  if (!["start", "send", "upload"].includes(action)) {
    return response.status(400).json({ error: "Invalid action" });
  }

  const shopId = parseInt(body.shopId, 10);
  if (!shopId || isNaN(shopId)) return response.status(400).json({ error: "Invalid shopId" });

  // Only enable-gated for actions that run the engine (uploads allowed when disabled
  // so a visitor's image still lands on the session before chat is cut off).
  // Sandbox mode requires a signed, short-lived ticket that ONLY the authenticated
  // shop owner can obtain (via /api/shop?action=sandbox-ticket). This lets the
  // Developer Sandbox page test the real widget before it's publicly enabled,
  // without letting strangers bypass a shop's disabled-widget gate.
  const widget = await loadWidgetSettings(sql, shopId);
  const isSandbox = await isSandboxTicketValid(body.sandboxToken, shopId);
  await validateShop(sql, shopId, action === "upload" || isSandbox ? undefined : widget);
  if (!widget.enabled && action !== "upload" && !isSandbox) {
    return response.status(403).json({ error: "Website chat is disabled for this shop" });
  }

  const visitorId = String(body.visitorId || "");
  if (!VISITOR_RE.test(visitorId)) return response.status(400).json({ error: "Invalid visitor id" });

  // ── START: ensure state row exists, return welcome ─────────────────────
  if (action === "start") {
    let state = null;
    try { state = await loadState(visitorId); } catch (e) { /* ok */ }
    if (!state) {
      await saveState(visitorId, {
        status: "COLLECTING_APPLIANCE",
        language: "en",
        channel: "website",
        repair_shop_id: shopId,
      });
    }
    const aiSettings = await loadShopKnowledge(shopId);
    const greeting = widget.welcome_message || aiSettings?.greeting_message ||
      "Hi! 👋 Welcome! Which appliance needs repair?";
    const isOpen = await isShopOpenNow(sql, shopId, aiSettings);
    return response.status(200).json({ visitorId, greeting, isOpen });
  }

  // ── UPLOAD: sanitize image ──────────────────────────────────────────────
  if (action === "upload") {
    try {
      const isImage = body.kind === "document" ? false : true;
      const { url, mimeType } = isImage
        ? sanitizeImageData(body.imageData)
        : sanitizeDocumentData(body.fileData);
      // Persist the file onto the visitor session so it lands on the booking
      try {
        const st = await loadState(visitorId);
        if (isImage) {
          const urls = Array.isArray(st?.image_urls) ? st.image_urls : [];
          urls.push(url);
          await saveState(visitorId, { image_urls: urls });
        } else {
          const urls = Array.isArray(st?.file_urls) ? st.file_urls : [];
          urls.push(url);
          await saveState(visitorId, { file_urls: urls });
        }
      } catch (e) { /* ok */ }
      return response.status(200).json({ url, mimeType });
    } catch (e) {
      return response.status(e.statusCode || 400).json({ error: e.message });
    }
  }

  // ── SEND: run the shared engine ─────────────────────────────────────────
  if (action === "send") {
    const message = sanitizeText(body.message, 2000);
    const messageType = body.messageType === "image" ? "image" : body.messageType === "document" ? "document" : "text";

    let mediaData = null;
    if (messageType === "image" && body.imageData) {
      try {
        const { url } = sanitizeImageData(body.imageData);
        mediaData = { id: "web-" + Date.now(), link: url, mime_type: "image/*", filename: "upload.jpg" };
      } catch (e) {
        return response.status(e.statusCode || 400).json({ error: e.message });
      }
    } else if (messageType === "document" && body.fileData) {
      try {
        const { url, mimeType } = sanitizeDocumentData(body.fileData);
        mediaData = { id: "web-" + Date.now(), link: url, mime_type: mimeType, filename: String(body.filename || "upload.pdf").slice(0, 100) };
      } catch (e) {
        return response.status(e.statusCode || 400).json({ error: e.message });
      }
    }

    // Ensure state exists (idempotent — engine also handles this)
    try {
      const st = await loadState(visitorId);
      if (!st) {
        await saveState(visitorId, {
          status: "COLLECTING_APPLIANCE", language: "en", channel: "website", repair_shop_id: shopId,
        });
      }
    } catch (e) { /* ok */ }

    // Save inbound
    const inboundLabel = message || (messageType === "image" ? "(sent an image)" : messageType === "document" ? "(sent a file)" : "");
    const savedIn = await saveMessage(visitorId, "customer", inboundLabel, "website");
    await logToConversations(sql, shopId, visitorId, "inbound", inboundLabel);

    // First-message detection — drives analytics + the new-chat notification so a
    // single visitor session counts once, not once per message.
    let firstMessage = false;
    try {
      const cnt = await sql`
        SELECT COUNT(*) AS c FROM conversations
        WHERE customer_number = ${visitorId} AND id <> ${savedIn?.id ?? 0}
      `;
      firstMessage = parseInt(cnt[0]?.c || "0", 10) === 0;
    } catch (e) { /* ok */ }

    // Business-hours check — outside hours we still run the engine and create the
    // booking, but the reply carries the offline notice (requirement).
    const isOpen = await isShopOpenNow(sql, shopId, null);

    // Run the SAME engine WhatsApp uses — channel = website, shopId stamped
    let reply = await handleMessage(visitorId, message, messageType, mediaData, {
      channel: "website",
      shopId,
    });

    // If a booking was created outside working hours, append the offline notice
    // so the visitor knows the team is away (requirement: booking still recorded).
    if (!isOpen && reply) {
      try {
        const st = await loadState(visitorId);
        if (st && st.booking_id) {
          const offlineMsg = widget.offline_message ||
            "We've received your request. Our team is currently offline. Your booking has been recorded and a technician will contact you once the business opens.";
          reply = reply + "\n\n" + offlineMsg;
        }
      } catch (e) { /* ok */ }
    }

    // Save outbound
    const savedBot = await saveMessage(visitorId, "bot", reply, "website");
    await logToConversations(sql, shopId, visitorId, "outbound", reply);

    // Track conversation in analytics — once per new visitor session
    if (firstMessage) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        await sql`
          INSERT INTO conversation_analytics (repair_shop_id, date, total_conversations)
          VALUES (${shopId}, ${today}, 1)
          ON CONFLICT (repair_shop_id, date)
          DO UPDATE SET total_conversations = conversation_analytics.total_conversations + 1
        `;
      } catch (e) { /* ok */ }
    }

    // Notify shop of a new website conversation (only first message)
    if (firstMessage) {
      try {
        await sql`
          INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
          VALUES (${shopId}, 'website_chat', 'New Website Chat 🌐',
                  ${`A visitor started chatting on your website.`}, '/shop-dashboard.html')
        `;
      } catch (e) { /* ok */ }
    }

    return response.status(200).json({ reply, visitorId, replyCreatedAt: savedBot?.created_at || null, isOpen });
  }

  return response.status(400).json({ error: "Unknown action" });
}

// ─── Router ──────────────────────────────────────────────────────────────────
module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  setCors(response);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  if (!allowMethods(request, response, "GET", "POST")) return;
  if (!applyLimit(request, response, chatLimiter)) return;

  if (request.method === "GET") return handleGet(request, response);
  return handlePost(request, response);
});

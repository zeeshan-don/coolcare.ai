// api/whatsapp.js
// CoolCare WhatsApp bot — webhook front-end for the shared conversation engine.
// 💬 WhatsApp is one of TWO channels that share the SAME engine:
//   💬 WhatsApp → this file (Meta Cloud API webhook)
//   🌐 Website  → api/chat.js (website widget API)
// All conversation logic (state machine, i18n, booking, technician assignment,
// human handoff, smart scheduling, knowledge base) lives in
// api/_lib/conversation-engine.js — never duplicated here.

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { webhookLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders, verifyWebhookSignature } = require("./_lib/security");
const { decrypt } = require("./_lib/encrypt");
const {
  handleMessage,
  saveMessage,
  loadState,
  isDuplicateRequest,
  logDashboardConversation,
  trackConversationFirstMessage,
} = require("./_lib/conversation-engine");

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
          apiVersion: process.env.META_API_VERSION || process.env.WHATSAPP_API_VERSION || "v25.0",
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
        apiVersion: process.env.META_API_VERSION || process.env.WHATSAPP_API_VERSION || "v25.0",
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

  const requestId = "wa-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  console.log("[whatsapp] message", JSON.stringify({ requestId, from: customerNumber, type: messageType, msgId: incomingMessage.id || null }));

  // Extract customer text BEFORE the dedupe check so the shared guard can use
  // both its in-memory signature AND the cross-instance DB lookup.
  if (messageType === "image" && incomingMessage.image) {
    customerText = incomingMessage.image.caption || "(sent an image)";
  } else if (messageType === "document" && incomingMessage.document) {
    customerText = incomingMessage.document.caption || "(sent a document)";
  } else if (messageType === "text") {
    customerText = incomingMessage.text?.body?.trim() || "";
  }

  // ── DUPLICATE SUPPRESSION (shared with Website Chat) ────────────────────
  // Meta webhooks are redelivered when a 200 isn't received quickly enough, and
  // the SAME message id can arrive twice. Without this guard the engine would
  // process the message twice → two AI replies. This is the same
  // isDuplicateRequest() the website widget API uses — one guard, both channels.
  if (await isDuplicateRequest({
    channel: "whatsapp",
    customerNumber,
    text: customerText,
    messageType,
    externalId: incomingMessage.id || null,
    requestId,
  })) {
    console.log("[whatsapp] duplicate message suppressed", JSON.stringify({ requestId, from: customerNumber, msgId: incomingMessage.id || null }));
    return response.status(200).json({ received: true, duplicate: true });
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
  const savedIn = await saveMessage(customerNumber, "customer", customerText);
  // Shared dashboard log — the SAME row Website Chat writes (one engine, two channels)
  await logDashboardConversation(repairShopId || null, customerNumber, "inbound", customerText, "whatsapp", requestId);
  // First-message tracking (total_conversations analytics + shop notification) —
  // runs right after the inbound is saved, BEFORE the bot reply is stored, so the
  // count is accurate. The SAME shared helper Website Chat uses.
  await trackConversationFirstMessage(repairShopId || null, customerNumber, "whatsapp", savedIn?.id ?? 0, requestId);

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

  // Run shared engine (channel = whatsapp; shopId + requestId stamped for logs/state)
  const reply = await handleMessage(customerNumber, customerText, messageType, mediaData, {
    channel: "whatsapp",
    shopId: repairShopId || null,
    requestId,
  });

  // Save outbound reply
  await saveMessage(customerNumber, "bot", reply);
  // Shared dashboard log — same row shape Website Chat writes
  await logDashboardConversation(repairShopId || null, customerNumber, "outbound", reply, "whatsapp", requestId);

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

  console.log("[whatsapp] reply sent", JSON.stringify({ requestId, from: customerNumber, replyLen: reply ? reply.length : 0 }));
  return response.status(200).json({ replied: true });
});

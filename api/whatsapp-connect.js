// api/whatsapp-connect.js
// Meta Embedded Signup flow for per-shop WhatsApp Business Account connection.
// Routes:
//   GET  /api/whatsapp-connect    → Meta OAuth callback (exchange code for token)
//   POST /api/whatsapp-connect    → See actions below
//
// POST actions (all require auth):
//   action=initiate     → Generate Embedded Signup URL, redirect shop admin to Meta
//   action=status       → Return current WhatsApp connection status for the shop
//   action=disconnect   → Remove WhatsApp connection for the shop
//   action=reconnect    → Generate a new signup URL (disconnect + initiate)
//   action=refresh      → Refresh the access token via Meta API
//
// Environment variables (platform-level, NEVER per-shop):
//   META_APP_ID            — Meta App ID
//   META_APP_SECRET        — Meta App Secret
//   META_API_VERSION       — e.g. v19.0 (defaults to v19.0)
//   META_WEBHOOK_VERIFY_TOKEN — Shared verify token for all shop webhooks
//   META_EMBEDDED_SIGNUP_CONFIG_ID — Config ID from Meta App Dashboard (optional)
//   APP_URL                — Your app's root URL (for redirect URIs)
//   GATEWAY_ENCRYPT_KEY    — AES-256-GCM key for encrypting access tokens

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { encrypt, decrypt } = require("./_lib/encrypt");
const { buildDemoWhatsAppConnectionResponse } = require("./_lib/demo-data");

// ─── Meta API helpers ────────────────────────────────────────────────────────

const META_API_VERSION = process.env.META_API_VERSION || "v19.0";
const META_GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

/**
 * Exchange an OAuth authorization code for a long-lived access token.
 * @param {string} code - The authorization code from Meta's redirect
 * @param {string} redirectUri - Must match the URI used in the signup flow
 * @returns {Promise<object>} { access_token, token_expiry, ... }
 */
async function exchangeCodeForToken(code, redirectUri) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("META_APP_ID and META_APP_SECRET must be configured");
  }

  const res = await fetch(
    `${META_GRAPH_URL}/oauth/access_token?grant_type=authorization_code&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}&client_id=${appId}&client_secret=${appSecret}`,
    { method: "GET", signal: AbortSignal.timeout(15000) }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error("[whatsapp-connect] Token exchange failed:", res.status, err);
    throw new Error(`Token exchange failed: ${res.status}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    tokenType: data.token_type || "bearer",
    expiresIn: data.expires_in || 5184000, // Default ~60 days
  };
}

/**
 * Extend a short-lived page token to a long-lived token (60 days).
 * @param {string} accessToken - The current access token
 * @returns {Promise<object>} { access_token, expires_in }
 */
async function extendToken(accessToken) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  const res = await fetch(
    `${META_GRAPH_URL}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${encodeURIComponent(accessToken)}`,
    { method: "GET", signal: AbortSignal.timeout(15000) }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error("[whatsapp-connect] Token extension failed:", res.status, err);
    throw new Error(`Token extension failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Fetch WhatsApp Business Account details (WABA ID, phone numbers, business name).
 * @param {string} accessToken - Valid long-lived access token
 * @returns {Promise<object>} { waba_id, phone_numbers, business_name, ... }
 */
async function fetchWabaDetails(accessToken) {
  // Step 1: Get the WABA ID (from /me/businesses or from the token's granted permissions)
  const meRes = await fetch(
    `${META_GRAPH_URL}/me?fields=id,name,accounts{id,name,phone_numbers}&access_token=${encodeURIComponent(accessToken)}`,
    { signal: AbortSignal.timeout(15000) }
  );

  if (!meRes.ok) {
    const err = await meRes.text();
    console.error("[whatsapp-connect] Failed to fetch WABA details:", meRes.status, err);
    throw new Error(`Failed to fetch WABA details: ${meRes.status}`);
  }

  const meData = await meRes.json();

  // Step 2: Extract WhatsApp Business Account from the response
  // The structure depends on Meta's API version and account setup.
  // Typically the accounts array contains WABA entries.
  let wabaId = null;
  let phoneNumbers = [];
  let businessName = meData.name || null;
  let businessId = meData.id || null;

  if (meData.accounts && meData.accounts.data) {
    for (const account of meData.accounts.data) {
      const accRes = await fetch(
        `${META_GRAPH_URL}/${account.id}?fields=id,name,phone_numbers,message_template_namespace&access_token=${encodeURIComponent(accessToken)}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (accRes.ok) {
        const accData = await accRes.json();
        if (accData.phone_numbers && accData.phone_numbers.data) {
          for (const pn of accData.phone_numbers.data) {
            phoneNumbers.push({
              phoneNumberId: pn.id,
              phoneNumber: pn.display_phone_number || pn.verified_name,
            });
          }
        }
        if (!wabaId) wabaId = account.id;
      }
    }
  }

  return {
    wabaId,
    phoneNumbers,
    businessName: businessName || "My Business",
    businessId,
  };
}

/**
 * Subscribe the webhook for a specific phone number ID.
 * This tells Meta to send incoming messages to our webhook endpoint.
 * @param {string} phoneNumberId - The phone number ID to subscribe
 * @param {string} accessToken - Access token with webhook scope
 * @returns {Promise<boolean>}
 */
async function subscribeWebhook(phoneNumberId, accessToken) {
  const res = await fetch(
    `${META_GRAPH_URL}/${phoneNumberId}/subscribed_apps?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscribed_fields: ["messages", "message_deliveries", "message_reads"],
      }),
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error("[whatsapp-connect] Webhook subscribe failed:", res.status, err);
    return false;
  }

  return true;
}

/**
 * Refresh the access token by extending it.
 * @param {string} currentToken - The current (possibly expiring) access token
 * @returns {Promise<object>} { access_token, expires_in }
 */
async function refreshAccessToken(currentToken) {
  return await extendToken(currentToken);
}

/**
 * Generate the Meta Embedded Signup URL for a shop.
 * @param {number} shopId - The repair shop ID
 * @returns {{ url: string, state: string }}
 */
function generateSignupUrl(shopId) {
  const appId = process.env.META_APP_ID;
  const configId = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;
  const appUrl = process.env.APP_URL || "http://localhost:3000";

  if (!appId) {
    throw new Error("META_APP_ID must be configured");
  }

  // Generate a signed state token to prevent CSRF
  const state = jwt.sign(
    { shopId, nonce: crypto.randomBytes(16).toString("hex"), ts: Date.now() },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );

  const redirectUri = `${appUrl}/api/whatsapp-connect`;

  // If a specific Embedded Signup config is provided, use it.
  // Otherwise, use the generic WhatsApp signup URL.
  if (configId) {
    return {
      url: `https://www.facebook.com/v${META_API_VERSION.replace("v", "")}/dialog/embedded_signup?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&config_id=${configId}`,
      state,
    };
  }

  // Fallback: Direct WhatsApp signup / WABA onboarding
  return {
    url: `https://business.facebook.com/${appId}/whatsapp_accounts/?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`,
    state,
  };
}

// ─── Database helpers ─────────────────────────────────────────────────────────

async function getWhatsAppConnection(sql, shopId) {
  const rows = await sql`
    SELECT * FROM repair_shop_whatsapp WHERE repair_shop_id = ${shopId} LIMIT 1
  `;
  if (!rows.length) return null;

  const row = rows[0];
  row.access_token = row.access_token_enc ? decrypt(row.access_token_enc) : null;
  row.refresh_token = row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null;

  // Never expose token to client (strip before returning)
  delete row.access_token_enc;
  delete row.refresh_token_enc;

  return row;
}

async function saveWhatsAppConnection(sql, shopId, data) {
  const accessTokenEnc = data.accessToken ? encrypt(data.accessToken) : null;
  const refreshTokenEnc = data.refreshToken ? encrypt(data.refreshToken) : null;

  const tokenExpiry = data.expiresIn
    ? new Date(Date.now() + data.expiresIn * 1000)
    : null;

  const existing = await sql`
    SELECT id FROM repair_shop_whatsapp WHERE repair_shop_id = ${shopId} LIMIT 1
  `;

  if (existing.length > 0) {
    await sql`
      UPDATE repair_shop_whatsapp SET
        phone_number_id = COALESCE(${data.phoneNumberId ?? null}, phone_number_id),
        waba_id = COALESCE(${data.wabaId ?? null}, waba_id),
        business_id = COALESCE(${data.businessId ?? null}, business_id),
        phone_number = COALESCE(${data.phoneNumber ?? null}, phone_number),
        business_name = COALESCE(${data.businessName ?? null}, business_name),
        access_token_enc = COALESCE(${accessTokenEnc}, access_token_enc),
        token_expiry = COALESCE(${tokenExpiry?.toISOString() ?? null}::timestamptz, token_expiry),
        refresh_token_enc = COALESCE(${refreshTokenEnc}, refresh_token_enc),
        webhook_status = COALESCE(${data.webhookStatus ?? null}, webhook_status),
        last_sync_at = now(),
        updated_at = now(),
        coexistence_mode = COALESCE(${data.coexistenceMode ?? false}, coexistence_mode)
      WHERE repair_shop_id = ${shopId}
    `;
  } else {
    await sql`
      INSERT INTO repair_shop_whatsapp
        (repair_shop_id, phone_number_id, waba_id, business_id, phone_number,
         business_name, access_token_enc, token_expiry, refresh_token_enc,
         webhook_status, coexistence_mode, whatsapp_connected_at)
      VALUES
        (${shopId}, ${data.phoneNumberId}, ${data.wabaId}, ${data.businessId ?? null},
         ${data.phoneNumber ?? null}, ${data.businessName ?? null},
         ${accessTokenEnc}, ${tokenExpiry?.toISOString() ?? null}::timestamptz,
         ${refreshTokenEnc}, ${data.webhookStatus || "active"},
         ${data.coexistenceMode ?? false}, now())
    `;
  }

  // Update repair_shops denormalized fields
  await sql`
    UPDATE repair_shops SET
      whatsapp_connected = ${data.phoneNumberId ? true : false},
      whatsapp_phone_number = ${data.phoneNumber ?? null},
      whatsapp_business_name = ${data.businessName ?? null},
      updated_at = now()
    WHERE id = ${shopId}
  `;
}

async function deleteWhatsAppConnection(sql, shopId) {
  await sql`DELETE FROM repair_shop_whatsapp WHERE repair_shop_id = ${shopId}`;

  // Reset repair_shops fields
  await sql`
    UPDATE repair_shops SET
      whatsapp_connected = false,
      whatsapp_phone_number = NULL,
      whatsapp_business_name = NULL,
      updated_at = now()
    WHERE id = ${shopId}
  `;
}

// ─── Build connection status response ─────────────────────────────────────────

function buildConnectionResponse(row) {
  if (!row) {
    return {
      connected: false,
      phoneNumber: null,
      businessName: null,
      wabaId: null,
      phoneNumberId: null,
      businessId: null,
      lastSync: null,
      webhookStatus: null,
      whatsappConnectedAt: null,
      tokenExpiry: null,
      canDisconnect: false,
      signupUrl: null,
    };
  }

  return {
    connected: row.webhook_status === "active" || row.webhook_status === "subscribed",
    phoneNumber: row.phone_number || null,
    businessName: row.business_name || null,
    wabaId: row.waba_id || null,
    phoneNumberId: row.phone_number_id || null,
    businessId: row.business_id || null,
    lastSync: row.last_sync_at || null,
    webhookStatus: row.webhook_status || null,
    whatsappConnectedAt: row.whatsapp_connected_at || null,
    tokenExpiry: row.token_expiry || null,
    // For coexistence — Meta may allow another provider's setup alongside ours
    coexistenceMode: row.coexistence_mode || false,
    canDisconnect: row.webhook_status === "active" || row.webhook_status === "subscribed",
  };
}

// ─── Vercel serverless handler ────────────────────────────────────────────────

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);

  const sql = neon(process.env.DATABASE_URL);

  // ── GET: Meta OAuth callback ──────────────────────────────────────────────
  if (request.method === "GET") {
    const { code, state, error: metaError, error_reason } = request.query || {};

    // Handle Meta signup errors
    if (metaError) {
      console.error("[whatsapp-connect] Meta signup error:", metaError, error_reason);
      // Try to decode state to find the shop
      let shopId = null;
      if (state) {
        try {
          const decoded = jwt.verify(state, process.env.JWT_SECRET);
          shopId = decoded.shopId;
        } catch (e) { /* state may be invalid or expired */ }
      }
      // Redirect back to shop dashboard with error
      const errorMsg = encodeURIComponent(metaError || "Signup cancelled or failed");
      return response.redirect(
        302,
        `${process.env.APP_URL || ""}/shop-dashboard.html?wa_error=${errorMsg}${shopId ? `&shop=${shopId}` : ""}`
      );
    }

    // Require code and state
    if (!code || !state) {
      return response.status(400).json({ error: "Missing code or state parameter. Use POST action=initiate to start signup." });
    }

    // Verify state (CSRF protection)
    let decodedState;
    try {
      decodedState = jwt.verify(state, process.env.JWT_SECRET);
    } catch (e) {
      console.error("[whatsapp-connect] Invalid or expired state:", e.message);
      return response.redirect(302, `${process.env.APP_URL || ""}/shop-dashboard.html?wa_error=invalid_state`);
    }

    const shopId = decodedState.shopId;
    const appUrl = process.env.APP_URL || `http://localhost:${request.headers.host?.split(":")[1] || 3000}`;
    const redirectUri = `${appUrl}/api/whatsapp-connect`;

    try {
      // Step 1: Exchange code for access token
      const tokenData = await exchangeCodeForToken(code, redirectUri);

      // Step 2: Extend to long-lived token (if not already long-lived)
      let accessToken = tokenData.accessToken;
      let expiresIn = tokenData.expiresIn;
      if (expiresIn < 3600 * 24 * 30) { // If less than 30 days, extend
        try {
          const extended = await extendToken(accessToken);
          accessToken = extended.access_token || accessToken;
          expiresIn = extended.expires_in || expiresIn;
        } catch (e) {
          console.warn("[whatsapp-connect] Token extension failed, using original:", e.message);
        }
      }

      // Step 3: Fetch WABA details
      const wabaDetails = await fetchWabaDetails(accessToken);

      if (!wabaDetails.wabaId || !wabaDetails.phoneNumbers.length) {
        console.error("[whatsapp-connect] No WABA or phone numbers found. Details:", JSON.stringify(wabaDetails));
        return response.redirect(302, `${appUrl}/shop-dashboard.html?wa_error=no_waba`);
      }

      // Use the first phone number (primary)
      const primaryPhone = wabaDetails.phoneNumbers[0];

      // Step 4: Subscribe webhook for this phone number
      let webhookStatus = "active";
      try {
        const subscribed = await subscribeWebhook(primaryPhone.phoneNumberId, accessToken);
        if (!subscribed) {
          console.warn("[whatsapp-connect] Webhook subscription attempt returned false");
          webhookStatus = "pending";
        } else {
          webhookStatus = "active";
        }
      } catch (e) {
        console.warn("[whatsapp-connect] Webhook subscribe failed, will retry later:", e.message);
        webhookStatus = "pending";
      }

      // Step 5: Save the connection
      await saveWhatsAppConnection(sql, shopId, {
        phoneNumberId: primaryPhone.phoneNumberId,
        wabaId: wabaDetails.wabaId,
        businessId: wabaDetails.businessId,
        phoneNumber: primaryPhone.phoneNumber,
        businessName: wabaDetails.businessName,
        accessToken,
        expiresIn,
        webhookStatus,
      });

      console.log(`[whatsapp-connect] Shop #${shopId} connected WhatsApp:`, {
        phoneNumber: primaryPhone.phoneNumber,
        wabaId: wabaDetails.wabaId,
        status: webhookStatus,
      });

      // Redirect to dashboard with success
      return response.redirect(302, `${appUrl}/shop-dashboard.html?wa_connected=true`);
    } catch (err) {
      console.error("[whatsapp-connect] Callback error:", err.message);
      return response.redirect(302, `${appUrl}/shop-dashboard.html?wa_error=${encodeURIComponent(err.message)}`);
    }
  }

  // ── POST actions (all require auth) ──────────────────────────────────────
  if (!allowMethods(request, response, "POST")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);

  // ── DEMO MODE ────────────────────────────────────────────────────────────
  const isDemo = auth.isDemo;
  if (isDemo) {
    const body = request.body || {};
    // Allow status check, but block write actions
    if (body.action === "status") {
      return response.status(200).json(buildDemoWhatsAppConnectionResponse());
    }
    return response.status(403).json({
      error: "This is a demo account. WhatsApp connection is simulated.",
      isDemo: true,
    });
  }

  const body = request.body || {};
  const action = body.action;

  switch (action) {
    case "initiate":
    case "reconnect":
      return handleInitiate(request, response, sql, shopId, action === "reconnect");

    case "status":
      return handleStatus(request, response, sql, shopId);

    case "disconnect":
      return handleDisconnect(request, response, sql, shopId);

    case "refresh":
      return handleRefresh(request, response, sql, shopId);

    default:
      return response.status(400).json({
        error: "Invalid action. Use: initiate, status, disconnect, reconnect, refresh",
      });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initiate the Meta Embedded Signup flow.
 * Generates the signup URL and returns it. The frontend redirects the user to Meta.
 * For "reconnect", disconnects the current connection first.
 */
async function handleInitiate(request, response, sql, shopId, isReconnect) {
  if (isReconnect) {
    // Disconnect existing connection before reconnecting
    await deleteWhatsAppConnection(sql, shopId);
  }

  try {
    const { url, state } = generateSignupUrl(shopId);

    // Store the state in the connection record (pending state)
    // We'll verify it when the callback comes back
    console.log(`[whatsapp-connect] Initiated signup for shop #${shopId}`);

    return response.status(200).json({
      success: true,
      signupUrl: url,
      state,
      message: isReconnect
        ? "Reconnecting WhatsApp. You will be redirected to Meta."
        : "You will be redirected to Meta to connect your WhatsApp Business Account.",
    });
  } catch (err) {
    console.error("[whatsapp-connect] Initiate error:", err.message);
    return response.status(500).json({ error: err.message });
  }
}

/**
 * Get the current WhatsApp connection status for the authenticated shop.
 */
async function handleStatus(request, response, sql, shopId) {
  try {
    const connection = await getWhatsAppConnection(sql, shopId);

    // Check if token is expired
    if (connection && connection.token_expiry) {
      const expiryDate = new Date(connection.token_expiry);
      if (expiryDate < new Date()) {
        connection.webhook_status = "expired";
        // Update DB
        await sql`
          UPDATE repair_shop_whatsapp SET webhook_status = 'expired', updated_at = now()
          WHERE repair_shop_id = ${shopId}
        `;
      }
    }

    // Also get the shop's cached display fields
    const shopRows = await sql`
      SELECT whatsapp_connected, whatsapp_phone_number, whatsapp_business_name
      FROM repair_shops WHERE id = ${shopId} LIMIT 1
    `;

    const shop = shopRows[0] || {};
    const statusResponse = buildConnectionResponse(connection);

    // Use shop-level denormalized fields as fallback
    if (!statusResponse.phoneNumber && shop.whatsapp_phone_number) {
      statusResponse.phoneNumber = shop.whatsapp_phone_number;
    }
    if (!statusResponse.connected && shop.whatsapp_connected) {
      statusResponse.connected = true;
    }

    return response.status(200).json(statusResponse);
  } catch (err) {
    console.error("[whatsapp-connect] Status error:", err.message);
    return response.status(500).json({ error: "Failed to get connection status" });
  }
}

/**
 * Disconnect the WhatsApp connection for the shop.
 */
async function handleDisconnect(request, response, sql, shopId) {
  try {
    await deleteWhatsAppConnection(sql, shopId);

    console.log(`[whatsapp-connect] Shop #${shopId} disconnected WhatsApp`);
    return response.status(200).json({
      success: true,
      message: "WhatsApp disconnected successfully.",
    });
  } catch (err) {
    console.error("[whatsapp-connect] Disconnect error:", err.message);
    return response.status(500).json({ error: "Failed to disconnect WhatsApp" });
  }
}

/**
 * Refresh the WhatsApp access token.
 */
async function handleRefresh(request, response, sql, shopId) {
  try {
    const connection = await getWhatsAppConnection(sql, shopId);
    if (!connection || !connection.access_token) {
      return response.status(400).json({ error: "No WhatsApp connection to refresh" });
    }

    const refreshed = await refreshAccessToken(connection.access_token);
    const newToken = refreshed.access_token;
    const expiresIn = refreshed.expires_in || 5184000; // ~60 days default

    // Update the stored token
    const encryptedToken = encrypt(newToken);
    const newExpiry = new Date(Date.now() + expiresIn * 1000);

    await sql`
      UPDATE repair_shop_whatsapp SET
        access_token_enc = ${encryptedToken},
        token_expiry = ${newExpiry.toISOString()}::timestamptz,
        last_sync_at = now(),
        webhook_status = 'active',
        updated_at = now()
      WHERE repair_shop_id = ${shopId}
    `;

    console.log(`[whatsapp-connect] Token refreshed for shop #${shopId}, expires: ${newExpiry.toISOString()}`);

    return response.status(200).json({
      success: true,
      tokenExpiry: newExpiry.toISOString(),
      message: "Access token refreshed successfully.",
    });
  } catch (err) {
    console.error("[whatsapp-connect] Refresh error:", err.message);
    return response.status(500).json({ error: "Failed to refresh token. Please reconnect." });
  }
}

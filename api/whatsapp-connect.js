// api/whatsapp-connect.js
// Meta Embedded Signup (v4, JavaScript SDK) flow for per-shop WhatsApp
// Business Account connection.
// Routes:
//   GET  /api/whatsapp-connect    → Legacy full-page OAuth callback (kept for compat)
//   POST /api/whatsapp-connect    → See actions below
//
// POST actions (all require auth):
//   action=initiate   → Return the JS-SDK launch config (appId, configId, state)
//   action=complete   → Exchange Meta's auth code for a business token, subscribe
//                       webhooks, register the phone number, save the per-shop
//                       connection (called with the WA_EMBEDDED_SIGNUP session data)
//   action=status     → Return current WhatsApp connection status for the shop
//   action=disconnect → Remove WhatsApp connection for the shop
//   action=reconnect  → Disconnect + initiate
//   action=refresh    → Best-effort token refresh via Meta API
//
// Environment variables (platform-level, NEVER per-shop):
//   META_APP_ID            — Meta App ID
//   META_APP_SECRET        — Meta App Secret
//   META_API_VERSION       — e.g. v25.0 (defaults to v25.0)
//   META_WEBHOOK_VERIFY_TOKEN — Shared verify token for all shop webhooks
//   META_EMBEDDED_SIGNUP_CONFIG_ID — REQUIRED. Facebook Login for Business config
//                       ID (App Dashboard → Facebook Login for Business →
//                       Configurations → 'WhatsApp Embedded Signup Configuration
//                       With 60 Expiration Token' template)
//   APP_URL                — Your app's root URL. Used to build the Meta OAuth
//                            redirect URI: ${APP_URL}/api/whatsapp-connect
//   GATEWAY_ENCRYPT_KEY    — AES-256-GCM key for encrypting access tokens

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { encrypt, decrypt } = require("./_lib/encrypt");
// Env priority for the app base URL (APP_URL → PUBLIC_WEBSITE_BASE_URL) is
// maintained in one place — api/_lib/config.js — and reused here.
const { getAppBaseUrl: getConfiguredAppBaseUrl } = require("./_lib/config");
const { buildDemoWhatsAppConnectionResponse } = require("./_lib/demo-data");

// ─── Meta API helpers ────────────────────────────────────────────────────────

const META_API_VERSION = process.env.META_API_VERSION || "v25.0";
const META_GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ─── Redirect URI resolution ──────────────────────────────────────────────────
// The Meta OAuth / WhatsApp Embedded Signup callback URI is generated from
// the SERVER-side environment config — NEVER hardcoded localhost.

/**
 * Resolve the app's public base URL used to build OAuth redirect URIs.
 *
 * Priority:
 *   1. APP_URL                  — production (https://coolcare.zeeshstudios.in)
 *   2. PUBLIC_WEBSITE_BASE_URL  — fallback single-domain deployment
 *   3. Request origin           — local development only (Host header)
 *
 * localhost:3000 appears ONLY when running locally with no APP_URL configured,
 * because the incoming Host header is then localhost:3000.
 *
 * @param {object} request - The incoming Vercel serverless request
 * @returns {string|null} Base URL without a trailing slash, or null
 */
function getAppBaseUrl(request) {
  // APP_URL (production) → PUBLIC_WEBSITE_BASE_URL — resolved via config.js
  // so the env priority lives in exactly one place.
  const configured = getConfiguredAppBaseUrl();
  if (configured) return configured.replace(/\/+$/, "");

  // Local dev / fallback: derive the origin from the incoming request.
  // Host header first — Vercel guarantees it and it cannot be spoofed.
  const host = request.headers.host || request.headers["x-forwarded-host"] || "";
  if (!host) return null;
  const proto =
    request.headers["x-forwarded-proto"] ||
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/**
 * Build the Meta OAuth callback URI for the WhatsApp Embedded Signup flow.
 *
 * This is the redirect_uri used by the legacy full-page flow and must match the
 * "Valid OAuth redirect URIs" configured in the Meta App Dashboard. With APP_URL
 * set in production this resolves to exactly:
 *
 *     https://coolcare.zeeshstudios.in/api/whatsapp-connect
 *
 * NOTE: Embedded Signup v4 (the JS SDK flow used by initiate/complete) does NOT
 * send a redirect_uri to Meta — the auth code is exchanged server-side without
 * one. This helper exists for the legacy GET callback and so the generated URI
 * can be surfaced and verified in the initiate response.
 *
 * @param {object} request - The incoming Vercel serverless request
 * @returns {string|null} e.g. "https://coolcare.zeeshstudios.in/api/whatsapp-connect"
 */
function buildRedirectUri(request) {
  const base = getAppBaseUrl(request);
  return base ? `${base}/api/whatsapp-connect` : null;
}

/**
 * Exchange an OAuth authorization code for a business access token.
 * Server-to-server only — NEVER called from the browser.
 *
 * Embedded Signup v4 (JS SDK) codes are exchanged WITHOUT a redirect_uri.
 * The legacy full-page flow passes redirectUri to match the signup URL.
 *
 * @param {string} code - The authorization code from Meta (30s TTL)
 * @param {string|null} redirectUri - Optional, only for the legacy flow
 * @returns {Promise<object>} { access_token, token_type, expires_in }
 */
async function exchangeCodeForToken(code, redirectUri) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("META_APP_ID and META_APP_SECRET must be configured");
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: appId,
    client_secret: appSecret,
  });
  if (redirectUri) params.set("redirect_uri", redirectUri);

  const res = await fetch(
    `${META_GRAPH_URL}/oauth/access_token?${params.toString()}`,
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
 * Fetch the business profile attached to a business token (from /me).
 * Used for display only — the WABA/phone IDs come from the signup session.
 * @param {string} accessToken - Business access token
 * @returns {Promise<object>} { businessId, businessName }
 */
async function fetchBusinessProfile(accessToken) {
  const res = await fetch(
    `${META_GRAPH_URL}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) {
    const err = await res.text();
    console.warn("[whatsapp-connect] Fetch /me failed:", res.status, err);
    return {};
  }
  const d = await res.json();
  return { businessId: d.id || null, businessName: d.name || null };
}

/**
 * Fetch display info for a connected business phone number.
 * @param {string} phoneNumberId - Business phone number ID
 * @param {string} accessToken - Business access token
 * @returns {Promise<object|null>} { phoneNumber, verifiedName, qualityRating }
 */
async function fetchPhoneNumberInfo(phoneNumberId, accessToken) {
  const res = await fetch(
    `${META_GRAPH_URL}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating&access_token=${encodeURIComponent(accessToken)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) {
    const err = await res.text();
    console.warn("[whatsapp-connect] Fetch phone info failed:", res.status, err);
    return null;
  }
  const d = await res.json();
  return {
    phoneNumber: d.display_phone_number || null,
    verifiedName: d.verified_name || null,
    qualityRating: d.quality_rating || null,
  };
}

/**
 * Subscribe the app to webhooks on the customer's WABA (Tech-Provider step 2).
 * @param {string} wabaId - WhatsApp Business Account ID
 * @param {string} accessToken - Business access token
 * @returns {Promise<boolean>}
 */
async function subscribeWabaWebhook(wabaId, accessToken) {
  const res = await fetch(
    `${META_GRAPH_URL}/${wabaId}/subscribed_apps?access_token=${encodeURIComponent(accessToken)}`,
    { method: "POST", signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) {
    const err = await res.text();
    console.warn("[whatsapp-connect] WABA webhook subscribe failed:", res.status, err);
    return false;
  }
  return true;
}

/**
 * Register the business phone number for Cloud API use (Tech-Provider step 3).
 * Requires a 6-digit two-step verification PIN chosen by us.
 * @param {string} phoneNumberId - Business phone number ID
 * @param {string} accessToken - Business access token
 * @param {string} pin - 6-digit PIN
 * @returns {Promise<boolean>}
 */
async function registerPhoneNumber(phoneNumberId, accessToken, pin) {
  const res = await fetch(
    `${META_GRAPH_URL}/${phoneNumberId}/register?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Register failed: ${res.status} ${err}`);
  }
  return true;
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
 * Build the JavaScript-SDK launch config for Embedded Signup (v4).
 * The browser calls FB.login() with these values — Meta returns the auth code
 * and asset IDs to the spawning window, so NO redirect URI is needed.
 *
 * The deprecated v2 full-page URL (dialog/embedded_signup) is intentionally
 * NOT used: Meta now recommends the JS SDK flow (v2 deprecates Oct 15 2026).
 *
 * @param {number} shopId - The repair shop ID
 * @returns {{ appId: string, configId: string, apiVersion: string, state: string }}
 * @throws {Error} If META_APP_ID or META_EMBEDDED_SIGNUP_CONFIG_ID are missing
 */
function getSignupConfig(shopId) {
  const appId = process.env.META_APP_ID;
  const configId = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;

  if (!appId) {
    throw new Error("META_APP_ID must be configured");
  }
  if (!configId) {
    throw new Error(
      "META_EMBEDDED_SIGNUP_CONFIG_ID is not set. Create a Facebook Login for Business configuration in the Meta App Dashboard (Facebook Login for Business → Configurations → 'WhatsApp Embedded Signup Configuration With 60 Expiration Token' template) and set its configuration ID here."
    );
  }

  // Signed state token to bind the flow to this shop (CSRF protection).
  const state = jwt.sign(
    { shopId, nonce: crypto.randomBytes(16).toString("hex"), ts: Date.now() },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );

  return { appId, configId, apiVersion: META_API_VERSION, state };
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

  const metadataJson = data.metadata ? JSON.stringify(data.metadata) : null;

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
        metadata = COALESCE(${metadataJson}::jsonb, metadata),
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
         webhook_status, coexistence_mode, whatsapp_connected_at, metadata)
      VALUES
        (${shopId}, ${data.phoneNumberId}, ${data.wabaId}, ${data.businessId ?? null},
         ${data.phoneNumber ?? null}, ${data.businessName ?? null},
         ${accessTokenEnc}, ${tokenExpiry?.toISOString() ?? null}::timestamptz,
         ${refreshTokenEnc}, ${data.webhookStatus || "active"},
         ${data.coexistenceMode ?? false}, now(), ${metadataJson ?? "{}"}::jsonb)
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
    // The redirect URI MUST match the URI used to launch the Meta flow. It is
    // generated from APP_URL (production) via buildRedirectUri() — the single
    // source of truth for this value. Never hardcoded localhost.
    const redirectUri = buildRedirectUri(request);
    const appUrl = getAppBaseUrl(request) || "";

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
    case "connect": // UI alias for initiate
    case "reconnect":
      return handleInitiate(request, response, sql, shopId, action === "reconnect");

    case "complete":
      return handleComplete(request, response, sql, shopId, body);

    case "status":
      return handleStatus(request, response, sql, shopId);

    case "disconnect":
      return handleDisconnect(request, response, sql, shopId);

    case "refresh":
      return handleRefresh(request, response, sql, shopId);

    default:
      return response.status(400).json({
        error: "Invalid action. Use: initiate, complete, status, disconnect, reconnect, refresh",
      });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initiate the Meta Embedded Signup flow (JS SDK / v4).
 * Returns the launch config (appId, configId, apiVersion, state). The frontend
 * uses these to call FB.login(); Meta returns the code + asset IDs to the
 * spawning window, so no redirect URI is required.
 * For "reconnect", disconnects the current connection first.
 */
async function handleInitiate(request, response, sql, shopId, isReconnect) {
  if (isReconnect) {
    // Disconnect existing connection before reconnecting
    await deleteWhatsAppConnection(sql, shopId);
  }

  try {
    const cfg = getSignupConfig(shopId);

    console.log(`[whatsapp-connect] Initiated signup for shop #${shopId}`);

    return response.status(200).json({
      success: true,
      appId: cfg.appId,
      configId: cfg.configId,
      apiVersion: cfg.apiVersion,
      state: cfg.state,
      // Informational — the JS SDK (v4) flow does not send this to Meta, but it
      // is the exact redirect URI the legacy flow / any full-page flow must use.
      // Generated from APP_URL (production), never hardcoded localhost.
      redirectUri: buildRedirectUri(request),
      message: isReconnect
        ? "Reconnecting WhatsApp. The Meta signup window will open."
        : "The Meta signup window will open to connect your WhatsApp Business Account.",
    });
  } catch (err) {
    console.error("[whatsapp-connect] Initiate error:", err.message);
    return response.status(500).json({ error: err.message });
  }
}

/**
 * Complete the Embedded Signup flow (JS SDK / v4).
 * Called by the frontend after FB.login() returns a code and the
 * WA_EMBEDDED_SIGNUP message event provides the customer's asset IDs.
 *
 * All Meta API calls happen server-side; the token never reaches the browser.
 *
 * @param {object} body - { code, phoneNumberId, wabaId, businessId, state }
 */
async function handleComplete(request, response, sql, shopId, body) {
  const { code, phoneNumberId, wabaId, businessId, state } = body || {};

  if (!code) {
    return response.status(400).json({ error: "Missing authorization code from Meta. Please retry." });
  }
  if (!phoneNumberId || !wabaId) {
    return response.status(400).json({
      error: "Meta did not return a phone number for this signup. Please reconnect and choose a business phone number.",
    });
  }

  // Bind the flow to this shop (CSRF protection). The code is only exchangeable
  // with our client_secret, but this prevents cross-shop replay of a captured pair.
  if (state) {
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (parseInt(decoded.shopId, 10) !== shopId) {
        return response.status(403).json({ error: "Signup state does not match this shop. Please retry." });
      }
    } catch (e) {
      console.warn("[whatsapp-connect] complete: state invalid/expired, continuing:", e.message);
    }
  }

  try {
    // Step 1: Exchange the code for a business token (server-side, 30s TTL).
    const tokenData = await exchangeCodeForToken(code, null);
    let accessToken = tokenData.accessToken;
    let expiresIn = tokenData.expiresIn;

    // Best-effort token extension (business tokens may not support fb_exchange_token).
    try {
      const extended = await extendToken(accessToken);
      if (extended.access_token) {
        accessToken = extended.access_token;
        expiresIn = extended.expires_in || expiresIn;
      }
    } catch (e) {
      console.warn("[whatsapp-connect] Token extension failed, using original:", e.message);
    }

    // Step 2: Fetch display data (business name, phone number).
    // This also VERIFIES the token actually owns the phone number the browser
    // reported — if it cannot, we refuse to save (prevents cross-shop spoofing).
    const profile = await fetchBusinessProfile(accessToken);
    const phoneInfo = await fetchPhoneNumberInfo(phoneNumberId, accessToken);
    if (!phoneInfo) {
      console.error("[whatsapp-connect] Cannot access phone number", phoneNumberId, "with the exchanged token — refusing to save.");
      return response.status(502).json({
        error: "Meta did not grant access to this phone number. Please disconnect and reconnect, choosing your own WhatsApp Business number.",
      });
    }

    // Step 3: Subscribe webhooks — WABA level (Tech-Provider step 2) + phone level.
    let webhookStatus = "active";
    try {
      const wabaOk = await subscribeWabaWebhook(wabaId, accessToken);
      const phoneOk = await subscribeWebhook(phoneNumberId, accessToken);
      if (!wabaOk && !phoneOk) {
        console.warn("[whatsapp-connect] Webhook subscription attempts returned false");
        webhookStatus = "pending";
      }
    } catch (e) {
      console.warn("[whatsapp-connect] Webhook subscribe failed, will retry later:", e.message);
      webhookStatus = "pending";
    }

    // Step 4: Register the phone number for Cloud API (Tech-Provider step 3).
    // If it is already registered, Meta rejects the PIN — keep the connection
    // but do not store a PIN that Meta does not recognise.
    let pin = null;
    try {
      pin = crypto.randomInt(100000, 1000000).toString();
      await registerPhoneNumber(phoneNumberId, accessToken, pin);
    } catch (e) {
      console.warn("[whatsapp-connect] Register failed (may already be registered):", e.message);
      pin = null;
    }

    // Step 5: Save the connection against THIS shop only.
    await saveWhatsAppConnection(sql, shopId, {
      phoneNumberId,
      wabaId,
      businessId: businessId || profile.businessId || null,
      phoneNumber: phoneInfo?.phoneNumber || null,
      businessName: profile.businessName || phoneInfo?.verifiedName || null,
      accessToken,
      expiresIn,
      webhookStatus,
      metadata: {
        pin,
        qualityRating: phoneInfo?.qualityRating || null,
        registeredAt: pin ? new Date().toISOString() : null,
        signupVersion: "v4",
      },
    });

    console.log(`[whatsapp-connect] Shop #${shopId} connected WhatsApp via Embedded Signup:`, {
      phoneNumberId,
      wabaId,
      phoneNumber: phoneInfo?.phoneNumber,
      status: webhookStatus,
    });

    return response.status(200).json({
      success: true,
      connected: webhookStatus === "active" || webhookStatus === "subscribed",
      webhookStatus,
      message: "WhatsApp connected successfully.",
    });
  } catch (err) {
    console.error("[whatsapp-connect] Complete error:", err.message);
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

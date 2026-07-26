// api/auth.js
// Unified auth endpoint — login, signup, logout, bootstrap, me, forgot-password, reset-password.
// POST /api/auth  body: { action: "login"|"signup"|"logout"|"bootstrap"|"bootstrap-check"|"me"|"forgot-password"|"reset-password", ... }
// Security: rate-limited, Zod-validated, security headers, error-wrapped.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");
const { signToken, makeJti, requireAuth } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { validate, loginSchema, signupSchema, bootstrapSchema, forgotPasswordSchema, resetPasswordTokenSchema } = require("./_lib/validate");
const { loginLimiter, signupLimiter, apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { sendEmail } = require("./_lib/notify");
const { createOrder, calculateAmount } = require("./_lib/gateway");

// Generate unique referral code: COOLCARE-XXXX
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return 'COOLCARE-' + code;
}

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "POST")) return;

  const body = request.body || {};
  const action = body.action;

  if (action === "login") return handleLogin(request, response, body);
  if (action === "signup") return handleSignup(request, response, body);
  if (action === "logout") return handleLogout(request, response);
  if (action === "bootstrap") return handleBootstrap(request, response, body);
  if (action === "bootstrap-check") return handleBootstrapCheck(request, response);
  if (action === "me") return handleMe(request, response);
  if (action === "forgot-password") return handleForgotPassword(request, response, body);
  if (action === "reset-password") return handleResetPassword(request, response, body);

  return response.status(400).json({ error: "Invalid action. Use: login, signup, logout, bootstrap, bootstrap-check, me, forgot-password, reset-password" });
});

// ─── LOGIN (unified — checks users table first, then repair_shops) ───────────
async function handleLogin(request, response, body) {
  if (!applyLimit(request, response, loginLimiter)) return;

  const data = validate({ ...request, body }, response, loginSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);
  const id = data.identifier.toLowerCase();
  const mobileClean = data.identifier.replace(/\s/g, "");

  const dummyHash = "$2a$12$invalidhashfortimingnormalization000000000000000000000000";

  // 1. Check users table first (platform staff + shop employees)
  let userRows = [];
  try {
    userRows = await sql`
      SELECT id, email, name, password_hash, role, repair_shop_id, is_active
      FROM users WHERE email = ${id} LIMIT 1
    `;
  } catch (e) { /* users table may not exist yet */ }

  if (userRows.length > 0) {
    const user = userRows[0];
    const passwordOk = await bcrypt.compare(data.password, user.password_hash);
    if (!passwordOk) return response.status(401).json({ error: "Invalid credentials" });
    if (!user.is_active) return response.status(403).json({ error: "This account has been disabled." });

    // Update last_login
    sql`UPDATE users SET last_login = now() WHERE id = ${user.id}`.catch(() => {});

    const jti = makeJti();
    const token = signToken({
      sub: user.id,
      role: user.role,
      user_type: "user",
      repair_shop_id: user.repair_shop_id || null,
    }, jti);

    console.log("[auth/login] user:", user.email, "role:", user.role);
    return response.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        userType: "user",
        repairShopId: user.repair_shop_id || null,
      },
    });
  }

  // Timing normalization: if no user found, still do a bcrypt compare
  // so attackers can't distinguish "email exists" from "email doesn't exist"
  if (userRows.length === 0) {
    await bcrypt.compare(data.password, dummyHash);
  }

  // 2. Check repair_shops table (shop owners, backward compat)
  const shopRows = await sql`
    SELECT id, shop_name, owner_name, email, mobile, password_hash, is_active, role, suspended_at
    FROM repair_shops
    WHERE email = ${id} OR mobile = ${mobileClean}
    LIMIT 1
  `;

  const shop = shopRows[0] || null;
  const hashToCheck = shop ? shop.password_hash : dummyHash;
  const passwordOk = await bcrypt.compare(data.password, hashToCheck);

  if (!shop || !passwordOk) {
    return response.status(401).json({ error: "Invalid credentials" });
  }
  if (!shop.is_active) {
    return response.status(403).json({ error: "This account has been deactivated." });
  }
  if (shop.suspended_at) {
    return response.status(403).json({ error: "This account has been suspended." });
  }

  const jti = makeJti();
  const token = signToken({
    sub: shop.id,
    role: shop.role || "owner",
    user_type: "shop",
    repair_shop_id: shop.id,
  }, jti);

  console.log("[auth/login] shop:", shop.email, "role:", shop.role || "owner");
  return response.status(200).json({
    token,
    user: {
      id: shop.id,
      name: shop.owner_name,
      shopName: shop.shop_name,
      email: shop.email,
      mobile: shop.mobile,
      role: shop.role || "owner",
      userType: "shop",
      repairShopId: shop.id,
    },
  });
}

// ─── SIGNUP (shop registration — creates repair_shop with role='owner') ──────
// Paid plans ONLY: every signup creates a Razorpay order.
// No free trial is ever activated. Accounts remain 'inactive' until payment + admin approval.
async function handleSignup(request, response, body) {
  if (!applyLimit(request, response, signupLimiter)) return;

  const data = validate({ ...request, body }, response, signupSchema);
  if (!data) return;

  console.log("[auth/signup] Received plan data:", {
    planName: data.planName,
    billingCycle: data.billingCycle,
    currency: data.currency,
  });

  const sql = neon(process.env.DATABASE_URL);
  const existing = await sql`
    SELECT id FROM repair_shops
    WHERE email = ${data.email} OR mobile = ${data.mobile}
    LIMIT 1
  `;
  if (existing.length > 0) {
    return response.status(409).json({ error: "An account with this email or mobile already exists" });
  }

  // Also check users table
  try {
    const existingUser = await sql`SELECT id FROM users WHERE email = ${data.email} LIMIT 1`;
    if (existingUser.length > 0) {
      return response.status(409).json({ error: "An account with this email already exists" });
    }
  } catch (e) { /* table may not exist */ }

  const passwordHash = await bcrypt.hash(data.password, 12);
  const safeServiceAreas = Array.isArray(data.serviceAreas) ? data.serviceAreas : [];
  const safeServicesOffered = Array.isArray(data.servicesOffered) ? data.servicesOffered : [];

  // Generate unique referral code
  let referralCode = generateReferralCode();
  try {
    const existing = await sql`SELECT id FROM repair_shops WHERE referral_code = ${referralCode} LIMIT 1`;
    if (existing.length > 0) referralCode = generateReferralCode(); // retry once
  } catch (e) { /* column may not exist yet */ }

  // Check for referral code in signup data
  let referredBy = null;
  if (body.referralCode) {
    try {
      const referrer = await sql`SELECT id FROM repair_shops WHERE referral_code = ${body.referralCode.toUpperCase()} LIMIT 1`;
      if (referrer.length > 0) referredBy = body.referralCode.toUpperCase();
    } catch (e) { /* ok */ }
  }

  // ── Create shop as inactive — NO free trial, NO auto-activation ─────────
  // Account will only be usable after payment + super admin approval.
  const planName = data.planName || 'pro';
  const billingCycle = data.billingCycle || 'monthly';
  const currency = (data.currency || 'USD').toUpperCase();

  console.log("[auth/signup] Decision path:", {
    planName,
    billingCycle,
    currency,
    reason: 'PAID_PLAN_ONLY — creating payment order (no free trial)',
  });

  const rows = await sql`
    INSERT INTO repair_shops
      (shop_name, owner_name, email, mobile, password_hash,
       address, city, service_areas, services_offered, role,
       subscription_status, referral_code, referred_by)
    VALUES
      (${data.shopName}, ${data.ownerName}, ${data.email}, ${data.mobile}, ${passwordHash},
       ${data.address || null}, ${data.city}, ${safeServiceAreas}, ${safeServicesOffered}, 'owner',
       'inactive', ${referralCode}, ${referredBy})
    RETURNING id, shop_name, owner_name, email, mobile, city, created_at
  `;
  const shop = rows[0];
  console.log("[auth/signup] Shop created:", { id: shop.id, email: shop.email, subscriptionStatus: 'inactive' });

  // Create referral record if referred
  if (referredBy) {
    try {
      const referrer = await sql`SELECT id FROM repair_shops WHERE referral_code = ${referredBy} LIMIT 1`;
      if (referrer.length > 0) {
        await sql`
          INSERT INTO referrals (referrer_shop_id, referred_shop_id, referral_code, status)
          VALUES (${referrer[0].id}, ${shop.id}, ${referredBy}, 'pending')
        `;
      }
    } catch (e) { console.warn("[auth/signup] Referral record creation failed:", e.message); }
  }

  const jti = makeJti();
  const token = signToken({
    sub: shop.id,
    role: "owner",
    user_type: "shop",
    repair_shop_id: shop.id,
  }, jti);

  // ── Create Razorpay order (paid plan only, no free trial) ────────────────
  console.log("[auth/signup] Creating payment order for shop #" + shop.id);

  try {
    // Calculate the amount
    const { amount } = calculateAmount(currency, billingCycle);
    console.log("[auth/signup] Amount calculated:", { amount, currency, billingCycle });

    const invoiceNumber = `INV-${Date.now()}-${shop.id}`;

    // Create payment record
    const payment = await sql`
      INSERT INTO payments (repair_shop_id, gateway, currency, amount, status, invoice_number, description, metadata)
      VALUES (${shop.id}, 'pending', ${currency}, ${amount}, 'pending', ${invoiceNumber},
              ${`CoolCare Pro — ${billingCycle}`},
              ${JSON.stringify({ billingCycle, planName, source: 'signup' })}::jsonb)
      RETURNING id
    `;

    const paymentDbId = payment[0].id;
    console.log("[auth/signup] Payment record created:", { paymentDbId, amount, invoiceNumber });

    // Create order via gateway
    const originUrl = request.headers["origin"] || "https://coolcare.ai";
    const orderResult = await createOrder({
      shopId: shop.id,
      billingCycle,
      currency,
      amount,
      invoiceNumber,
      paymentDbId,
      originUrl,
    });

    console.log("[auth/signup] Gateway order result:", orderResult);

    if (orderResult.error) {
      console.error("[auth/signup] Gateway order failed:", orderResult.error);

      // Log failure
      try {
        await sql`
          INSERT INTO payment_logs (payment_id, repair_shop_id, gateway, event_type, severity, message, error_message)
          VALUES (${paymentDbId}, ${shop.id}, ${orderResult.gateway || 'razorpay'}, 'order_failed', 'error',
                  'Signup order creation failed', ${orderResult.error})
        `;
      } catch (e) { /* ok */ }

      // Return success with token, but indicate checkout failed
      return response.status(201).json({
        token,
        shop: {
          id: shop.id,
          name: shop.owner_name,
          shopName: shop.shop_name,
          email: shop.email,
          mobile: shop.mobile,
          city: shop.city,
          role: "owner",
          userType: "shop",
          repairShopId: shop.id,
          subscriptionStatus: "inactive",
          subscriptionRequired: true,
        },
        checkoutRequired: false,
        checkoutError: orderResult.error,
      });
    }

    // Update payment record with gateway info
    if (orderResult.gateway && orderResult.gateway !== "none") {
      const gatewayId = orderResult.orderId || orderResult.sessionId || null;
      await sql`UPDATE payments SET gateway = ${orderResult.gateway}, payment_id = ${gatewayId} WHERE id = ${paymentDbId}`;
    }

    console.log("[auth/signup] Returning checkout payload for shop #" + shop.id);

    return response.status(201).json({
      token,
      shop: {
        id: shop.id,
        name: shop.owner_name,
        shopName: shop.shop_name,
        email: shop.email,
        mobile: shop.mobile,
        city: shop.city,
        role: "owner",
        userType: "shop",
        repairShopId: shop.id,
        subscriptionStatus: "inactive",
        subscriptionRequired: true,
      },
      checkoutRequired: true,
      gateway: orderResult.gateway || 'razorpay',
      orderId: orderResult.orderId || null,
      keyId: orderResult.keyId || null,
      amount: orderResult.amount || amount,
      currency: orderResult.currency || currency,
      invoiceNumber: orderResult.invoiceNumber || invoiceNumber,
      billingCycle,
      isTestMode: orderResult.isTestMode || false,
    });
  } catch (err) {
    console.error("[auth/signup] Payment order creation error:", err.message);

    // If payment setup fails, still create the account but indicate no checkout
    return response.status(201).json({
      token,
      shop: {
        id: shop.id,
        name: shop.owner_name,
        shopName: shop.shop_name,
        email: shop.email,
        mobile: shop.mobile,
        city: shop.city,
        role: "owner",
        userType: "shop",
        repairShopId: shop.id,
        subscriptionStatus: "inactive",
        subscriptionRequired: true,
      },
      checkoutRequired: false,
      checkoutError: err.message,
    });
  }
}

// ─── LOGOUT ──────────────────────────────────────────────────────────────────
async function handleLogout(request, response) {
  const authHeader = request.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) return response.status(200).json({ loggedOut: true });

  const decoded = jwt.decode(token);
  if (decoded?.jti && decoded?.exp) {
    const sql = neon(process.env.DATABASE_URL);
    const expiresAt = new Date(decoded.exp * 1000).toISOString();
    await sql`
      INSERT INTO jwt_denylist (jti, expires_at)
      VALUES (${decoded.jti}, ${expiresAt})
      ON CONFLICT (jti) DO NOTHING
    `;
    sql`DELETE FROM jwt_denylist WHERE expires_at < now()`.catch(() => {});
    console.log("[auth/logout] Token denylisted:", decoded.jti);
  }

  return response.status(200).json({ loggedOut: true });
}

// ─── BOOTSTRAP (create first super admin) ────────────────────────────────────
async function handleBootstrap(request, response, body) {
  if (!applyLimit(request, response, signupLimiter)) return;

  const data = validate({ ...request, body }, response, bootstrapSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);

  // Check if any super_admin already exists in users table.
  // If we cannot verify (DB error), default to BLOCKING bootstrap
  // rather than risking a duplicate super admin.
  let superAdminCheckOk = false;
  let superAdminCount = 0;
  try {
    const count = await sql`SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin'`;
    superAdminCount = parseInt(count[0]?.cnt || "0", 10);
    superAdminCheckOk = true;
  } catch (e) {
    console.error("[auth/bootstrap] Failed to check users table:", e.message);
  }

  if (!superAdminCheckOk) {
    return response.status(503).json({
      error: "Unable to verify Super Admin status. Please try again later.",
    });
  }

  if (superAdminCount > 0) {
    return response.status(403).json({ error: "A Super Admin already exists. Bootstrap is disabled." });
  }

  // Also check repair_shops for any super_admin
  try {
    const count2 = await sql`SELECT COUNT(*) as cnt FROM repair_shops WHERE role = 'super_admin'`;
    if (parseInt(count2[0]?.cnt || "0", 10) > 0) {
      return response.status(403).json({ error: "A Super Admin already exists. Bootstrap is disabled." });
    }
  } catch (e) {
    console.warn("[auth/bootstrap] Could not check repair_shops table:", e.message);
  }

  // Check email uniqueness
  try {
    const existing = await sql`SELECT id FROM users WHERE email = ${data.email} LIMIT 1`;
    if (existing.length > 0) {
      return response.status(409).json({ error: "Email already in use" });
    }
  } catch (e) { /* ok */ }

  const passwordHash = await bcrypt.hash(data.password, 12);

  const rows = await sql`
    INSERT INTO users (email, password_hash, name, role, is_active)
    VALUES (${data.email}, ${passwordHash}, ${data.name}, 'super_admin', true)
    RETURNING id, email, name, role
  `;
  const user = rows[0];

  const jti = makeJti();
  const token = signToken({
    sub: user.id,
    role: "super_admin",
    user_type: "user",
  }, jti);

  console.log("[auth/bootstrap] First super admin created:", user.email);
  return response.status(201).json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: "super_admin",
      userType: "user",
      repairShopId: null,
    },
  });
}

// ─── BOOTSTRAP CHECK (check if admin exists — no auth required) ────────
// Determines whether the login page shows the Setup form (no admin exists) vs Login form (admin exists).
async function handleBootstrapCheck(request, response) {
  if (!applyLimit(request, response, apiLimiter)) return;

  const sql = neon(process.env.DATABASE_URL);
  // Default: assume an admin exists (safe default — show normal login page).
  // Only set to true when we explicitly verify zero platform admins exist.
  let needsBootstrap = false;

  try {
    // Check for ANY platform admin role (super_admin, admin, support), not just super_admin.
    // Admins may be created via the admin panel with role='admin'.
    const count = await sql`SELECT COUNT(*) as cnt FROM users WHERE role IN ('super_admin', 'admin', 'support')`;
    const userCount = parseInt(count[0]?.cnt || "0", 10);
    console.log("[auth/bootstrap-check] users with admin role:", userCount);

    if (userCount === 0) {
      // No platform admins found in users table — check repair_shops as fallback
      try {
        const count2 = await sql`SELECT COUNT(*) as cnt FROM repair_shops WHERE role IN ('super_admin', 'admin', 'support')`;
        const shopCount = parseInt(count2[0]?.cnt || "0", 10);
        console.log("[auth/bootstrap-check] repair_shops with admin role:", shopCount);
        needsBootstrap = shopCount === 0;
      } catch (e2) {
        // repair_shops check failed — trust the users result (no admins found)
        console.warn("[auth/bootstrap-check] Failed to query repair_shops table:", e2.message);
        needsBootstrap = true;
      }
    }
    // If userCount > 0, needsBootstrap stays false (correct — admin exists)
  } catch (e) {
    // Database error — cannot verify. Default to safe: show login page.
    console.error("[auth/bootstrap-check] Failed to query users table:", e.message);
    needsBootstrap = false;
  }

  console.log("[auth/bootstrap-check] result:", { needsBootstrap });
  return response.status(200).json({ needsBootstrap });
}

// ─── ME (get current user info) ──────────────────────────────────────────────
async function handleMe(request, response) {
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const sql = neon(process.env.DATABASE_URL);
  const userId = parseInt(auth.sub, 10);
  const userType = auth.user_type || "shop";

  if (userType === "user") {
    try {
      const rows = await sql`
        SELECT id, email, name, role, repair_shop_id, is_active, last_login, created_at
        FROM users WHERE id = ${userId} LIMIT 1
      `;
      if (rows.length === 0) return response.status(404).json({ error: "User not found" });
      const u = rows[0];
      return response.status(200).json({
        user: {
          id: u.id, name: u.name, email: u.email, role: u.role,
          userType: "user", repairShopId: u.repair_shop_id,
          isActive: u.is_active, lastLogin: u.last_login,
        },
      });
    } catch (e) {
      return response.status(500).json({ error: "Failed to fetch user info" });
    }
  } else {
    const rows = await sql`
      SELECT id, shop_name, owner_name, email, mobile, city, role, is_active, created_at
      FROM repair_shops WHERE id = ${userId} LIMIT 1
    `;
    if (rows.length === 0) return response.status(404).json({ error: "Shop not found" });
    const s = rows[0];
    return response.status(200).json({
      user: {
        id: s.id, name: s.owner_name, shopName: s.shop_name,
        email: s.email, mobile: s.mobile, city: s.city,
        role: s.role || "owner", userType: "shop", repairShopId: s.id,
        isActive: s.is_active,
      },
    });
  }
}

// ─── FORGOT PASSWORD (generate reset token, send email) ─────────────────────
async function handleForgotPassword(request, response, body) {
  if (!applyLimit(request, response, signupLimiter)) return;

  const data = validate({ ...request, body }, response, forgotPasswordSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);

  // Generic message — never reveal if email exists
  const genericMsg = "If an account with that email exists, a password reset link has been sent.";

  // Look up user in both tables
  let userId = null;
  let userType = null;
  let userName = "";

  // Check users table first
  try {
    const rows = await sql`SELECT id, name FROM users WHERE email = ${data.email} LIMIT 1`;
    if (rows.length > 0) {
      userId = rows[0].id;
      userType = "user";
      userName = rows[0].name;
    }
  } catch (e) { /* table may not exist */ }

  // Check repair_shops table
  if (!userId) {
    try {
      const rows = await sql`SELECT id, owner_name FROM repair_shops WHERE email = ${data.email} LIMIT 1`;
      if (rows.length > 0) {
        userId = rows[0].id;
        userType = "shop";
        userName = rows[0].owner_name;
      }
    } catch (e) { /* ok */ }
  }

  if (!userId) {
    console.log("[auth/forgot-password] No account found for:", data.email);
    return response.status(200).json({ message: genericMsg });
  }

  // Rate limit: max 3 reset requests per hour per user
  try {
    const recent = await sql`
      SELECT COUNT(*) as cnt FROM password_reset_tokens
      WHERE user_id = ${userId} AND user_type = ${userType}
      AND created_at >= now() - INTERVAL '1 hour'
    `;
    if (parseInt(recent[0]?.cnt || "0", 10) >= 3) {
      return response.status(429).json({ error: "Too many reset requests. Please try again later." });
    }
  } catch (e) { /* table may not exist — allow */ }

  // Generate secure token
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

  // Store hashed token
  try {
    await sql`
      INSERT INTO password_reset_tokens (user_id, user_type, token_hash, expires_at)
      VALUES (${userId}, ${userType}, ${tokenHash}, ${expiresAt.toISOString()})
    `;
  } catch (e) {
    console.error("[auth/forgot-password] Failed to store token:", e.message);
    return response.status(200).json({ message: genericMsg });
  }

  // Build reset URL
  const baseUrl = process.env.APP_URL || "https://coolcare.ai";
  const resetUrl = `${baseUrl}/reset-password.html?token=${rawToken}`;

  // Send email
  const htmlBody = buildResetEmail(userName, resetUrl);
  const fromEmail = process.env.FROM_EMAIL || "noreply@coolcare.ai";

  const emailResult = await sendEmail(data.email, "Reset your CoolCare AI Password", htmlBody);

  if (!emailResult.ok) {
    console.error("[auth/forgot-password] Email send failed:", emailResult.error);
  }

  console.log("[auth/forgot-password] Reset requested for:", data.email, "type:", userType);
  return response.status(200).json({ message: genericMsg });
}

// ─── RESET PASSWORD (validate token, set new password) ─────────────────────
async function handleResetPassword(request, response, body) {
  if (!applyLimit(request, response, signupLimiter)) return;

  const data = validate({ ...request, body }, response, resetPasswordTokenSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);
  const tokenHash = crypto.createHash("sha256").update(data.token).digest("hex");

  // Find valid token
  let tokenRow = null;
  try {
    const rows = await sql`
      SELECT id, user_id, user_type, expires_at, used_at
      FROM password_reset_tokens
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `;
    tokenRow = rows[0] || null;
  } catch (e) {
    return response.status(500).json({ error: "Reset system unavailable. Please try again later." });
  }

  if (!tokenRow) {
    return response.status(400).json({ error: "Invalid or expired reset link." });
  }
  if (tokenRow.used_at) {
    return response.status(400).json({ error: "This reset link has already been used." });
  }
  if (new Date(tokenRow.expires_at) < new Date()) {
    return response.status(400).json({ error: "This reset link has expired." });
  }

  // Hash new password
  const passwordHash = await bcrypt.hash(data.password, 12);

  // Update password
  if (tokenRow.user_type === "user") {
    await sql`UPDATE users SET password_hash = ${passwordHash}, updated_at = now() WHERE id = ${tokenRow.user_id}`;
  } else {
    await sql`UPDATE repair_shops SET password_hash = ${passwordHash}, updated_at = now() WHERE id = ${tokenRow.user_id}`;
  }

  // Mark token as used
  await sql`UPDATE password_reset_tokens SET used_at = now() WHERE id = ${tokenRow.id}`;

  // Invalidate all other tokens for this user
  await sql`
    UPDATE password_reset_tokens SET used_at = now()
    WHERE user_id = ${tokenRow.user_id} AND user_type = ${tokenRow.user_type} AND used_at IS NULL
  `;

  console.log("[auth/reset-password] Password reset for user:", tokenRow.user_id, "type:", tokenRow.user_type);
  return response.status(200).json({ message: "Password has been reset successfully. You can now log in." });
}

// ─── BUILD RESET EMAIL HTML ──────────────────────────────────────────────────
function buildResetEmail(userName, resetUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#111111;border:1px solid #222;border-radius:12px;padding:40px;">
<tr><td style="text-align:center;padding-bottom:24px;">
  <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0;letter-spacing:-0.3px;">coolcare</h1>
</td></tr>
<tr><td style="padding:0 8px;">
  <p style="color:#a3a3a3;font-size:14px;margin:0 0 16px;">Hi ${userName || "there"},</p>
  <p style="color:#e5e5e5;font-size:15px;line-height:1.6;margin:0 0 24px;">
    We received a request to reset your CoolCare AI password. Click the button below to set a new password.
  </p>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
  <tr><td align="center">
    <a href="${resetUrl}" style="display:inline-block;background:#fff;color:#000;font-weight:600;font-size:14px;padding:12px 32px;border-radius:8px;text-decoration:none;letter-spacing:0.2px;">
      Reset Password
    </a>
  </td></tr>
  </table>
  <p style="color:#737373;font-size:12px;line-height:1.5;margin:0 0 8px;">
    Or copy this link into your browser:<br>
    <span style="color:#a3a3a3;word-break:break-all;">${resetUrl}</span>
  </p>
  <p style="color:#525252;font-size:12px;line-height:1.5;margin:0 0 16px;">
    This link expires in 30 minutes. If you didn't request this, you can safely ignore this email.
  </p>
</td></tr>
<tr><td style="text-align:center;padding-top:24px;border-top:1px solid #222;">
  <p style="color:#525252;font-size:11px;margin:0;">CoolCare AI &mdash; Better service, one conversation at a time.</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

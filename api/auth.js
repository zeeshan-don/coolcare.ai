// api/auth.js
// Unified auth endpoint — login, signup, logout, bootstrap, me.
// POST /api/auth  body: { action: "login"|"signup"|"logout"|"bootstrap"|"bootstrap-check"|"me", ... }
// Security: rate-limited, Zod-validated, security headers, error-wrapped.

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");
const { signToken, makeJti, requireAuth } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { validate, loginSchema, signupSchema, bootstrapSchema } = require("./_lib/validate");
const { loginLimiter, signupLimiter, apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");

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

  return response.status(400).json({ error: "Invalid action. Use: login, signup, logout, bootstrap, bootstrap-check, me" });
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
async function handleSignup(request, response, body) {
  if (!applyLimit(request, response, signupLimiter)) return;

  const data = validate({ ...request, body }, response, signupSchema);
  if (!data) return;

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

  const rows = await sql`
    INSERT INTO repair_shops
      (shop_name, owner_name, email, mobile, password_hash,
       address, city, service_areas, services_offered, role)
    VALUES
      (${data.shopName}, ${data.ownerName}, ${data.email}, ${data.mobile}, ${passwordHash},
       ${data.address || null}, ${data.city}, ${safeServiceAreas}, ${safeServicesOffered}, 'owner')
    RETURNING id, shop_name, owner_name, email, mobile, city, created_at
  `;
  const shop = rows[0];

  // Create trial subscription
  try {
    const starterPlan = await sql`SELECT id FROM subscription_plans WHERE name = 'starter' LIMIT 1`;
    if (starterPlan.length > 0) {
      await sql`
        INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, current_period_end)
        VALUES (${shop.id}, ${starterPlan[0].id}, 'trial', 'monthly', now() + INTERVAL '14 days')
      `;
    }
  } catch (e) { console.warn("[auth/signup] Trial creation failed:", e.message); }

  const jti = makeJti();
  const token = signToken({
    sub: shop.id,
    role: "owner",
    user_type: "shop",
    repair_shop_id: shop.id,
  }, jti);

  console.log("[auth/signup]", shop.email, "id:", shop.id);
  return response.status(201).json({
    token,
    user: {
      id: shop.id,
      name: shop.owner_name,
      shopName: shop.shop_name,
      email: shop.email,
      mobile: shop.mobile,
      city: shop.city,
      role: "owner",
      userType: "shop",
      repairShopId: shop.id,
    },
  });
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

  // Check if any super_admin already exists in users table
  let superAdminCount = 0;
  try {
    const count = await sql`SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin'`;
    superAdminCount = parseInt(count[0]?.cnt || "0", 10);
  } catch (e) { /* table may not exist yet — allow bootstrap */ }

  if (superAdminCount > 0) {
    return response.status(403).json({ error: "A Super Admin already exists. Bootstrap is disabled." });
  }

  // Also check repair_shops for any super_admin
  try {
    const count2 = await sql`SELECT COUNT(*) as cnt FROM repair_shops WHERE role = 'super_admin'`;
    if (parseInt(count2[0]?.cnt || "0", 10) > 0) {
      return response.status(403).json({ error: "A Super Admin already exists. Bootstrap is disabled." });
    }
  } catch (e) { /* ok */ }

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

// ─── BOOTSTRAP CHECK (check if super admin exists — no auth required) ────────
async function handleBootstrapCheck(request, response) {
  if (!applyLimit(request, response, apiLimiter)) return;

  const sql = neon(process.env.DATABASE_URL);
  let needsBootstrap = true;

  try {
    const count = await sql`SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin'`;
    if (parseInt(count[0]?.cnt || "0", 10) > 0) needsBootstrap = false;
  } catch (e) { /* table may not exist — bootstrap needed */ }

  if (needsBootstrap) {
    try {
      const count2 = await sql`SELECT COUNT(*) as cnt FROM repair_shops WHERE role = 'super_admin'`;
      if (parseInt(count2[0]?.cnt || "0", 10) > 0) needsBootstrap = false;
    } catch (e) { /* ok */ }
  }

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

// api/auth.js
// Consolidated auth endpoint — login, signup, logout.
// POST /api/auth  body: { action: "login" | "signup" | "logout", ... }
// Security: rate-limited, Zod-validated, security headers, error-wrapped.

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");
const { signToken, makeJti } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { validate, loginSchema, signupSchema } = require("./_lib/validate");
const { loginLimiter, signupLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "POST")) return;

  const body = request.body || {};
  const action = body.action;

  if (action === "login") return handleLogin(request, response, body);
  if (action === "signup") return handleSignup(request, response, body);
  if (action === "logout") return handleLogout(request, response);

  return response.status(400).json({ error: "Invalid action. Use: login, signup, or logout" });
});

// ─── LOGIN ──────────────────────────────────────────────
async function handleLogin(request, response, body) {
  if (!applyLimit(request, response, loginLimiter)) return;

  const data = validate({ ...request, body }, response, loginSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);
  const id = data.identifier.toLowerCase();
  const rows = await sql`
    SELECT id, shop_name, owner_name, email, mobile, password_hash, is_active, role, suspended_at
    FROM repair_shops
    WHERE email = ${id}
       OR mobile = ${data.identifier.replace(/\s/g, "")}
    LIMIT 1
  `;

  const dummyHash = "$2a$12$invalidhashfortimingnormalization000000000000000000000000";
  const shop = rows[0] || null;
  const hashToCheck = shop ? shop.password_hash : dummyHash;
  const passwordOk = await bcrypt.compare(data.password, hashToCheck);

  if (!shop || !passwordOk) {
    return response.status(401).json({ error: "Invalid credentials" });
  }
  if (!shop.is_active) {
    return response.status(403).json({ error: "This account has been deactivated. Please contact support." });
  }
  if (shop.suspended_at) {
    return response.status(403).json({ error: "This account has been suspended. Please contact support." });
  }

  const jti = makeJti();
  const token = signToken(shop.id, jti);
  console.log("[auth/login]", shop.email, "id:", shop.id);

  return response.status(200).json({
    token,
    shop: {
      id: shop.id, shopName: shop.shop_name, ownerName: shop.owner_name,
      email: shop.email, mobile: shop.mobile, role: shop.role || "shop",
    },
  });
}

// ─── SIGNUP ─────────────────────────────────────────────
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

  const passwordHash = await bcrypt.hash(data.password, 12);
  const safeServiceAreas = Array.isArray(data.serviceAreas) ? data.serviceAreas : [];
  const safeServicesOffered = Array.isArray(data.servicesOffered) ? data.servicesOffered : [];

  const rows = await sql`
    INSERT INTO repair_shops
      (shop_name, owner_name, email, mobile, password_hash,
       address, city, service_areas, services_offered, role)
    VALUES
      (${data.shopName}, ${data.ownerName}, ${data.email}, ${data.mobile}, ${passwordHash},
       ${data.address || null}, ${data.city}, ${safeServiceAreas}, ${safeServicesOffered}, 'shop')
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
  } catch (e) { console.warn("[auth/signup] Trial subscription creation failed:", e.message); }

  const jti = makeJti();
  const token = signToken(shop.id, jti);
  console.log("[auth/signup]", shop.email, "id:", shop.id);

  return response.status(201).json({
    token,
    shop: {
      id: shop.id, shopName: shop.shop_name, ownerName: shop.owner_name,
      email: shop.email, mobile: shop.mobile, city: shop.city, role: "shop",
    },
  });
}

// ─── LOGOUT ─────────────────────────────────────────────
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

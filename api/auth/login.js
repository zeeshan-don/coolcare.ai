// api/auth/login.js
// Repair shop login — accepts email or mobile + password.
// POST /api/auth/login
// Security: rate-limited, Zod-validated, security headers, error-wrapped.

const bcrypt = require("bcryptjs");
const { neon } = require("@neondatabase/serverless");
const { signToken, makeJti } = require("../_lib/auth");
const { withErrorHandler, allowMethods } = require("../_lib/errors");
const { validate, loginSchema } = require("../_lib/validate");
const { loginLimiter, applyLimit } = require("../_lib/rate-limit");
const { setSecurityHeaders } = require("../_lib/security");

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "POST")) return;

  // Rate limit: 5 attempts per 5 minutes per IP
  if (!applyLimit(request, response, loginLimiter)) return;

  // Zod validation
  const data = validate(request, response, loginSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);

  // Look up by email OR mobile
  const id = data.identifier.toLowerCase();
  const rows = await sql`
    SELECT id, shop_name, owner_name, email, mobile, password_hash, is_active, role, suspended_at
    FROM repair_shops
    WHERE email = ${id}
       OR mobile = ${data.identifier.replace(/\s/g, "")}
    LIMIT 1
  `;

  // Constant-time "not found" path to prevent user enumeration
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

  // Check if shop is suspended
  if (shop.suspended_at) {
    return response.status(403).json({ error: "This account has been suspended. Please contact support." });
  }

  const jti = makeJti();
  const token = signToken(shop.id, jti);

  console.log("[login] Repair shop logged in:", shop.email, "id:", shop.id);

  return response.status(200).json({
    token,
    shop: {
      id: shop.id,
      shopName: shop.shop_name,
      ownerName: shop.owner_name,
      email: shop.email,
      mobile: shop.mobile,
      role: shop.role || "shop",
    },
  });
});

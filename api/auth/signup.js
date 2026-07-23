// api/auth/signup.js
// Repair shop registration endpoint.
// POST /api/auth/signup
// Security: rate-limited, Zod-validated, security headers, error-wrapped.

const bcrypt = require("bcryptjs");
const { neon } = require("@neondatabase/serverless");
const { signToken, makeJti } = require("../_lib/auth");
const { withErrorHandler, allowMethods } = require("../_lib/errors");
const { validate, signupSchema } = require("../_lib/validate");
const { signupLimiter, applyLimit } = require("../_lib/rate-limit");
const { setSecurityHeaders } = require("../_lib/security");

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "POST")) return;

  // Rate limit: 3 signups per 10 minutes per IP
  if (!applyLimit(request, response, signupLimiter)) return;

  // Zod validation (includes password match check)
  const data = validate(request, response, signupSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);

  // Check uniqueness
  const existing = await sql`
    SELECT id FROM repair_shops
    WHERE email = ${data.email}
       OR mobile = ${data.mobile}
    LIMIT 1
  `;
  if (existing.length > 0) {
    return response.status(409).json({
      error: "An account with this email or mobile already exists",
    });
  }

  // Hash password
  const passwordHash = await bcrypt.hash(data.password, 12);

  // Safe array handling
  const safeServiceAreas = Array.isArray(data.serviceAreas) ? data.serviceAreas : [];
  const safeServicesOffered = Array.isArray(data.servicesOffered) ? data.servicesOffered : [];

  // Insert repair shop
  const rows = await sql`
    INSERT INTO repair_shops
      (shop_name, owner_name, email, mobile, password_hash,
       address, city, service_areas, services_offered, role)
    VALUES
      (${data.shopName},
       ${data.ownerName},
       ${data.email},
       ${data.mobile},
       ${passwordHash},
       ${data.address || null},
       ${data.city},
       ${safeServiceAreas},
       ${safeServicesOffered},
       'shop')
    RETURNING id, shop_name, owner_name, email, mobile, city, created_at
  `;

  const shop = rows[0];

  // Create trial subscription for new shop
  try {
    const starterPlan = await sql`
      SELECT id FROM subscription_plans WHERE name = 'starter' LIMIT 1
    `;
    if (starterPlan.length > 0) {
      await sql`
        INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, current_period_end)
        VALUES (${shop.id}, ${starterPlan[0].id}, 'trial', 'monthly', now() + INTERVAL '14 days')
      `;
    }
  } catch (subErr) {
    // Non-fatal — subscription table may not exist yet
    console.warn("[signup] Could not create trial subscription:", subErr.message);
  }

  const jti = makeJti();
  const token = signToken(shop.id, jti);

  console.log("[signup] New repair shop registered:", shop.email, "id:", shop.id);

  return response.status(201).json({
    token,
    shop: {
      id: shop.id,
      shopName: shop.shop_name,
      ownerName: shop.owner_name,
      email: shop.email,
      mobile: shop.mobile,
      city: shop.city,
      role: "shop",
    },
  });
});

// api/auth/signup.js
// Repair shop registration endpoint.
// POST /api/auth/signup
// Body: { shopName, ownerName, email, mobile, password, confirmPassword,
//         address, city, serviceAreas, servicesOffered }

const bcrypt = require("bcryptjs");
const { neon } = require("@neondatabase/serverless");
const { signToken, makeJti } = require("../_lib/auth");

// Basic email regex (RFC-ish)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Mobile: 10 digits, optionally prefixed with +91 or 91
const MOBILE_RE = /^(?:\+?91)?[6-9]\d{9}$/;

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const {
    shopName,
    ownerName,
    email,
    mobile,
    password,
    confirmPassword,
    address,
    city,
    serviceAreas    = [],
    servicesOffered = [],
  } = request.body || {};

  // ── Validation ─────────────────────────────────────────────────────────────
  const errors = {};

  if (!shopName?.trim())   errors.shopName  = "Shop name is required";
  if (!ownerName?.trim())  errors.ownerName = "Owner name is required";

  if (!email?.trim())          errors.email = "Email is required";
  else if (!EMAIL_RE.test(email.trim())) errors.email = "Invalid email address";

  if (!mobile?.trim())          errors.mobile = "Mobile number is required";
  else if (!MOBILE_RE.test(mobile.trim().replace(/\s/g, "")))
    errors.mobile = "Invalid Indian mobile number";

  if (!password)                errors.password = "Password is required";
  else if (password.length < 8) errors.password = "Password must be at least 8 characters";

  if (!confirmPassword)                      errors.confirmPassword = "Please confirm your password";
  else if (password !== confirmPassword)     errors.confirmPassword = "Passwords do not match";

  if (!city?.trim()) errors.city = "City is required";

  if (Object.keys(errors).length > 0) {
    return response.status(400).json({ error: "Validation failed", errors });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    // ── Check uniqueness ────────────────────────────────────────────────────
    const existing = await sql`
      SELECT id FROM repair_shops
      WHERE email = ${email.trim().toLowerCase()}
         OR mobile = ${mobile.trim().replace(/\s/g, "")}
      LIMIT 1
    `;
    if (existing.length > 0) {
      return response.status(409).json({
        error: "An account with this email or mobile already exists",
      });
    }

    // ── Hash password ───────────────────────────────────────────────────────
    const passwordHash = await bcrypt.hash(password, 12);

    // ── Insert repair shop ──────────────────────────────────────────────────
    const normalMobile        = mobile.trim().replace(/\s/g, "");
    const safeServiceAreas    = Array.isArray(serviceAreas)    ? serviceAreas    : [serviceAreas].filter(Boolean);
    const safeServicesOffered = Array.isArray(servicesOffered) ? servicesOffered : [servicesOffered].filter(Boolean);

    const rows = await sql`
      INSERT INTO repair_shops
        (shop_name, owner_name, email, mobile, password_hash,
         address, city, service_areas, services_offered)
      VALUES
        (${shopName.trim()},
         ${ownerName.trim()},
         ${email.trim().toLowerCase()},
         ${normalMobile},
         ${passwordHash},
         ${address?.trim() || null},
         ${city.trim()},
         ${safeServiceAreas},
         ${safeServicesOffered})
      RETURNING id, shop_name, owner_name, email, mobile, city, created_at
    `;

    const shop = rows[0];
    const jti   = makeJti();
    const token = signToken(shop.id, jti);

    console.log("[signup] New repair shop registered:", shop.email, "id:", shop.id);

    return response.status(201).json({
      token,
      shop: {
        id:        shop.id,
        shopName:  shop.shop_name,
        ownerName: shop.owner_name,
        email:     shop.email,
        mobile:    shop.mobile,
        city:      shop.city,
      },
    });
  } catch (err) {
    console.error("[signup] Error:", err.message, err);
    return response.status(500).json({ error: "Registration failed. Please try again." });
  }
};

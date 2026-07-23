// api/auth/login.js
// Repair shop login — accepts email or mobile + password.
// POST /api/auth/login
// Body: { identifier, password }
//   identifier = email OR mobile number

const bcrypt = require("bcryptjs");
const { neon } = require("@neondatabase/serverless");
const { signToken, makeJti } = require("../_lib/auth");

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const { identifier, password } = request.body || {};

  if (!identifier?.trim()) {
    return response.status(400).json({ error: "Email or mobile number is required" });
  }
  if (!password) {
    return response.status(400).json({ error: "Password is required" });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Look up by email OR mobile
    const id = identifier.trim().toLowerCase();
    const rows = await sql`
      SELECT id, shop_name, owner_name, email, mobile, password_hash, is_active
      FROM repair_shops
      WHERE email = ${id}
         OR mobile = ${identifier.trim().replace(/\s/g, "")}
      LIMIT 1
    `;

    // Use a constant-time "not found" path to prevent user enumeration
    const dummyHash = "$2a$12$invalidhashfortimingnormalization000000000000000000000000";
    const shop = rows[0] || null;
    const hashToCheck = shop ? shop.password_hash : dummyHash;

    const passwordOk = await bcrypt.compare(password, hashToCheck);

    if (!shop || !passwordOk) {
      return response.status(401).json({ error: "Invalid credentials" });
    }

    if (!shop.is_active) {
      return response.status(403).json({ error: "This account has been deactivated. Please contact support." });
    }

    const jti   = makeJti();
    const token = signToken(shop.id, jti);

    console.log("[login] Repair shop logged in:", shop.email, "id:", shop.id);

    return response.status(200).json({
      token,
      shop: {
        id:        shop.id,
        shopName:  shop.shop_name,
        ownerName: shop.owner_name,
        email:     shop.email,
        mobile:    shop.mobile,
      },
    });
  } catch (err) {
    console.error("[login] Error:", err.message, err);
    return response.status(500).json({ error: "Login failed. Please try again." });
  }
};

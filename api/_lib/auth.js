// api/_lib/auth.js
// JWT authentication middleware helper for Vercel serverless functions.
// Usage:
//   const { requireAuth } = require('../_lib/auth');
//   const shop = await requireAuth(request, response);
//   if (!shop) return; // response already sent

const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = "7d"; // tokens live for 7 days

// ─── Sign a new token ─────────────────────────────────────────────────────────
function signToken(shopId, jti) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET env var is not set");
  return jwt.sign(
    { sub: String(shopId), jti },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

// ─── Generate a short random JTI ─────────────────────────────────────────────
function makeJti() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Verify token and check denylist — returns decoded payload or null ────────
async function verifyToken(token) {
  if (!JWT_SECRET) {
    console.error("[auth] JWT_SECRET is not set");
    return null;
  }
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.warn("[auth] JWT verify failed:", err.message);
    return null;
  }

  // Check denylist (logout)
  if (decoded.jti) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      const rows = await sql`
        SELECT id FROM jwt_denylist WHERE jti = ${decoded.jti} LIMIT 1
      `;
      if (rows.length > 0) {
        console.warn("[auth] Token is on denylist (logged out):", decoded.jti);
        return null;
      }
    } catch (dbErr) {
      // If DB check fails, fail closed (reject the token)
      console.error("[auth] Denylist DB check error:", dbErr.message);
      return null;
    }
  }

  return decoded;
}

// ─── Express-style middleware: extract Bearer token, verify, attach shop id ──
// Returns the decoded payload (with .sub = shopId) or sends 401 and returns null.
async function requireAuth(request, response) {
  const authHeader = request.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    response.status(401).json({ error: "Authentication required" });
    return null;
  }

  const decoded = await verifyToken(token);
  if (!decoded) {
    response.status(401).json({ error: "Invalid or expired token" });
    return null;
  }

  return decoded; // { sub: "shopId", jti: "...", iat, exp }
}

module.exports = { signToken, makeJti, verifyToken, requireAuth };

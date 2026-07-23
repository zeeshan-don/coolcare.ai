// api/auth/logout.js
// Invalidates the current JWT by adding its JTI to the denylist.
// POST /api/auth/logout
// Security: security headers, error-wrapped.

const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");
const { withErrorHandler, allowMethods } = require("../_lib/errors");
const { setSecurityHeaders } = require("../_lib/security");

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "POST")) return;

  const authHeader = request.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return response.status(200).json({ loggedOut: true });
  }

  // Decode without verifying expiry so we can denylist already-expired tokens too
  const decoded = jwt.decode(token);

  if (decoded?.jti && decoded?.exp) {
    const sql = neon(process.env.DATABASE_URL);
    const expiresAt = new Date(decoded.exp * 1000).toISOString();

    await sql`
      INSERT INTO jwt_denylist (jti, expires_at)
      VALUES (${decoded.jti}, ${expiresAt})
      ON CONFLICT (jti) DO NOTHING
    `;

    // Clean up expired tokens while we're here (best-effort)
    sql`DELETE FROM jwt_denylist WHERE expires_at < now()`.catch(() => {});

    console.log("[logout] Token denylisted:", decoded.jti);
  }

  return response.status(200).json({ loggedOut: true });
});

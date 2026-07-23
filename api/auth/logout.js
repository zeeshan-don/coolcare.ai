// api/auth/logout.js
// Invalidates the current JWT by adding its JTI to the denylist.
// POST /api/auth/logout
// Headers: Authorization: Bearer <token>

const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = request.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    // Nothing to invalidate — treat as success
    return response.status(200).json({ loggedOut: true });
  }

  try {
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
  } catch (err) {
    console.error("[logout] Error:", err.message);
    // Still return success — the client should discard the token regardless
    return response.status(200).json({ loggedOut: true });
  }
};

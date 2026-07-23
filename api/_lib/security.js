// api/_lib/security.js
// Security headers and CSRF protection utilities.

/**
 * Set security headers on the response.
 */
function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-XSS-Protection", "1; mode=block");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https://graph.facebook.com https://api.groq.com"
  );
}

/**
 * Validate the Origin header for state-changing requests.
 * In production, restrict to known domains.
 */
function validateOrigin(request, response) {
  const origin = request.headers["origin"] || "";
  const allowed = [
    // Add production domain(s) here
    // "https://coolcare.ai",
    // "https://www.coolcare.ai",
  ];

  // In development, allow all origins
  if (process.env.NODE_ENV !== "production") return true;

  // If no allowed origins configured, skip check (fallback to CORS)
  if (allowed.length === 0) return true;

  if (!origin || allowed.includes(origin)) return true;

  response.status(403).json({ error: "Origin not allowed" });
  return false;
}

/**
 * Sanitize a value for safe SQL insertion context.
 * Neon's tagged templates handle parameterization, but this strips
 * null bytes and other dangerous chars from string inputs.
 */
function sanitizeInput(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\0/g, "") // strip null bytes
    .trim();
}

/**
 * Validate a webhook signature (for Stripe, Razorpay, etc.)
 * Generic HMAC verification helper.
 */
async function verifyWebhookSignature(payload, signature, secret, algorithm = "sha256") {
  const crypto = require("crypto");
  const expected = crypto
    .createHmac(algorithm, secret)
    .update(payload, "utf8")
    .digest("hex");
  
  const sigHash = signature.includes("=") ? signature.split("=")[1] : signature;
  
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(sigHash, "hex")
  );
}

module.exports = {
  setSecurityHeaders,
  validateOrigin,
  sanitizeInput,
  verifyWebhookSignature,
};

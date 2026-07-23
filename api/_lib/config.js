// api/_lib/config.js
// Centralized environment variable validation.
// Fails fast at startup if required vars are missing.

const REQUIRED = [
  "DATABASE_URL",
  "JWT_SECRET",
];

const OPTIONAL = [
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_API_VERSION",
  "META_WEBHOOK_VERIFY_TOKEN",
  "GROQ_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "FROM_EMAIL",
];

// Validate required env vars — throws if any are missing
function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `[config] Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

// Get a required env var — throws if missing
function env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`[config] Required env var "${key}" is not set`);
  return val;
}

// Get an optional env var with a default fallback
function envOpt(key, fallback = null) {
  return process.env[key] || fallback;
}

// Check if a feature is configured (e.g. WhatsApp, Stripe)
function hasFeature(key) {
  return !!process.env[key];
}

// Sanitize a string for logging — mask sensitive values
function mask(value, visibleChars = 4) {
  if (!value || typeof value !== "string") return "***";
  if (value.length <= visibleChars) return "***";
  return value.slice(0, visibleChars) + "***";
}

module.exports = { validateEnv, env, envOpt, hasFeature, mask };

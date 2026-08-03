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
  "META_APP_ID",
  "META_APP_SECRET",
  "META_API_VERSION",
  "META_EMBEDDED_SIGNUP_CONFIG_ID",
  "GROQ_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RESEND_API_KEY",
  "APP_URL",
  "PUBLIC_WEBSITE_BASE_URL",
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

/**
 * Base URL for HOSTED SHOP WEBSITES (public, /<slug> pages).
 * Configurable via PUBLIC_WEBSITE_BASE_URL — e.g.
 *   PUBLIC_WEBSITE_BASE_URL=https://coolcare.zeeshstudios.in
 * Falls back to APP_URL when the dedicated var is not set.
 */
function getWebsiteBaseUrl() {
  return process.env.PUBLIC_WEBSITE_BASE_URL || process.env.APP_URL || "";
}

/**
 * Base URL for app pages (dashboard, tracker, auth, payments, …).
 * Uses APP_URL; falls back to PUBLIC_WEBSITE_BASE_URL so a single
 * configured domain keeps every generated link working.
 */
function getAppBaseUrl() {
  return process.env.APP_URL || process.env.PUBLIC_WEBSITE_BASE_URL || "";
}

/**
 * Build the hosted website URL for a shop: ${PUBLIC_WEBSITE_BASE_URL}/${slug}
 * Returns null when no base URL is configured or the slug is missing
 * (callers already guard on truthiness before rendering links).
 */
function getHostedWebsiteUrl(slug) {
  if (!slug) return null;
  const base = getWebsiteBaseUrl().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/${slug}`;
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

module.exports = {
  validateEnv,
  env,
  envOpt,
  hasFeature,
  mask,
  getWebsiteBaseUrl,
  getAppBaseUrl,
  getHostedWebsiteUrl,
};

// api/_lib/encrypt.js
// AES-256-GCM encryption for sensitive data (gateway secrets, API keys).
// Uses GATEWAY_ENCRYPT_KEY env var (64-char hex = 32 bytes).
// Falls back to base64 encoding if key is not set (dev mode only).

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKey() {
  const hex = process.env.GATEWAY_ENCRYPT_KEY;
  if (!hex || hex.length < 32) {
    console.warn("[encrypt] GATEWAY_ENCRYPT_KEY not set or too short — using base64 fallback (NOT for production)");
    return null;
  }
  // Accept hex (64 chars) or raw string (32 chars)
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    return Buffer.from(hex, "hex");
  }
  // Pad/truncate to 32 bytes
  return crypto.createHash("sha256").update(hex).digest();
}

/**
 * Encrypt a plaintext string.
 * Returns: "enc:<iv_hex>:<tag_hex>:<ciphertext_hex>"
 * Or "b64:<base64>" if no encryption key available.
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  if (!key) {
    return "b64:" + Buffer.from(plaintext, "utf8").toString("base64");
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a previously encrypted string.
 * Handles both "enc:" (AES-GCM) and "b64:" (base64) formats.
 */
function decrypt(encrypted) {
  if (!encrypted) return null;

  // Base64 fallback
  if (encrypted.startsWith("b64:")) {
    return Buffer.from(encrypted.slice(4), "base64").toString("utf8");
  }

  // AES-256-GCM
  if (encrypted.startsWith("enc:")) {
    const key = getKey();
    if (!key) {
      console.error("[encrypt] Cannot decrypt — GATEWAY_ENCRYPT_KEY not set");
      return null;
    }
    const parts = encrypted.slice(4).split(":");
    if (parts.length !== 3) {
      console.error("[encrypt] Malformed encrypted string");
      return null;
    }
    const [ivHex, tagHex, ctHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const ct = Buffer.from(ctHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct) + decipher.final("utf8");
  }

  // Plain text (legacy / unencrypted — for backward compat with env vars)
  return encrypted;
}

/**
 * Mask a secret for display (show last 4 chars only).
 */
function mask(secret) {
  if (!secret) return "";
  if (secret.length <= 8) return "****";
  return "*" + "*".repeat(Math.max(4, secret.length - 5)) + secret.slice(-4);
}

module.exports = { encrypt, decrypt, mask };

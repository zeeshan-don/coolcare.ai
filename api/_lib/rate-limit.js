// api/_lib/rate-limit.js
// In-memory rate limiter for Vercel serverless functions.
// Uses a sliding window counter per IP address.
// NOTE: In multi-instance serverless, this is per-instance.
// For production scale, use Redis or Upstash Rate Limit.

const buckets = new Map();

// Clean up old entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of buckets) {
    if (now - data.windowStart > 120000) buckets.delete(key);
  }
}, 60000);

/**
 * Check rate limit for a given key.
 * @param {string} key - Unique identifier (IP + endpoint)
 * @param {number} maxRequests - Max requests allowed in the window
 * @param {number} windowMs - Window size in milliseconds
 * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
 */
function checkRateLimit(key, maxRequests = 20, windowMs = 60000) {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart > windowMs) {
    bucket = { count: 0, windowStart: now };
    buckets.set(key, bucket);
  }

  bucket.count++;
  const remaining = Math.max(0, maxRequests - bucket.count);
  const resetMs = bucket.windowStart + windowMs - now;

  return {
    allowed: bucket.count <= maxRequests,
    remaining,
    resetMs,
  };
}

/**
 * Express-style middleware factory for rate limiting.
 * @param {object} options
 * @param {number} options.max - Max requests per window
 * @param {number} options.window - Window in ms (default 60s)
 * @param {string} options.prefix - Key prefix for bucketing
 * @returns {function} middleware (req, res) => bool (true = allowed)
 */
function rateLimit({ max = 20, window = 60000, prefix = "global" } = {}) {
  return (request) => {
    const ip =
      request.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      request.headers["x-real-ip"] ||
      "unknown";
    const key = `${prefix}:${ip}`;
    return checkRateLimit(key, max, window);
  };
}

// Pre-configured limiters
const loginLimiter = rateLimit({ max: 5, window: 300000, prefix: "login" }); // 5 per 5 min
const signupLimiter = rateLimit({ max: 3, window: 600000, prefix: "signup" }); // 3 per 10 min
const apiLimiter = rateLimit({ max: 60, window: 60000, prefix: "api" }); // 60 per min
const webhookLimiter = rateLimit({ max: 100, window: 60000, prefix: "webhook" }); // 100 per min

/**
 * Apply rate limit and send 429 response if exceeded.
 * Returns true if request should continue, false if 429 was sent.
 */
function applyLimit(request, response, limiter) {
  const result = limiter(request);
  if (!result.allowed) {
    response.setHeader("Retry-After", Math.ceil(result.resetMs / 1000));
    response.setHeader("X-RateLimit-Remaining", "0");
    response.status(429).json({
      error: "Too many requests. Please try again later.",
      retryAfter: Math.ceil(result.resetMs / 1000),
    });
    return false;
  }
  response.setHeader("X-RateLimit-Remaining", String(result.remaining));
  return true;
}

module.exports = {
  checkRateLimit,
  rateLimit,
  loginLimiter,
  signupLimiter,
  apiLimiter,
  webhookLimiter,
  applyLimit,
};

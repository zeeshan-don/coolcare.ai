// api/health.js
// Health check endpoint — verifies DB connectivity and service status.
// GET /api/health

const { neon } = require("@neondatabase/serverless");
const { setSecurityHeaders } = require("./_lib/security");

module.exports = async (request, response) => {
  setSecurityHeaders(response);
  const start = Date.now();

  let dbOk = false;
  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`SELECT 1`;
    dbOk = true;
  } catch (err) {
    console.error("[health] DB check failed:", err.message);
  }

  const status = dbOk ? "healthy" : "degraded";
  const statusCode = dbOk ? 200 : 503;

  return response.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: dbOk ? "ok" : "failed",
      whatsapp: process.env.WHATSAPP_ACCESS_TOKEN ? "configured" : "not_configured",
      stripe: process.env.STRIPE_SECRET_KEY ? "configured" : "not_configured",
      razorpay: process.env.RAZORPAY_KEY_ID ? "configured" : "not_configured",
    },
    responseTime: Date.now() - start,
  });
};

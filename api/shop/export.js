// api/shop/export.js
// Export bookings as CSV for the authenticated shop.
// GET /api/shop/export?status=completed&from=2024-01-01&to=2024-12-31
// Security: auth required, multi-tenant (shop_id filter).

const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../_lib/auth");
const { withErrorHandler, allowMethods } = require("../_lib/errors");
const { apiLimiter, applyLimit } = require("../_lib/rate-limit");
const { setSecurityHeaders } = require("../_lib/security");

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "GET")) return;
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const shopId = parseInt(auth.sub, 10);
  const sql = neon(process.env.DATABASE_URL);

  const status = request.query?.status;
  const from = request.query?.from;
  const to = request.query?.to;

  let query = `
    SELECT b.id, b.customer_number, b.customer_name, b.service_type, b.area,
           b.address, b.urgency, b.status, b.priority, b.technician_name,
           b.technician_notes, b.estimated_cost, b.final_cost, b.invoice_number,
           b.created_at, b.updated_at
    FROM bookings b
    WHERE b.repair_shop_id = $1
  `;
  const params = [shopId];

  if (status && status !== "all") {
    params.push(status);
    query += ` AND b.status = $${params.length}`;
  }
  if (from) {
    params.push(from);
    query += ` AND b.created_at >= $${params.length}::timestamptz`;
  }
  if (to) {
    params.push(to + "T23:59:59");
    query += ` AND b.created_at <= $${params.length}::timestamptz`;
  }

  query += " ORDER BY b.created_at DESC LIMIT 5000";

  const bookings = await sql.unsafe(query, params);

  // Generate CSV
  const headers = ["ID", "Customer Phone", "Customer Name", "Service", "Area", "Address",
    "Urgency", "Status", "Priority", "Technician", "Notes", "Est. Cost", "Final Cost",
    "Invoice", "Created", "Updated"];

  const escapeCsv = (val) => {
    if (val == null) return "";
    const s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const csvRows = [headers.join(",")];
  bookings.forEach((b) => {
    csvRows.push([
      b.id, b.customer_number, b.customer_name, b.service_type, b.area,
      b.address, b.urgency, b.status, b.priority, b.technician_name,
      b.technician_notes, b.estimated_cost, b.final_cost, b.invoice_number,
      b.created_at, b.updated_at,
    ].map(escapeCsv).join(","));
  });

  response.setHeader("Content-Type", "text/csv");
  response.setHeader("Content-Disposition", `attachment; filename="coolcare-bookings-${Date.now()}.csv"`);
  return response.status(200).send(csvRows.join("\n"));
});

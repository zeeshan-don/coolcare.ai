// scripts/verify-dashboard-query.js
// Verifies the GET /api/shop?page=1&limit=20 dashboard query after the 42P18 fix.
//
// Mirrors the exact query-building logic in api/shop.js handleDashboard, prints the
// final SQL + parameter values, and checks that every declared parameter $1..$N is
// referenced in the SQL text. PostgreSQL throws 42P18 ("could not determine data type
// of parameter $N") when a declared parameter is never referenced in an inferable
// context — which is exactly what happened with the pre-fix code.
//
// Run: node scripts/verify-dashboard-query.js

const BOOKINGS_SELECT = `
    SELECT b.id, b.customer_number, b.customer_name, b.service_type, b.area,
           COALESCE(b.address, b.area, '') AS address,
           b.urgency, b.status, b.technician_id, b.technician_name,
           b.technician_notes, b.estimated_cost, b.final_cost,
           b.priority, b.customer_notes, b.invoice_number,
           COALESCE(b.source, 'whatsapp') AS source,
           b.created_at, b.updated_at,
           t.name AS assigned_technician_name, t.phone AS assigned_technician_phone
    FROM bookings b LEFT JOIN technicians t ON t.id = b.technician_id
    WHERE ${'${whereClause}'}
    ORDER BY b.${'${sortCol}'} ${'${sortDir}'}
    LIMIT $${'${sqlParams.length + 1}'} OFFSET $${'${sqlParams.length + 2}'}
  `;

// ── Exact replication of api/shop.js handleDashboard query building ──────────
function buildDashboardQueries(shopId, query) {
  const params = { page: 1, limit: 20, sortBy: "created_at", sortDir: "desc", ...query };

  const offset = (params.page - 1) * params.limit;

  // FIXED: repair_shop_id is now a real placeholder $1 (was interpolated as ${shopId}).
  const conditions = [`b.repair_shop_id = $1`];
  const sqlParams = [shopId];
  if (params.status && params.status !== "all") { sqlParams.push(params.status); conditions.push(`b.status = $${sqlParams.length}`); }
  if (params.search) { sqlParams.push(`%${params.search}%`); conditions.push(`(b.customer_name ILIKE $${sqlParams.length} OR b.customer_number ILIKE $${sqlParams.length})`); }
  const whereClause = conditions.join(" AND ");
  const sortCol = ["created_at", "updated_at", "status"].includes(params.sortBy) ? params.sortBy : "created_at";
  const sortDir = params.sortDir === "asc" ? "ASC" : "DESC";

  const bookingsSql = BOOKINGS_SELECT
    .replace("${whereClause}", whereClause)
    .replace("${sortCol}", sortCol)
    .replace("${sortDir}", sortDir)
    .replace("${sqlParams.length + 1}", sqlParams.length + 1)
    .replace("${sqlParams.length + 2}", sqlParams.length + 2);
  const bookingsParams = [...sqlParams, params.limit, offset];

  const countSql = `SELECT COUNT(*) as total FROM bookings b WHERE ${whereClause}`;
  const countParams = [...sqlParams];

  return { bookingsSql, bookingsParams, countSql, countParams };
}

// ── Pre-fix simulation (the buggy code) for demonstration ────────────────────
function buildBuggyQueries(shopId, query) {
  const params = { page: 1, limit: 20, sortBy: "created_at", sortDir: "desc", ...query };
  const offset = (params.page - 1) * params.limit;
  const conditions = [`b.repair_shop_id = ${shopId}`];   // ← interpolated, NOT a placeholder
  const sqlParams = [shopId];                            // ← but still counted as $1
  if (params.status && params.status !== "all") { sqlParams.push(params.status); conditions.push(`b.status = $${sqlParams.length}`); }
  if (params.search) { sqlParams.push(`%${params.search}%`); conditions.push(`(b.customer_name ILIKE $${sqlParams.length} OR b.customer_number ILIKE $${sqlParams.length})`); }
  const whereClause = conditions.join(" AND ");
  const bookingsSql = BOOKINGS_SELECT
    .replace("${whereClause}", whereClause)
    .replace("${sortCol}", "created_at")
    .replace("${sortDir}", "DESC")
    .replace("${sqlParams.length + 1}", sqlParams.length + 1)
    .replace("${sqlParams.length + 2}", sqlParams.length + 2);
  return {
    bookingsSql,
    bookingsParams: [...sqlParams, params.limit, offset],
    countSql: `SELECT COUNT(*) as total FROM bookings b WHERE ${whereClause}`,
    countParams: [...sqlParams],
  };
}

// ── PostgreSQL 42P18 precondition check ──────────────────────────────────────
// If a Parse message declares N parameters but the SQL text references only a
// subset (e.g. $2/$3 but not $1), the server cannot infer the type of the
// unreferenced parameter(s) → ERROR 42P18 "could not determine data type of
// parameter $1".
function checkPlaceholders(label, sqlText, params) {
  const refs = new Set();
  const re = /\$(\d+)/g;
  let m;
  while ((m = re.exec(sqlText)) !== null) refs.add(parseInt(m[1], 10));
  const declared = params.length;
  const missing = [];
  for (let i = 1; i <= declared; i++) if (!refs.has(i)) missing.push(`$${i}`);
  const ok = missing.length === 0;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}: declared=${declared} referenced=${[...refs].sort((a, b) => a - b).join(",") || "(none)"}` + (ok ? "" : `  → MISSING in SQL: ${missing.join(", ")} (42P18)`));
  return ok;
}

const shopId = 1; // example auth.sub for a real shop

console.log("══════════════════════════════════════════════════════════════════");
console.log("PRE-FIX (buggy) — GET /api/shop?page=1&limit=20");
console.log("══════════════════════════════════════════════════════════════════");
const buggy = buildBuggyQueries(shopId, {});
console.log("Bookings SQL:\n" + buggy.bookingsSql.trim());
console.log("Bookings params:", JSON.stringify(buggy.bookingsParams));
checkPlaceholders("bookings", buggy.bookingsSql, buggy.bookingsParams);
console.log("Count SQL:   " + buggy.countSql.trim());
console.log("Count params:", JSON.stringify(buggy.countParams));
checkPlaceholders("count", buggy.countSql, buggy.countParams);

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("POST-FIX — GET /api/shop?page=1&limit=20");
console.log("══════════════════════════════════════════════════════════════════");
const fixed = buildDashboardQueries(shopId, {});
console.log("Bookings SQL:\n" + fixed.bookingsSql.trim());
console.log("Bookings params:", JSON.stringify(fixed.bookingsParams));
checkPlaceholders("bookings", fixed.bookingsSql, fixed.bookingsParams);
console.log("Count SQL:   " + fixed.countSql.trim());
console.log("Count params:", JSON.stringify(fixed.countParams));
checkPlaceholders("count", fixed.countSql, fixed.countParams);

console.log("\n── Variants ────────────────────────────────────────────────────────");
let allOk = true;
for (const q of [
  { label: "status=open", query: { status: "open" } },
  { label: "search=raj", query: { search: "raj" } },
  { label: "status=open&search=raj", query: { status: "open", search: "raj" } },
  { label: "page=2&limit=10", query: { page: 2, limit: 10 } },
]) {
  const r = buildDashboardQueries(shopId, q.query);
  console.log(`\n${q.label}:`);
  console.log("  SQL WHERE..: " + r.bookingsSql.trim().split("\n").pop().trim());
  console.log("  params:     " + JSON.stringify(r.bookingsParams));
  allOk = checkPlaceholders("bookings", r.bookingsSql, r.bookingsParams) && allOk;
  allOk = checkPlaceholders("count", r.countSql, r.countParams) && allOk;
}

console.log("\n" + (allOk ? "✅ ALL QUERIES: every declared parameter $1..$N is referenced → no 42P18." : "❌ Some queries still violate the placeholder rule."));
process.exit(allOk ? 0 : 1);

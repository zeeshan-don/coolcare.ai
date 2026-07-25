// api/_lib/auth.js
// JWT authentication + role-based authorization for Vercel serverless functions.
// Supports two user sources: `users` table (platform staff + shop employees)
// and `repair_shops` table (shop owners, backward compat).

const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = "7d";

// ─── Sign a new token ─────────────────────────────────────────────────────────
// payload: { sub, role, user_type, repair_shop_id? }
function signToken(payload, jti) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET env var is not set");
  const data = {
    sub: String(payload.sub),
    role: payload.role || "shop",
    user_type: payload.user_type || "shop",   // 'user' | 'shop'
    jti,
  };
  if (payload.repair_shop_id) data.repair_shop_id = payload.repair_shop_id;
  return jwt.sign(data, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// ─── Generate a short random JTI ─────────────────────────────────────────────
function makeJti() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Verify token and check denylist ──────────────────────────────────────────
async function verifyToken(token) {
  if (!JWT_SECRET) {
    console.error("[auth] JWT_SECRET is not set");
    return null;
  }
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.warn("[auth] JWT verify failed:", err.message);
    return null;
  }

  if (decoded.jti) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      const rows = await sql`
        SELECT id FROM jwt_denylist WHERE jti = ${decoded.jti} LIMIT 1
      `;
      if (rows.length > 0) {
        console.warn("[auth] Token on denylist:", decoded.jti);
        return null;
      }
    } catch (dbErr) {
      console.error("[auth] Denylist DB error:", dbErr.message);
      return null;
    }
  }

  return decoded;
}

// ─── requireAuth: extract Bearer token, verify, return decoded payload ────────
async function requireAuth(request, response) {
  const authHeader = request.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    response.status(401).json({ error: "Authentication required" });
    return null;
  }

  const decoded = await verifyToken(token);
  if (!decoded) {
    response.status(401).json({ error: "Invalid or expired token" });
    return null;
  }

  return decoded; // { sub, role, user_type, repair_shop_id?, jti, iat, exp }
}

// ─── requireRole: verify the authenticated user has one of the allowed roles ──
// Looks up the actual role from DB (not just JWT claim) to prevent privilege escalation.
// Returns { id, role, user_type, repair_shop_id } or null (403 already sent).
async function requireRole(auth, sql, response, allowedRoles) {
  const userId = parseInt(auth.sub, 10);
  const userType = auth.user_type || "shop";

  let row = null;

  if (userType === "user") {
    const rows = await sql`
      SELECT id, role, repair_shop_id, is_active FROM users WHERE id = ${userId} LIMIT 1
    `;
    if (rows.length > 0) {
      row = { id: rows[0].id, role: rows[0].role, repair_shop_id: rows[0].repair_shop_id, is_active: rows[0].is_active };
    }
  } else {
    const rows = await sql`
      SELECT id, role, is_active FROM repair_shops WHERE id = ${userId} LIMIT 1
    `;
    if (rows.length > 0) {
      row = { id: rows[0].id, role: rows[0].role || "shop", repair_shop_id: rows[0].id, is_active: rows[0].is_active };
    }
  }

  if (!row || !row.is_active) {
    response.status(403).json({ error: "Access denied. Account inactive or not found." });
    return null;
  }

  if (!allowedRoles.includes(row.role)) {
    response.status(403).json({ error: `Role '${row.role}' is not authorized for this action.` });
    return null;
  }

  return { ...row, user_type: userType };
}

// ─── requirePlatformAdmin: shortcut for super_admin / admin / support ─────────
async function requirePlatformAdmin(auth, sql, response) {
  return requireRole(auth, sql, response, ["super_admin", "admin", "support"]);
}

// ─── requireSuperAdmin: only super_admin ──────────────────────────────────────
async function requireSuperAdmin(auth, sql, response) {
  return requireRole(auth, sql, response, ["super_admin"]);
}

// ─── requireShopOwner: owner or any shop role (backward compat) ──────────────
async function requireShopOwner(auth, sql, response) {
  return requireRole(auth, sql, response, ["owner", "shop", "manager"]);
}

// ─── Log admin action to audit trail ──────────────────────────────────────────
async function logAdminAction(sql, { actorType, actorId, action, targetType, targetId, details, ip }) {
  try {
    const detailsJson = details ? JSON.stringify(details) : '{}';
    await sql.unsafe(
      `INSERT INTO admin_action_log (actor_type, actor_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [actorType, actorId, action, targetType || null, targetId || null, detailsJson, ip || null]
    );
  } catch (e) {
    console.warn("[auth] Admin log insert failed:", e.message);
  }
}

// ─── requireActiveSubscription: check shop has active, non-expired subscription ─
// Returns { shopId, status } or null (403 already sent).
// Platform admins are always exempt.
async function requireActiveSubscription(auth, sql, response) {
  const userType = auth.user_type || "shop";
  const shopId = parseInt(auth.sub, 10);

  // Platform staff are exempt
  if (userType === "user") {
    const rows = await sql`SELECT role FROM users WHERE id = ${shopId} LIMIT 1`;
    if (rows.length > 0 && ["super_admin", "admin", "support"].includes(rows[0].role)) {
      return { shopId, status: "exempt" };
    }
  }

  // Check repair_shops subscription_status and approval_status
  const shop = await sql`
    SELECT subscription_status, approval_status, suspended_at FROM repair_shops WHERE id = ${shopId} LIMIT 1
  `;
  if (shop.length === 0) {
    response.status(403).json({ error: "Account not found." });
    return null;
  }
  if (shop[0].suspended_at) {
    response.status(403).json({ error: "This account has been suspended.", errorType: "suspended" });
    return null;
  }

  const subStatus = shop[0].subscription_status || "inactive";
  const approvalStatus = shop[0].approval_status || "none";

  // Check approval status — only approve shops can use features
  if (subStatus === "active" && approvalStatus !== "approved") {
    const msg = approvalStatus === 'pending'
      ? 'Your account is pending approval. A super admin will review and activate your account shortly.'
      : approvalStatus === 'rejected'
        ? 'Your account application was not approved. Please contact support.'
        : 'Your account has not been approved yet. Please wait for admin approval.';
    response.status(403).json({
      error: msg,
      errorType: 'approval_required',
      approvalStatus: approvalStatus || 'none',
    });
    return null;
  }

  if (subStatus === "active") {
    // Double-check expiry hasn't passed
    try {
      const sub = await sql`
        SELECT current_period_end FROM subscriptions
        WHERE repair_shop_id = ${shopId} AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
      `;
      if (sub.length > 0 && new Date(sub[0].current_period_end) < new Date()) {
        // Expired — update status
        await sql`UPDATE repair_shops SET subscription_status = 'expired', updated_at = now() WHERE id = ${shopId}`;
        await sql`UPDATE subscriptions SET status = 'expired', updated_at = now() WHERE repair_shop_id = ${shopId} AND status = 'active' AND current_period_end < now()`;
        response.status(403).json({
          error: "Your subscription has expired. Please renew to continue.",
          errorType: "subscription_required",
          subscriptionStatus: "expired",
        });
        return null;
      }
    } catch (e) { /* table may not exist — allow */ }
    return { shopId, status: "active" };
  }

  // inactive / expired / past_due
  response.status(403).json({
    error: "An active subscription is required. Please choose a plan to continue.",
    errorType: "subscription_required",
    subscriptionStatus: subStatus,
  });
  return null;
}

module.exports = {
  signToken,
  makeJti,
  verifyToken,
  requireAuth,
  requireRole,
  requirePlatformAdmin,
  requireSuperAdmin,
  requireShopOwner,
  requireActiveSubscription,
  logAdminAction,
};

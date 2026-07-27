// api/promotions.js
// Promotion & Support Code Management System
// POST /api/promotions  body: { action: "create"|"update"|"delete"|"validate"|"redeem"|"stats"|"list"|"redemptions", ... }
//
// Admin actions: create, update, delete, list, stats, redemptions, duplicate, toggle
// Shop actions: validate, redeem
//
// Security: rate-limited, auth-required, hashed support tokens, idempotent redemptions.

const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { requireAuth, requirePlatformAdmin, requireSuperAdmin, logAdminAction } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders } = require("./_lib/security");
const { z } = require("zod");

// ─── Validation schemas ─────────────────────────────────────────────────────
const createSchema = z.object({
  name: z.string().min(1, "Name is required").max(200).trim(),
  code: z.string().min(1, "Code is required").max(50).trim().transform(v => v.toUpperCase()),
  description: z.string().max(2000).default(""),
  type: z.enum(["percentage_discount", "fixed_discount", "free_trial", "support_token", "lifetime_access"]),
  // Percentage discount fields
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  // Fixed discount fields
  discountAmount: z.coerce.number().min(0).optional(),
  discountCurrency: z.string().max(10).default("INR"),
  // Free trial fields
  freeTrialDays: z.coerce.number().int().min(1).optional(),
  // Shared fields
  planId: z.coerce.number().int().positive().nullable().optional(),
  billingCycles: z.array(z.enum(["monthly", "quarterly", "halfyearly", "yearly"])).default([]),
  maxUses: z.coerce.number().int().positive().nullable().optional(),
  perUserLimit: z.coerce.number().int().positive().nullable().default(1),
  minPurchaseAmount: z.coerce.number().min(0).default(0),
  maxDiscountAmount: z.coerce.number().min(0).nullable().optional(),
  allowedPlans: z.array(z.coerce.number().int().positive()).default([]),
  validFrom: z.string().optional(),
  validUntil: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
  stackable: z.boolean().default(false),
  autoApply: z.boolean().default(false),
  internalNotes: z.string().max(2000).default(""),
});

const updateSchema = createSchema.partial().extend({
  id: z.coerce.number().int().positive(),
});

const validateSchema = z.object({
  code: z.string().min(1).max(50).trim().transform(v => v.toUpperCase()),
  planName: z.string().optional().default("pro"),
  billingCycle: z.enum(["monthly", "quarterly", "halfyearly", "yearly"]).optional().default("monthly"),
  planId: z.coerce.number().int().positive().optional(),
  amount: z.coerce.number().min(0).optional(),
  currency: z.string().max(10).optional().default("INR"),
  shopId: z.coerce.number().int().positive().optional(),
});

const redeemSchema = z.object({
  code: z.string().min(1).max(50).trim().transform(v => v.toUpperCase()),
  planName: z.string().optional().default("pro"),
  billingCycle: z.enum(["monthly", "quarterly", "halfyearly", "yearly"]).optional().default("monthly"),
  planId: z.coerce.number().int().positive().optional(),
  amount: z.coerce.number().min(0),
  currency: z.string().max(10).optional().default("INR"),
  paymentId: z.coerce.number().int().positive().nullable().optional(),
  subscriptionId: z.coerce.number().int().positive().nullable().optional(),
});

// ─── Hash a support token for storage ───────────────────────────────────────
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ─── Main handler ────────────────────────────────────────────────────────────
module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const sql = neon(process.env.DATABASE_URL);

  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const body = request.body || {};
  const action = body.action;

  // Admin-only actions
  if (["create", "update", "delete", "list", "stats", "redemptions", "duplicate", "toggle"].includes(action)) {
    const admin = await requirePlatformAdmin(auth, sql, response);
    if (!admin) return;
    return handleAdminAction(request, response, sql, auth, action, body);
  }

  // Shop actions (require auth but not admin)
  if (action === "validate") return handleValidate(request, response, sql, auth, body);
  if (action === "redeem") return handleRedeem(request, response, sql, auth, body);

  return response.status(400).json({ error: "Invalid action" });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
async function handleAdminAction(request, response, sql, auth, action, body) {
  const actorType = auth.user_type || "shop";
  const actorId = parseInt(auth.sub, 10);
  const ip = request.headers["x-forwarded-for"]?.split(",")[0]?.trim() || request.headers["x-real-ip"] || null;

  switch (action) {
    case "create": return adminCreate(request, response, sql, body, actorType, actorId, ip);
    case "update": return adminUpdate(request, response, sql, body, actorType, actorId, ip);
    case "delete": return adminDelete(request, response, sql, body);
    case "list": return adminList(request, response, sql, body);
    case "stats": return adminStats(request, response, sql);
    case "redemptions": return adminRedemptions(request, response, sql, body);
    case "duplicate": return adminDuplicate(request, response, sql, body, actorType, actorId, ip);
    case "toggle": return adminToggle(request, response, sql, body, actorType, actorId, ip);
    default: return response.status(400).json({ error: "Invalid admin action" });
  }
}

// ─── CREATE ──────────────────────────────────────────────────────────────────
async function adminCreate(request, response, sql, body, actorType, actorId, ip) {
  const data = createSchema.safeParse(body);
  if (!data.success) {
    return response.status(400).json({ error: "Validation failed", errors: data.error.flatten().fieldErrors });
  }
  const v = data.data;

  // Validate type-specific requirements
  if (v.type === "percentage_discount" && v.discountPercent == null) {
    return response.status(400).json({ error: "discountPercent is required for percentage_discount" });
  }
  if (v.type === "fixed_discount" && v.discountAmount == null) {
    return response.status(400).json({ error: "discountAmount is required for fixed_discount" });
  }
  if (v.type === "free_trial" && v.freeTrialDays == null) {
    return response.status(400).json({ error: "freeTrialDays is required for free_trial" });
  }

  // Check code uniqueness
  const existingCode = await sql`SELECT id FROM promotion_codes WHERE code = ${v.code} LIMIT 1`;
  if (existingCode.length > 0) {
    return response.status(409).json({ error: "A code with this name already exists" });
  }

  // For support tokens, hash the code before storage
  let codeHash = null;
  let storageCode = v.code;
  if (v.type === "support_token") {
    codeHash = hashToken(v.code);
    storageCode = `st_${v.code.slice(0, 4).toUpperCase()}_${Date.now().toString(36)}`;
  }

  const rows = await sql`
    INSERT INTO promotion_codes (
      name, code, code_hash, description, type,
      discount_percent, discount_amount, discount_currency,
      free_trial_days, plan_id, billing_cycles,
      max_uses, per_user_limit, min_purchase_amount, max_discount_amount,
      allowed_plans, valid_from, valid_until, is_active,
      stackable, auto_apply, internal_notes, created_by
    ) VALUES (
      ${v.name}, ${storageCode}, ${codeHash}, ${v.description}, ${v.type},
      ${v.discountPercent || null}, ${v.discountAmount || null}, ${v.discountCurrency},
      ${v.freeTrialDays || null}, ${v.planId || null}, ${v.billingCycles},
      ${v.maxUses || null}, ${v.perUserLimit || null}, ${v.minPurchaseAmount}, ${v.maxDiscountAmount || null},
      ${v.allowedPlans},
      ${v.validFrom ? new Date(v.validFrom) : new Date()},
      ${v.validUntil ? new Date(v.validUntil) : null},
      ${v.isActive},
      ${v.stackable}, ${v.autoApply}, ${v.internalNotes}, ${actorId}
    )
    RETURNING id, name, code, type, is_active, created_at
  `;

  await logAdminAction(sql, {
    actorType, actorId, action: "create_promotion_code",
    targetType: "promotion_code", targetId: rows[0].id,
    details: { name: v.name, type: v.type, code: v.code },
    ip,
  });

  return response.status(201).json({ promoCode: rows[0] });
}

// ─── UPDATE ──────────────────────────────────────────────────────────────────
async function adminUpdate(request, response, sql, body, actorType, actorId, ip) {
  const data = updateSchema.safeParse(body);
  if (!data.success) {
    return response.status(400).json({ error: "Validation failed", errors: data.error.flatten().fieldErrors });
  }
  const v = data.data;

  const existing = await sql`SELECT id FROM promotion_codes WHERE id = ${v.id} LIMIT 1`;
  if (existing.length === 0) {
    return response.status(404).json({ error: "Promotion code not found" });
  }

  // Build SET clause dynamically
  const fieldMap = {
    name: "name", description: "description", type: "type",
    discountPercent: "discount_percent", discountAmount: "discount_amount",
    discountCurrency: "discount_currency", freeTrialDays: "free_trial_days",
    planId: "plan_id", billingCycles: "billing_cycles",
    maxUses: "max_uses", perUserLimit: "per_user_limit",
    minPurchaseAmount: "min_purchase_amount", maxDiscountAmount: "max_discount_amount",
    allowedPlans: "allowed_plans", isActive: "is_active",
    stackable: "stackable", autoApply: "auto_apply", internalNotes: "internal_notes",
  };

  const updates = {};
  for (const [field, col] of Object.entries(fieldMap)) {
    if (v[field] !== undefined) {
      // Handle dates specially
      if (field === "validFrom" || field === "validUntil") {
        updates[col] = v[field] ? new Date(v[field]) : null;
      } else {
        updates[col] = v[field];
      }
    }
  }

  // Handle valid_from and valid_until separately (not in fieldMap since they don't have direct field names)
  if (v.validFrom !== undefined) updates.valid_from = v.validFrom ? new Date(v.validFrom) : new Date();
  if (v.validUntil !== undefined) updates.valid_until = v.validUntil ? new Date(v.validUntil) : null;

  if (Object.keys(updates).length === 0) {
    return response.status(400).json({ error: "No fields to update" });
  }

  updates.updated_by = actorId;
  updates.updated_at = new Date();

  const setParts = [];
  const setValues = [];
  for (const [col, val] of Object.entries(updates)) {
    setValues.push(val);
    setParts.push(`${col} = $${setValues.length}`);
  }
  setValues.push(v.id);
  await sql(`UPDATE promotion_codes SET ${setParts.join(", ")} WHERE id = $${setValues.length}`, setValues);

  await logAdminAction(sql, {
    actorType, actorId, action: "update_promotion_code",
    targetType: "promotion_code", targetId: v.id,
    details: updates,
    ip,
  });

  return response.status(200).json({ message: "Promotion code updated" });
}

// ─── DELETE ──────────────────────────────────────────────────────────────────
async function adminDelete(request, response, sql, body) {
  const id = parseInt(body.id, 10);
  if (!id) return response.status(400).json({ error: "id required" });

  const existing = await sql`SELECT id FROM promotion_codes WHERE id = ${id} LIMIT 1`;
  if (existing.length === 0) {
    return response.status(404).json({ error: "Promotion code not found" });
  }

  // Delete redemptions first (CASCADE should handle this, but be explicit)
  await sql`DELETE FROM promo_code_redemptions WHERE promotion_code_id = ${id}`;
  await sql`DELETE FROM promotion_codes WHERE id = ${id}`;

  return response.status(200).json({ message: "Promotion code deleted" });
}

// ─── LIST ────────────────────────────────────────────────────────────────────
async function adminList(request, response, sql, body) {
  const page = Math.max(1, parseInt(body.page || request.query?.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(body.limit || request.query?.limit || "20", 10)));
  const search = body.search || request.query?.search || "";
  const typeFilter = body.type || request.query?.type || "";
  const statusFilter = body.status || request.query?.status || ""; // active, inactive, expired
  const offset = (page - 1) * limit;

  let whereClause = "WHERE 1=1";
  const qp = [];

  if (search) {
    qp.push(`%${search}%`);
    whereClause += ` AND (name ILIKE $${qp.length} OR code ILIKE $${qp.length} OR description ILIKE $${qp.length})`;
  }
  if (typeFilter) {
    qp.push(typeFilter);
    whereClause += ` AND type = $${qp.length}`;
  }
  if (statusFilter === "active") {
    whereClause += " AND is_active = true AND (valid_until IS NULL OR valid_until >= now())";
  } else if (statusFilter === "inactive") {
    whereClause += " AND is_active = false";
  } else if (statusFilter === "expired") {
    whereClause += " AND is_active = true AND valid_until IS NOT NULL AND valid_until < now()";
  }

  let codes = [];
  let total = 0;
  try {
    codes = await sql(`
      SELECT pc.*,
        COALESCE((SELECT COUNT(*) FROM promo_code_redemptions WHERE promotion_code_id = pc.id), 0) as redemption_count
      FROM promotion_codes pc
      ${whereClause}
      ORDER BY pc.created_at DESC
      LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}
    `, [...qp, limit, offset]);

    const countResult = await sql(`SELECT COUNT(*) as total FROM promotion_codes pc ${whereClause}`, qp);
    total = parseInt(countResult[0]?.total || "0", 10);
  } catch (e) {
    console.warn("[promotions/list] Table may not exist:", e.message);
  }

  return response.status(200).json({
    codes,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

// ─── STATS ───────────────────────────────────────────────────────────────────
async function adminStats(request, response, sql) {
  let stats = {
    totalCodes: 0,
    activeCodes: 0,
    expiredCodes: 0,
    usedCodes: 0,
    totalRedemptions: 0,
    totalDiscountAmount: 0,
    revenueDiscounted: 0,
    conversionRate: 0,
  };

  try {
    const counts = await sql`
      SELECT
        (SELECT COUNT(*) FROM promotion_codes) as total_codes,
        (SELECT COUNT(*) FROM promotion_codes WHERE is_active = true
          AND (valid_until IS NULL OR valid_until >= now())) as active_codes,
        (SELECT COUNT(*) FROM promotion_codes WHERE is_active = true
          AND valid_until IS NOT NULL AND valid_until < now()) as expired_codes,
        (SELECT COUNT(*) FROM promotion_codes WHERE used_count > 0) as used_codes,
        (SELECT COUNT(*) FROM promo_code_redemptions WHERE status = 'active') as total_redemptions,
        (SELECT COALESCE(SUM(discount_amount), 0) FROM promo_code_redemptions WHERE status = 'active') as total_discount_amount,
        (SELECT COALESCE(SUM(original_amount), 0) FROM promo_code_redemptions WHERE status = 'active') as revenue_discounted
    `;
    const r = counts[0] || {};
    const totalRedemptions = parseInt(r.total_redemptions || "0", 10);
    const usedCodes = parseInt(r.used_codes || "0", 10);
    stats = {
      totalCodes: parseInt(r.total_codes || "0", 10),
      activeCodes: parseInt(r.active_codes || "0", 10),
      expiredCodes: parseInt(r.expired_codes || "0", 10),
      usedCodes,
      totalRedemptions,
      totalDiscountAmount: parseFloat(r.total_discount_amount || "0"),
      revenueDiscounted: parseFloat(r.revenue_discounted || "0"),
      conversionRate: usedCodes > 0
        ? parseFloat(((totalRedemptions / usedCodes) * 100).toFixed(1))
        : 0,
    };
  } catch (e) {
    console.warn("[promotions/stats] Table may not exist:", e.message);
  }

  return response.status(200).json({ stats });
}

// ─── REDEMPTIONS LIST ────────────────────────────────────────────────────────
async function adminRedemptions(request, response, sql, body) {
  const page = Math.max(1, parseInt(body.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(body.limit || "20", 10)));
  const codeId = body.codeId ? parseInt(body.codeId, 10) : null;
  const offset = (page - 1) * limit;

  let whereClause = "WHERE 1=1";
  const qp = [];
  if (codeId) {
    qp.push(codeId);
    whereClause += ` AND r.promotion_code_id = $${qp.length}`;
  }

  let redemptions = [];
  let total = 0;
  try {
    redemptions = await sql(`
      SELECT r.*, pc.name as code_name, pc.code as promo_code, pc.type as code_type,
             rs.shop_name as repair_shop_name
      FROM promo_code_redemptions r
      LEFT JOIN promotion_codes pc ON pc.id = r.promotion_code_id
      LEFT JOIN repair_shops rs ON rs.id = r.repair_shop_id
      ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT $${qp.length + 1} OFFSET $${qp.length + 2}
    `, [...qp, limit, offset]);

    const countResult = await sql(`SELECT COUNT(*) as total FROM promo_code_redemptions r ${whereClause}`, qp);
    total = parseInt(countResult[0]?.total || "0", 10);
  } catch (e) {
    console.warn("[promotions/redemptions] Table may not exist:", e.message);
  }

  return response.status(200).json({
    redemptions,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

// ─── DUPLICATE ───────────────────────────────────────────────────────────────
async function adminDuplicate(request, response, sql, body, actorType, actorId, ip) {
  const id = parseInt(body.id, 10);
  if (!id) return response.status(400).json({ error: "id required" });

  const existing = await sql`SELECT * FROM promotion_codes WHERE id = ${id} LIMIT 1`;
  if (existing.length === 0) {
    return response.status(404).json({ error: "Promotion code not found" });
  }

  const orig = existing[0];
  const newCode = `${orig.code}-COPY`;
  const newName = `${orig.name} (Copy)`;

  const rows = await sql`
    INSERT INTO promotion_codes (
      name, code, code_hash, description, type,
      discount_percent, discount_amount, discount_currency,
      free_trial_days, plan_id, billing_cycles,
      max_uses, per_user_limit, min_purchase_amount, max_discount_amount,
      allowed_plans, valid_from, valid_until, is_active,
      stackable, auto_apply, internal_notes, created_by
    ) VALUES (
      ${newName}, ${newCode}, NULL, ${orig.description}, ${orig.type},
      ${orig.discount_percent}, ${orig.discount_amount}, ${orig.discount_currency},
      ${orig.free_trial_days}, ${orig.plan_id}, ${orig.billing_cycles},
      ${orig.max_uses}, ${orig.per_user_limit}, ${orig.min_purchase_amount}, ${orig.max_discount_amount},
      ${orig.allowed_plans}, ${orig.valid_from}, ${orig.valid_until}, false,
      ${orig.stackable}, ${orig.auto_apply}, ${orig.internal_notes}, ${actorId}
    )
    RETURNING id, name, code, type, is_active
  `;

  await logAdminAction(sql, {
    actorType, actorId, action: "duplicate_promotion_code",
    targetType: "promotion_code", targetId: rows[0].id,
    details: { sourceId: id, newCode },
    ip,
  });

  return response.status(201).json({ promoCode: rows[0] });
}

// ─── TOGGLE ACTIVE ───────────────────────────────────────────────────────────
async function adminToggle(request, response, sql, body, actorType, actorId, ip) {
  const id = parseInt(body.id, 10);
  if (!id) return response.status(400).json({ error: "id required" });

  const existing = await sql`SELECT id, is_active FROM promotion_codes WHERE id = ${id} LIMIT 1`;
  if (existing.length === 0) {
    return response.status(404).json({ error: "Promotion code not found" });
  }

  const newState = !existing[0].is_active;
  await sql`UPDATE promotion_codes SET is_active = ${newState}, updated_at = now(), updated_by = ${actorId} WHERE id = ${id}`;

  await logAdminAction(sql, {
    actorType, actorId, action: newState ? "activate_promotion_code" : "deactivate_promotion_code",
    targetType: "promotion_code", targetId: id,
    ip,
  });

  return response.status(200).json({ message: `Promotion code ${newState ? "activated" : "deactivated"}`, isActive: newState });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── VALIDATE ────────────────────────────────────────────────────────────────
async function handleValidate(request, response, sql, auth, body) {
  const data = validateSchema.safeParse(body);
  if (!data.success) {
    return response.status(400).json({ error: "Validation failed", errors: data.error.flatten().fieldErrors });
  }
  const v = data.data;
  const shopId = v.shopId || parseInt(auth.sub, 10);

  // Check if it's a support token (hashed lookup)
  let promoCode;
  const codeHash = hashToken(v.code);

  // For support tokens, look up by hash
  promoCode = await sql`
    SELECT * FROM promotion_codes
    WHERE (code = ${v.code} OR code_hash = ${codeHash})
      AND is_active = true
    LIMIT 1
  `;

  if (promoCode.length === 0) {
    return response.status(404).json({ valid: false, error: "Invalid promo code" });
  }

  const code = promoCode[0];

  // Check if expired
  if (code.valid_until && new Date(code.valid_until) < new Date()) {
    return response.status(400).json({ valid: false, error: "This promo code has expired" });
  }

  // Check if valid_from is in the future
  if (new Date(code.valid_from) > new Date()) {
    return response.status(400).json({ valid: false, error: "This promo code is not yet active" });
  }

  // Check max uses
  if (code.max_uses !== null && code.used_count >= code.max_uses) {
    return response.status(400).json({ valid: false, error: "This promo code has reached its maximum usage limit" });
  }

  // For support tokens, validate differently
  if (code.type === "support_token") {
    // Check if shop already has an active subscription from this token
    const existingSub = await sql`
      SELECT id FROM subscriptions
      WHERE repair_shop_id = ${shopId} AND is_support_token = true AND status = 'active'
      LIMIT 1
    `;
    if (existingSub.length > 0) {
      return response.status(400).json({ valid: false, error: "Support token has already been redeemed for this account" });
    }

    // Check if shop has already redeemed this token
    const existingRedemption = await sql`
      SELECT id FROM promo_code_redemptions
      WHERE promotion_code_id = ${code.id} AND repair_shop_id = ${shopId} AND status = 'active'
      LIMIT 1
    `;
    if (existingRedemption.length > 0) {
      return response.status(400).json({ valid: false, error: "You have already redeemed this support token" });
    }
  }

  // For regular codes, check per-user limit
  if (code.type !== "support_token" && code.per_user_limit !== null) {
    const userRedemptions = await sql`
      SELECT COUNT(*) as cnt FROM promo_code_redemptions
      WHERE promotion_code_id = ${code.id} AND repair_shop_id = ${shopId} AND status = 'active'
    `;
    if (parseInt(userRedemptions[0]?.cnt || "0", 10) >= code.per_user_limit) {
      return response.status(400).json({ valid: false, error: "You have already used this promo code the maximum number of times" });
    }
  }

  // Check allowed plans
  const planId = v.planId || null;
  if (code.allowed_plans && code.allowed_plans.length > 0 && planId) {
    if (!code.allowed_plans.includes(planId)) {
      return response.status(400).json({ valid: false, error: "This promo code is not valid for the selected plan" });
    }
  }

  // Check billing cycles
  if (code.billing_cycles && code.billing_cycles.length > 0) {
    if (!code.billing_cycles.includes(v.billingCycle)) {
      return response.status(400).json({ valid: false, error: `This promo code is not valid for ${v.billingCycle} billing` });
    }
  }

  // Calculate discount
  let discountAmount = 0;
  let finalAmount = v.amount || 0;
  const originalAmount = v.amount || 0;

  if (code.type === "percentage_discount" && code.discount_percent !== null) {
    discountAmount = Math.round((originalAmount * code.discount_percent / 100) * 100) / 100;
  } else if (code.type === "fixed_discount" && code.discount_amount !== null) {
    discountAmount = code.discount_amount;
  }

  // Apply max discount cap
  if (code.max_discount_amount !== null && discountAmount > code.max_discount_amount) {
    discountAmount = code.max_discount_amount;
  }

  // Check min purchase
  if (code.min_purchase_amount > 0 && originalAmount < code.min_purchase_amount) {
    return response.status(400).json({
      valid: false,
      error: `Minimum purchase amount of ${code.discount_currency} ${code.min_purchase_amount} required`,
    });
  }

  finalAmount = Math.max(0, Math.round((originalAmount - discountAmount) * 100) / 100);

  return response.status(200).json({
    valid: true,
    code: {
      id: code.id,
      name: code.name,
      type: code.type,
      description: code.description,
      discountPercent: code.discount_percent,
      discountAmount: code.discount_amount,
      discountCurrency: code.discount_currency,
      freeTrialDays: code.free_trial_days,
      stackable: code.stackable,
      autoApply: code.auto_apply,
    },
    calculation: {
      originalAmount,
      discountAmount,
      finalAmount,
      currency: v.currency,
    },
    // For support tokens, indicate no payment needed
    isSupportToken: code.type === "support_token",
    isFreeTrial: code.type === "free_trial",
    isLifetime: code.type === "lifetime_access",
    freeTrialDays: code.free_trial_days,
  });
}

// ─── REDEEM ──────────────────────────────────────────────────────────────────
async function handleRedeem(request, response, sql, auth, body) {
  const data = redeemSchema.safeParse(body);
  if (!data.success) {
    return response.status(400).json({ error: "Validation failed", errors: data.error.flatten().fieldErrors });
  }
  const v = data.data;
  const shopId = parseInt(auth.sub, 10);

  const codeHash = hashToken(v.code);
  let promoRows;
  try {
    promoRows = await sql`
      SELECT * FROM promotion_codes
      WHERE (code = ${v.code} OR code_hash = ${codeHash})
        AND is_active = true
      LIMIT 1
    `;
  } catch (e) {
    return response.status(500).json({ error: "Failed to validate promo code" });
  }

  if (promoRows.length === 0) {
    return response.status(404).json({ error: "Invalid promo code" });
  }

  const code = promoRows[0];

  // Re-validate all conditions (same as handleValidate but returns errors)
  const validationError = await validateForRedemption(sql, code, shopId, v);
  if (validationError) {
    // Log failed redemption
    try {
      await sql`
        INSERT INTO promo_code_redemptions (promotion_code_id, repair_shop_id, ip_address, user_agent,
          plan_name, billing_cycle, original_amount, discount_amount, final_amount, currency, status, metadata)
        VALUES (${code.id}, ${shopId}, ${request.headers["x-forwarded-for"]?.split(",")[0] || request.headers["x-real-ip"] || null},
          ${request.headers["user-agent"] || null},
          ${v.planName}, ${v.billingCycle}, ${v.amount}, 0, ${v.amount}, ${v.currency}, 'failed',
          ${JSON.stringify({ error: validationError })}::jsonb)
      `;
    } catch (e) { /* log silently */ }

    return response.status(400).json({ error: validationError });
  }

  // Calculate discount
  let discountAmount = 0;
  let finalAmount = v.amount;

  if (code.type === "percentage_discount" && code.discount_percent !== null) {
    discountAmount = Math.round((v.amount * code.discount_percent / 100) * 100) / 100;
  } else if (code.type === "fixed_discount" && code.discount_amount !== null) {
    discountAmount = code.discount_amount;
  }

  // Apply max discount cap
  if (code.max_discount_amount !== null && discountAmount > code.max_discount_amount) {
    discountAmount = code.max_discount_amount;
  }

  finalAmount = Math.max(0, Math.round((v.amount - discountAmount) * 100) / 100);

  // For support token: immediately activate (skip payment)
  if (code.type === "support_token") {
    // Activate subscription immediately — no payment needed
    return await activateViaSupportToken(sql, code, shopId, v, discountAmount, finalAmount, request);
  }

  // For free trial: mark the code but let the normal flow handle it
  if (code.type === "free_trial") {
    return await activateFreeTrial(sql, code, shopId, v, request);
  }

  // For lifetime access
  if (code.type === "lifetime_access") {
    return await activateLifetimeAccess(sql, code, shopId, v, request);
  }

  // For regular discount codes, use atomic transaction to prevent race conditions
  try {
    await sql`BEGIN`;

    // Increment used_count atomically
    const updated = await sql`
      UPDATE promotion_codes
      SET used_count = used_count + 1, updated_at = now()
      WHERE id = ${code.id}
        AND (max_uses IS NULL OR used_count < max_uses)
      RETURNING used_count
    `;

    if (updated.length === 0) {
      await sql`ROLLBACK`;
      return response.status(400).json({ error: "Promo code usage limit reached" });
    }

    // Record redemption
    const redemption = await sql`
      INSERT INTO promo_code_redemptions (
        promotion_code_id, repair_shop_id, email, ip_address, user_agent,
        plan_name, billing_cycle, original_amount, discount_amount, final_amount, currency,
        payment_id, subscription_id, status
      ) VALUES (
        ${code.id}, ${shopId},
        (SELECT email FROM repair_shops WHERE id = ${shopId}),
        ${request.headers["x-forwarded-for"]?.split(",")[0] || request.headers["x-real-ip"] || null},
        ${request.headers["user-agent"] || null},
        ${v.planName}, ${v.billingCycle}, ${v.amount}, ${discountAmount}, ${finalAmount}, ${v.currency},
        ${v.paymentId || null}, ${v.subscriptionId || null}, 'active'
      )
      RETURNING id
    `;

    await sql`COMMIT`;

    return response.status(200).json({
      redeemed: true,
      redemptionId: redemption[0].id,
      discountAmount,
      finalAmount,
      originalAmount: v.amount,
    });
  } catch (e) {
    await sql`ROLLBACK`.catch(() => {});
    // Check for unique constraint violation (duplicate redemption)
    if (e.code === "23505") {
      return response.status(409).json({ error: "You have already redeemed this promo code" });
    }
    console.error("[promotions/redeem] Transaction failed:", e.message);
    return response.status(500).json({ error: "Failed to redeem promo code" });
  }
}

// ─── Validation helper ──────────────────────────────────────────────────────
async function validateForRedemption(sql, code, shopId, v) {
  // Check if expired
  if (code.valid_until && new Date(code.valid_until) < new Date()) {
    return "This promo code has expired";
  }

  // Check if not yet active
  if (new Date(code.valid_from) > new Date()) {
    return "This promo code is not yet active";
  }

  // Check max uses
  if (code.max_uses !== null && code.used_count >= code.max_uses) {
    return "This promo code has reached its maximum usage limit";
  }

  // Check duplicate redemption (same code + same shop)
  if (code.per_user_limit !== null && code.per_user_limit <= 1) {
    const existing = await sql`
      SELECT id FROM promo_code_redemptions
      WHERE promotion_code_id = ${code.id} AND repair_shop_id = ${shopId} AND status = 'active'
      LIMIT 1
    `;
    if (existing.length > 0) {
      return "You have already redeemed this promo code";
    }
  } else if (code.per_user_limit !== null) {
    const count = await sql`
      SELECT COUNT(*) as cnt FROM promo_code_redemptions
      WHERE promotion_code_id = ${code.id} AND repair_shop_id = ${shopId} AND status = 'active'
    `;
    if (parseInt(count[0]?.cnt || "0", 10) >= code.per_user_limit) {
      return "You have reached the maximum number of uses for this promo code";
    }
  }

  // Check allowed plans
  if (code.allowed_plans && code.allowed_plans.length > 0 && v.planId) {
    if (!code.allowed_plans.includes(v.planId)) {
      return "This promo code is not valid for the selected plan";
    }
  }

  // Check billing cycles
  if (code.billing_cycles && code.billing_cycles.length > 0) {
    if (!code.billing_cycles.includes(v.billingCycle)) {
      return `This promo code is not valid for ${v.billingCycle} billing`;
    }
  }

  // Check min purchase
  if (code.min_purchase_amount > 0 && v.amount < code.min_purchase_amount) {
    return `Minimum purchase amount of ${code.discount_currency} ${code.min_purchase_amount} required`;
  }

  return null; // No validation errors
}

// ─── Activate via support token ─────────────────────────────────────────────
async function activateViaSupportToken(sql, code, shopId, v, discountAmount, finalAmount, request) {
  try {
    await sql`BEGIN`;

    // Update the shop
    await sql`
      UPDATE repair_shops
      SET subscription_status = 'active', approval_status = 'approved',
          is_active = true, updated_at = now()
      WHERE id = ${shopId}
    `;

    // Create subscription
    const planId = v.planId || 1;
    const subEnd = new Date();
    subEnd.setFullYear(subEnd.getFullYear() + 10); // Support token grants 10 years

    const sub = await sql`
      INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway,
        amount_paid, currency, is_support_token, is_lifetime, promotion_code_id,
        current_period_start, current_period_end, created_at)
      VALUES (${shopId}, ${planId}, 'active', ${v.billingCycle || 'yearly'}, 'promo_code',
        ${finalAmount}, ${v.currency}, true, false, ${code.id},
        now(), ${subEnd.toISOString()}, now())
      RETURNING id
    `;

    // Increment used count
    await sql`UPDATE promotion_codes SET used_count = used_count + 1, updated_at = now() WHERE id = ${code.id}`;

    // Record redemption
    await sql`
      INSERT INTO promo_code_redemptions (
        promotion_code_id, repair_shop_id, email, ip_address, user_agent,
        plan_name, billing_cycle, original_amount, discount_amount, final_amount, currency,
        subscription_id, status
      ) VALUES (
        ${code.id}, ${shopId},
        (SELECT email FROM repair_shops WHERE id = ${shopId}),
        ${request.headers["x-forwarded-for"]?.split(",")[0] || request.headers["x-real-ip"] || null},
        ${request.headers["user-agent"] || null},
        ${v.planName}, ${v.billingCycle}, ${v.amount}, ${discountAmount}, ${finalAmount}, ${v.currency},
        ${sub[0].id}, 'active'
      )
    `;

    await sql`COMMIT`;

    return response.status(200).json({
      redeemed: true,
      isSupportToken: true,
      message: "Support token activated. Your subscription is now active!",
      subscriptionId: sub[0].id,
      activationType: "support_token",
      noPaymentRequired: true,
    });
  } catch (e) {
    await sql`ROLLBACK`.catch(() => {});
    console.error("[promotions/support-token] Failed:", e.message);
    return response.status(500).json({ error: "Failed to activate support token" });
  }
}

// ─── Activate free trial ────────────────────────────────────────────────────
async function activateFreeTrial(sql, code, shopId, v, request) {
  try {
    await sql`BEGIN`;

    const planId = v.planId || 1;
    const trialDays = code.free_trial_days || 14;
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + trialDays);

    // Update shop status
    await sql`
      UPDATE repair_shops
      SET subscription_status = 'trial', updated_at = now()
      WHERE id = ${shopId}
    `;

    // Create trial subscription
    const sub = await sql`
      INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway,
        amount_paid, currency, promotion_code_id,
        current_period_start, current_period_end, trial_end, created_at)
      VALUES (${shopId}, ${planId}, 'trial', ${v.billingCycle || 'monthly'}, 'promo_code',
        0, ${v.currency}, ${code.id},
        now(), ${trialEnd.toISOString()}, ${trialEnd.toISOString()}, now())
      RETURNING id
    `;

    // Increment used count
    await sql`UPDATE promotion_codes SET used_count = used_count + 1, updated_at = now() WHERE id = ${code.id}`;

    // Record redemption
    await sql`
      INSERT INTO promo_code_redemptions (
        promotion_code_id, repair_shop_id, email, ip_address, user_agent,
        plan_name, billing_cycle, original_amount, discount_amount, final_amount, currency,
        subscription_id, status
      ) VALUES (
        ${code.id}, ${shopId},
        (SELECT email FROM repair_shops WHERE id = ${shopId}),
        ${request.headers["x-forwarded-for"]?.split(",")[0] || request.headers["x-real-ip"] || null},
        ${request.headers["user-agent"] || null},
        ${v.planName}, ${v.billingCycle}, ${v.amount || 0}, 0, 0, ${v.currency},
        ${sub[0].id}, 'active'
      )
    `;

    await sql`COMMIT`;

    return response.status(200).json({
      redeemed: true,
      isFreeTrial: true,
      freeTrialDays: trialDays,
      message: `Free trial activated! You have ${trialDays} days to try CoolCare Pro.`,
      subscriptionId: sub[0].id,
      trialEnd,
    });
  } catch (e) {
    await sql`ROLLBACK`.catch(() => {});
    console.error("[promotions/free-trial] Failed:", e.message);
    return response.status(500).json({ error: "Failed to activate free trial" });
  }
}

// ─── Activate lifetime access ───────────────────────────────────────────────
async function activateLifetimeAccess(sql, code, shopId, v, request) {
  try {
    await sql`BEGIN`;

    const planId = v.planId || 1;
    const farFuture = new Date("2099-12-31"); // Effectively never expires

    // Update shop
    await sql`
      UPDATE repair_shops
      SET subscription_status = 'active', approval_status = 'approved',
          is_active = true, updated_at = now()
      WHERE id = ${shopId}
    `;

    // Create lifetime subscription
    const sub = await sql`
      INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway,
        amount_paid, currency, is_lifetime, promotion_code_id,
        current_period_start, current_period_end, created_at)
      VALUES (${shopId}, ${planId}, 'active', 'lifetime', 'promo_code',
        0, ${v.currency}, true, ${code.id},
        now(), ${farFuture.toISOString()}, now())
      RETURNING id
    `;

    // Increment used count
    await sql`UPDATE promotion_codes SET used_count = used_count + 1, updated_at = now() WHERE id = ${code.id}`;

    // Record redemption
    await sql`
      INSERT INTO promo_code_redemptions (
        promotion_code_id, repair_shop_id, email, ip_address, user_agent,
        plan_name, billing_cycle, original_amount, discount_amount, final_amount, currency,
        subscription_id, status
      ) VALUES (
        ${code.id}, ${shopId},
        (SELECT email FROM repair_shops WHERE id = ${shopId}),
        ${request.headers["x-forwarded-for"]?.split(",")[0] || request.headers["x-real-ip"] || null},
        ${request.headers["user-agent"] || null},
        ${v.planName}, 'lifetime', ${v.amount || 0}, 0, 0, ${v.currency},
        ${sub[0].id}, 'active'
      )
    `;

    await sql`COMMIT`;

    return response.status(200).json({
      redeemed: true,
      isLifetime: true,
      message: "Lifetime access activated! Your subscription will never expire.",
      subscriptionId: sub[0].id,
      activationType: "lifetime",
      noPaymentRequired: true,
    });
  } catch (e) {
    await sql`ROLLBACK`.catch(() => {});
    console.error("[promotions/lifetime] Failed:", e.message);
    return response.status(500).json({ error: "Failed to activate lifetime access" });
  }
}

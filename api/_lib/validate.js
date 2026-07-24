// api/_lib/validate.js
// Zod-based request body validation middleware.
// Usage:
//   const { validate } = require('../_lib/validate');
//   const schema = z.object({ email: z.string().email() });
//   const data = validate(request, response, schema);
//   if (!data) return; // 400 already sent

const { z } = require("zod");

/**
 * Validate request body against a Zod schema.
 * Returns parsed data on success, or null (400 response already sent).
 */
function validate(request, response, schema) {
  const result = schema.safeParse(request.body || {});
  if (!result.success) {
    const errors = {};
    for (const issue of result.error.issues) {
      const field = issue.path.join(".") || "_body";
      errors[field] = issue.message;
    }
    response.status(400).json({
      error: "Validation failed",
      errors,
    });
    return null;
  }
  return result.data;
}

// ─── Reusable Zod schemas ────────────────────────────────────────────────────

// Sanitize strings: trim, collapse whitespace, strip HTML tags
// In Zod v4, .transform() returns ZodEffects which loses .min()/.max().
// So we apply length constraints BEFORE the transform.
function cleanString() {
  return z
    .string()
    .trim()
    .transform((s) =>
      s
        .replace(/\s+/g, " ")
        .replace(/<[^>]*>/g, "")
    );
}

const email = z.string().email("Invalid email address").transform((s) => s.toLowerCase().trim());

const mobile = z
  .string()
  .regex(/^\+?[1-9]\d{6,14}$/, "Invalid mobile number")
  .transform((s) => s.replace(/\s/g, ""));

const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number");

const bookingStatus = z.enum([
  "open", "accepted", "rejected", "assigned",
  "on_the_way", "arrived", "completed", "cancelled",
]);

const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(),
  search: z.string().optional(),
  sortBy: z.enum(["created_at", "updated_at", "status"]).default("created_at"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

// ─── Login schema ────────────────────────────────────────────────────────────
const loginSchema = z.object({
  identifier: z.string().min(1, "Email or mobile number is required").trim(),
  password: z.string().min(1, "Password is required"),
});

// ─── Signup schema ───────────────────────────────────────────────────────────
const signupSchema = z.object({
  shopName: z.string().min(1, "Shop name is required").max(100).trim(),
  ownerName: z.string().min(1, "Owner name is required").max(100).trim(),
  email,
  mobile,
  password,
  confirmPassword: z.string().min(1, "Please confirm your password"),
  address: z.string().max(500).trim().optional(),
  city: z.string().min(1, "City is required").max(100).trim(),
  serviceAreas: z.array(z.string().trim()).max(20).default([]),
  servicesOffered: z.array(z.string().trim()).min(1, "Select at least one service").max(20),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

// ─── Booking update schema ───────────────────────────────────────────────────
const bookingUpdateSchema = z.object({
  bookingId: z.coerce.number().int().positive("bookingId is required"),
  status: bookingStatus.optional(),
  technicianName: z.string().max(100).trim().optional().nullable(),
  technicianId: z.coerce.number().int().positive().optional().nullable(),
  technicianNotes: z.string().max(2000).optional().nullable(),
  estimatedCost: z.coerce.number().min(0).max(999999).optional().nullable(),
  finalCost: z.coerce.number().min(0).max(999999).optional().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  rescheduleDate: z.string().optional().nullable(),
  invoiceNumber: z.string().max(50).trim().optional().nullable(),
});

// ─── Platform roles ───────────────────────────────────────────────────────────
const platformRoles = ["super_admin", "admin", "support"];
const shopRoles = ["owner", "manager", "editor", "receptionist", "technician"];
const allRoles = [...platformRoles, ...shopRoles];

// ─── Bootstrap schema (first super admin) ────────────────────────────────────
const bootstrapSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).trim(),
  email: z.string().min(1, "Email is required").email("Invalid email").transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain an uppercase letter")
    .regex(/[a-z]/, "Must contain a lowercase letter")
    .regex(/[0-9]/, "Must contain a number"),
  confirmPassword: z.string().min(1, "Please confirm your password"),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

// ─── Create user schema (admin creates user) ─────────────────────────────────
const createUserSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).trim(),
  email: z.string().min(1, "Email is required").email("Invalid email").transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(allRoles, { errorMap: () => ({ message: "Invalid role" }) }),
  repair_shop_id: z.coerce.number().int().positive().optional().nullable(),
});

// ─── Edit user schema ────────────────────────────────────────────────────────
const editUserSchema = z.object({
  userId: z.coerce.number().int().positive("userId is required"),
  name: z.string().min(1).max(100).trim().optional(),
  role: z.enum(allRoles).optional(),
  is_active: z.boolean().optional(),
  repair_shop_id: z.coerce.number().int().positive().optional().nullable(),
});

// ─── Create/edit plan schema ─────────────────────────────────────────────────
const createPlanSchema = z.object({
  name: z.string().min(1, "Plan name is required").max(50).trim().transform((s) => s.toLowerCase()),
  display_name: z.string().min(1, "Display name is required").max(100).trim(),
  description: z.string().max(500).trim().optional().default(""),
  price_monthly_usd: z.coerce.number().min(0, "Must be >= 0"),
  price_yearly_usd: z.coerce.number().min(0, "Must be >= 0"),
  max_bookings: z.coerce.number().int().optional().nullable(),
  max_technicians: z.coerce.number().int().optional().nullable(),
  max_staff: z.coerce.number().int().optional().nullable(),
  whatsapp_conversations: z.coerce.number().int().optional().nullable(),
  ai_credits: z.coerce.number().int().optional().nullable(),
  features: z.any().optional().default({}),
  trial_days: z.coerce.number().int().min(0).default(14),
  currency: z.string().max(3).trim().default("USD"),
  is_active: z.boolean().default(true),
});

// ─── Edit plan schema (all fields optional) ──────────────────────────────────
const editPlanSchema = z.object({
  planId: z.coerce.number().int().positive("planId is required"),
  name: z.string().min(1).max(50).trim().optional(),
  display_name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).trim().optional(),
  price_monthly_usd: z.coerce.number().min(0).optional(),
  price_yearly_usd: z.coerce.number().min(0).optional(),
  max_bookings: z.coerce.number().int().optional().nullable(),
  max_technicians: z.coerce.number().int().optional().nullable(),
  max_staff: z.coerce.number().int().optional().nullable(),
  whatsapp_conversations: z.coerce.number().int().optional().nullable(),
  ai_credits: z.coerce.number().int().optional().nullable(),
  features: z.any().optional(),
  trial_days: z.coerce.number().int().min(0).optional(),
  currency: z.string().max(3).trim().optional(),
  is_active: z.boolean().optional(),
});

// ─── Settings schema ─────────────────────────────────────────────────────────
const settingsSchema = z.object({
  settings: z.record(z.string(), z.any()),
});

// ─── Reset password schema (admin reset) ──────────────────────────────────────
const resetPasswordSchema = z.object({
  targetId: z.coerce.number().int().positive("targetId is required"),
  targetType: z.enum(["user", "shop"]).default("shop"),
});

// ─── Forgot password schema (user requests reset) ─────────────────────────────
const forgotPasswordSchema = z.object({
  email: z.string().min(1, "Email is required").email("Invalid email").transform((s) => s.toLowerCase().trim()),
});

// ─── Reset password with token schema (user sets new password) ───────────────
const resetPasswordTokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain an uppercase letter")
    .regex(/[a-z]/, "Must contain a lowercase letter")
    .regex(/[0-9]/, "Must contain a number"),
  confirmPassword: z.string().min(1, "Please confirm your password"),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

module.exports = {
  validate,
  cleanString,
  email,
  mobile,
  password,
  bookingStatus,
  pagination,
  loginSchema,
  signupSchema,
  bookingUpdateSchema,
  bootstrapSchema,
  createUserSchema,
  editUserSchema,
  createPlanSchema,
  editPlanSchema,
  settingsSchema,
  resetPasswordSchema,
  forgotPasswordSchema,
  resetPasswordTokenSchema,
  platformRoles,
  shopRoles,
  allRoles,
  z,
};
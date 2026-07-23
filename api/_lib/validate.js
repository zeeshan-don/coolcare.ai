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
  .regex(/^(?:\+?91)?[6-9]\d{9}$/, "Invalid Indian mobile number")
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
  z,
};
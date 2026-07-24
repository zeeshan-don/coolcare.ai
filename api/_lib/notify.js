// api/_lib/notify.js
// Multi-channel notification system — WhatsApp, Email, logging.
// Triggers: booking created, assigned, completed, cancelled, rescheduled.
// Recipients: customer, admin, technician.

const { neon } = require("@neondatabase/serverless");

// ─── WhatsApp Message Templates ─────────────────────────────────────────────
const STATUS_MESSAGES = {
  accepted: (b) =>
    `✅ *Booking Accepted!*\nHi ${b.customer_name}, your CoolCare booking for *${b.service_type}* has been accepted by ${b.shop_name}. We'll assign a technician shortly. Ref #${b.id}`,
  rejected: (b) =>
    `❌ *Booking Update*\nHi ${b.customer_name}, unfortunately ${b.shop_name} is unable to take your booking for *${b.service_type}* at this time. Please contact us to rebook.`,
  assigned: (b) =>
    `🔧 *Technician Assigned*\nHi ${b.customer_name}, your technician *${b.technician_name || "our specialist"}* has been assigned for your *${b.service_type}* repair. They will contact you soon. Ref #${b.id}`,
  on_the_way: (b) =>
    `🚗 *Technician On The Way!*\nHi ${b.customer_name}, your technician *${b.technician_name || "our specialist"}* is on the way to your location for the *${b.service_type}* repair. Ref #${b.id}`,
  arrived: (b) =>
    `📍 *Technician Arrived*\nHi ${b.customer_name}, your technician has arrived at your location to service your *${b.service_type}*. Ref #${b.id}`,
  completed: (b) =>
    `🎉 *Repair Completed!*\nHi ${b.customer_name}, your *${b.service_type}* repair has been completed by ${b.shop_name}.${b.final_cost ? ` Total: ₹${b.final_cost}` : ""} Thank you for choosing CoolCare! 🙏`,
  cancelled: (b) =>
    `🚫 *Booking Cancelled*\nHi ${b.customer_name}, your booking for *${b.service_type}* (Ref #${b.id}) has been cancelled. Please contact us if you'd like to rebook.`,
  rescheduled: (b) =>
    `📅 *Booking Rescheduled*\nHi ${b.customer_name}, your booking for *${b.service_type}* (Ref #${b.id}) has been rescheduled to ${b.reschedule_date || "a new date"}. We'll confirm the new time shortly.`,
};

// ─── Send WhatsApp text message ─────────────────────────────────────────────
async function sendWhatsApp(to, body) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || "v19.0";

  if (!accessToken || !phoneId) {
    console.warn("[notify] WhatsApp env vars missing — skipping notification");
    return { ok: false, error: "WhatsApp not configured" };
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneId}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("[notify] Meta API error:", res.status);
      return { ok: false, status: res.status, body: txt };
    }
    return { ok: true };
  } catch (err) {
    console.error("[notify] WhatsApp fetch error:", err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Send Email (Resend API → SMTP fallback) ────────────────────────────────
async function sendEmail(to, subject, htmlBody) {
  const fromEmail = process.env.FROM_EMAIL || "noreply@coolcare.ai";

  // Primary: Resend API (recommended for Vercel serverless)
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [to],
          subject,
          html: htmlBody,
        }),
      });
      if (!res.ok) {
        console.error("[notify] Resend API error:", res.status);
        return { ok: false, status: res.status };
      }
      return { ok: true };
    } catch (err) {
      console.error("[notify] Resend error:", err.message);
      return { ok: false, error: err.message };
    }
  }

  // Fallback: SMTP (if configured)
  const smtpHost = process.env.SMTP_HOST;
  if (smtpHost) {
    console.warn("[notify] SMTP configured but not implemented for serverless — use RESEND_API_KEY");
    return { ok: false, error: "SMTP not supported on Vercel — set RESEND_API_KEY" };
  }

  console.warn("[notify] No email provider configured (set RESEND_API_KEY)");
  return { ok: false, error: "No email provider" };
}

// ─── Log notification to DB ─────────────────────────────────────────────────
async function logNotification(shopId, bookingId, channel, recipient, template, status, errorMsg) {
  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      INSERT INTO notification_log (repair_shop_id, booking_id, channel, recipient, template, status, error_message)
      VALUES (${shopId || null}, ${bookingId || null}, ${channel}, ${recipient}, ${template}, ${status}, ${errorMsg || null})
    `;
  } catch (err) {
    // Non-fatal — table may not exist yet
    console.warn("[notify] Log insert failed:", err.message);
  }
}

// ─── Send status change notification to customer ────────────────────────────
async function notifyStatusChange(booking, newStatus) {
  const messageFn = STATUS_MESSAGES[newStatus];
  if (!messageFn) {
    console.log("[notify] No template for status:", newStatus, "— skipping");
    return;
  }

  const to = booking.customer_number;
  if (!to) {
    console.warn("[notify] No customer_number on booking", booking.id);
    return;
  }

  const body = messageFn(booking);
  const shopId = booking.repair_shop_id || null;

  // Send WhatsApp
  const waResult = await sendWhatsApp(to, body);
  await logNotification(
    shopId, booking.id, "whatsapp", to,
    `status_${newStatus}`,
    waResult.ok ? "sent" : "failed",
    waResult.ok ? null : waResult.error
  );

  // Send email if customer email available
  if (booking.customer_email) {
    const subject = `CoolCare Booking #${booking.id} — ${newStatus.replace(/_/g, " ").toUpperCase()}`;
    const htmlBody = `<div style="font-family:Inter,sans-serif;padding:24px;background:#0a0a0a;color:#ededed;">
      <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid #222;border-radius:12px;padding:32px;">
      <h2 style="color:#fff;margin:0 0 16px;font-size:20px;">CoolCare Booking Update</h2>
      <p style="color:#a3a3a3;line-height:1.6;">${body.replace(/\*/g, "").replace(/\n/g, "<br>")}</p>
      <hr style="border:none;border-top:1px solid #222;margin:24px 0;">
      <p style="color:#525252;font-size:12px;margin:0;">CoolCare — Better service, one conversation at a time.</p>
      </div></div>`;
    const emailResult = await sendEmail(booking.customer_email, subject, htmlBody);
    await logNotification(
      shopId, booking.id, "email", booking.customer_email,
      `status_${newStatus}`,
      emailResult.ok ? "sent" : "failed",
      emailResult.ok ? null : emailResult.error
    );
  }

  return waResult;
}

// ─── Admin notification (new booking, high-value, etc.) ─────────────────────
async function notifyAdmin(shopId, subject, message) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  const htmlBody = `<div style="font-family:Inter,sans-serif;padding:24px;background:#0a0a0a;color:#ededed;">
    <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid #222;border-radius:12px;padding:32px;">
    <h2 style="color:#fff;margin:0 0 16px;font-size:20px;">CoolCare Admin Alert</h2>
    <p style="color:#a3a3a3;line-height:1.6;">${message.replace(/\n/g, "<br>")}</p>
    </div></div>`;

  const result = await sendEmail(adminEmail, subject, htmlBody);
  await logNotification(shopId, null, "email", adminEmail, "admin_alert", result.ok ? "sent" : "failed", result.ok ? null : result.error);
}

// ─── Technician notification (new assignment) ──────────────────────────────
async function notifyTechnician(techPhone, booking) {
  if (!techPhone) return;

  const message = `🔧 *New Job Assignment*\nHi ${booking.technician_name || "Technician"}, you've been assigned to a new repair job.\n\n` +
    `• Service: ${booking.service_type}\n` +
    `• Customer: ${booking.customer_name}\n` +
    `• Area: ${booking.area || "TBD"}\n` +
    `• Ref: #${booking.id}\n\n` +
    `Please contact the customer and confirm your visit time.`;

  const result = await sendWhatsApp(techPhone, message);
  await logNotification(booking.repair_shop_id, booking.id, "whatsapp", techPhone, "tech_assigned", result.ok ? "sent" : "failed", result.ok ? null : result.error);
}

module.exports = {
  sendWhatsApp,
  sendEmail,
  notifyStatusChange,
  notifyAdmin,
  notifyTechnician,
  logNotification,
};

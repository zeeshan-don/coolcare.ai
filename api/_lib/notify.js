// api/_lib/notify.js
// WhatsApp notification helper — sends status-change messages to customers.

const STATUS_MESSAGES = {
  accepted:    (b) => `✅ *Booking Accepted!*\nHi ${b.customer_name}, your CoolCare booking for *${b.service_type}* has been accepted by ${b.shop_name}. We'll assign a technician shortly. Ref #${b.id}`,
  rejected:    (b) => `❌ *Booking Update*\nHi ${b.customer_name}, unfortunately ${b.shop_name} is unable to take your booking for *${b.service_type}* at this time. Please contact us to rebook.`,
  assigned:    (b) => `🔧 *Technician Assigned*\nHi ${b.customer_name}, your technician *${b.technician_name || "our specialist"}* has been assigned for your *${b.service_type}* repair. They will contact you soon. Ref #${b.id}`,
  on_the_way:  (b) => `🚗 *Technician On The Way!*\nHi ${b.customer_name}, your technician *${b.technician_name || "our specialist"}* is on the way to your location for the *${b.service_type}* repair. Ref #${b.id}`,
  arrived:     (b) => `📍 *Technician Arrived*\nHi ${b.customer_name}, your technician has arrived at your location to service your *${b.service_type}*. Ref #${b.id}`,
  completed:   (b) => `🎉 *Repair Completed!*\nHi ${b.customer_name}, your *${b.service_type}* repair has been completed by ${b.shop_name}.${b.final_cost ? ` Total: ₹${b.final_cost}` : ""} Thank you for choosing CoolCare! 🙏`,
  cancelled:   (b) => `🚫 *Booking Cancelled*\nHi ${b.customer_name}, your booking for *${b.service_type}* (Ref #${b.id}) has been cancelled. Please contact us if you'd like to rebook.`,
};

// Send one WhatsApp text message
async function sendWhatsApp(to, body) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId     = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion  = process.env.WHATSAPP_API_VERSION || "v19.0";

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
      console.error("[notify] Meta API error:", res.status, txt);
      return { ok: false, status: res.status, body: txt };
    }
    console.log("[notify] WhatsApp sent to", to, "— status:", res.status);
    return { ok: true };
  } catch (err) {
    console.error("[notify] fetch error:", err.message);
    return { ok: false, error: err.message };
  }
}

// Send a status-change notification if a message template exists for the status
async function notifyStatusChange(booking, newStatus) {
  const messageFn = STATUS_MESSAGES[newStatus];
  if (!messageFn) {
    console.log("[notify] No template for status:", newStatus, "— skipping");
    return;
  }

  const to = booking.customer_number;
  if (!to) {
    console.warn("[notify] No customer_number on booking", booking.id, "— cannot notify");
    return;
  }

  const body = messageFn(booking);
  console.log(`[notify] Sending "${newStatus}" notification to ${to} for booking #${booking.id}`);
  return sendWhatsApp(to, body);
}

module.exports = { sendWhatsApp, notifyStatusChange };

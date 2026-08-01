// api/cron/digest.js
// Scheduled job: send the "Today's Priorities" morning digest to shop owners.
// Triggered by Vercel Cron — protected with CRON_SECRET header.
// Runs hourly; only sends to a shop when it is the shop's configured morning
// hour in the shop's own timezone, and never more than once per UTC day.

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler } = require("../_lib/errors");
const { sendWhatsApp, sendEmail } = require("../_lib/notify");
const { buildCommandCenterForShop } = require("../_lib/command-center");
const { htmlEscape } = require("../_lib/security");

// ─── Local time helpers ─────────────────────────────────────────────────────
function getLocalHourMinute(timeZone, date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "Asia/Kolkata",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  let hour = 0;
  let minute = 0;
  for (const p of fmt.formatToParts(date || new Date())) {
    if (p.type === "hour") hour = parseInt(p.value, 10) % 24;
    if (p.type === "minute") minute = parseInt(p.value, 10);
  }
  return { hour, minute };
}

// ─── Money formatting (best-effort per shop currency) ───────────────────────
function fmtMoney(amount, currency) {
  const n = Number(amount || 0);
  if (currency === "INR") return "₹" + n.toLocaleString("en-IN");
  if (currency === "AED") return "AED " + n.toLocaleString("en-US");
  if (currency === "KWD") return "KD " + n.toLocaleString("en-US");
  return "$" + n.toLocaleString("en-US");
}

// ─── WhatsApp message ───────────────────────────────────────────────────────
function buildWhatsAppDigest(shop, cc) {
  const lines = [
    `☀️ *Good morning, ${shop.owner_name || shop.shop_name}!*`,
    `Here's what needs you at *${shop.shop_name}* today:`,
    "",
    "🎯 *Today's Priorities*",
  ];
  const p = cc.priorities || [];
  if (!p.length) {
    lines.push("✅ All clear — nothing needs your attention!");
  } else {
    const icons = { red: "🔴", yellow: "🟡", green: "🟢" };
    p.slice(0, 5).forEach((item) => lines.push(`${icons[item.level] || "•"} ${item.text}`));
  }

  const k = cc.kpis || {};
  lines.push("", "📊 *At a glance*");
  if (k.revenueToday != null) lines.push(`💰 Revenue today: ${fmtMoney(k.revenueToday, shop.currency)}`);
  if (k.aiConversationsToday != null) {
    lines.push(`🤖 AI handled ${k.aiConversationsToday} chats · booked ${k.aiBookingsToday} jobs today`);
  }
  if (cc.businessHealth) {
    lines.push(`🩺 Business Health: ${cc.businessHealth.score}/100 — ${cc.businessHealth.label}`);
  }
  lines.push("", `Open your dashboard: ${process.env.APP_URL || "https://coolcare.ai"}/shop-dashboard.html`);
  return lines.join("\n");
}

// ─── Email digest ───────────────────────────────────────────────────────────
function buildEmailDigest(shop, cc) {
  const k = cc.kpis || {};
  const p = cc.priorities || [];
  const icons = { red: "🔴", yellow: "🟡", green: "🟢" };

  const esc = (v) => htmlEscape(String(v ?? ""));
  const priorityRows = p.length
    ? p.slice(0, 6).map((item) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #222;color:#a3a3a3;font-size:13px;">${icons[item.level] || "•"}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #222;color:#e5e5e5;font-size:13px;"><strong style="color:#fff">${item.count}</strong> ${esc(item.text)}</td>
      </tr>`).join("")
    : `<tr><td style="padding:12px;color:#22c55e;font-size:14px;">✅ All clear — nothing needs your attention today!</td></tr>`;

  const revenueToday = k.revenueToday != null ? fmtMoney(k.revenueToday, shop.currency) : "—";
  const health = cc.businessHealth || {};

  return `<div style="font-family:Inter,sans-serif;padding:24px;background:#0a0a0a;color:#ededed;">
    <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid #222;border-radius:14px;padding:32px;">
      <h2 style="color:#fff;margin:0 0 6px;font-size:20px;">☀️ Good morning, ${esc(shop.owner_name || shop.shop_name)}!</h2>
      <p style="color:#a3a3a3;line-height:1.6;margin:0 0 22px;">Today's plan for <strong style="color:#fff">${esc(shop.shop_name)}</strong>.</p>

      <h3 style="color:#fff;font-size:14px;margin:0 0 10px;">🎯 Today's Priorities</h3>
      <table style="width:100%;border-collapse:collapse;background:#0a0a0a;border:1px solid #222;border-radius:10px;margin-bottom:22px;">${priorityRows}</table>

      <h3 style="color:#fff;font-size:14px;margin:0 0 10px;">📊 At a Glance</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="width:33%;text-align:center;padding:12px;background:#0a0a0a;border:1px solid #222;border-radius:10px;">
            <div style="font-size:11px;color:#737373;text-transform:uppercase;letter-spacing:0.5px;">Revenue Today</div>
            <div style="font-size:18px;font-weight:800;color:#22c55e;margin-top:4px;">${revenueToday}</div>
          </td>
          <td style="width:4px;"></td>
          <td style="width:33%;text-align:center;padding:12px;background:#0a0a0a;border:1px solid #222;border-radius:10px;">
            <div style="font-size:11px;color:#737373;text-transform:uppercase;letter-spacing:0.5px;">AI Booked Today</div>
            <div style="font-size:18px;font-weight:800;color:#fff;margin-top:4px;">${k.aiBookingsToday || 0} jobs</div>
          </td>
          <td style="width:4px;"></td>
          <td style="width:33%;text-align:center;padding:12px;background:#0a0a0a;border:1px solid #222;border-radius:10px;">
            <div style="font-size:11px;color:#737373;text-transform:uppercase;letter-spacing:0.5px;">Business Health</div>
            <div style="font-size:18px;font-weight:800;color:#fff;margin-top:4px;">${health.score || "—"}<span style="font-size:12px;color:#737373;">/100</span></div>
          </td>
        </tr>
      </table>

      <a href="${process.env.APP_URL || "https://coolcare.ai"}/shop-dashboard.html"
         style="display:block;text-align:center;background:#fff;color:#000;font-weight:700;font-size:14px;padding:14px 24px;border-radius:10px;text-decoration:none;margin-bottom:20px;">Open Command Center →</a>
      <hr style="border:none;border-top:1px solid #222;margin:20px 0;">
      <p style="color:#525252;font-size:12px;margin:0;">CoolCare — Better service, one conversation at a time.</p>
    </div></div>`;
}

module.exports = withErrorHandler(async (request, response) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers["authorization"] || "";
    if (auth !== `Bearer ${secret}`) {
      return response.status(401).json({ error: "Unauthorized" });
    }
  }

  const sql = neon(process.env.DATABASE_URL);
  const results = { scanned: 0, due: 0, sent: 0, skipped: 0, errors: [] };

  let shops = [];
  try {
    shops = await sql`
      SELECT rs.id, rs.shop_name, rs.owner_name, rs.email, rs.mobile,
             COALESCE(rs.timezone, 'Asia/Kolkata') AS timezone,
             COALESCE(rs.currency, 'USD') AS currency,
             COALESCE(rs.digest_enabled, true) AS digest_enabled,
             COALESCE(rs.digest_time, '08:00') AS digest_time,
             rs.digest_sent_at
      FROM repair_shops rs
      WHERE COALESCE(rs.subscription_status, 'inactive') = 'active'
        AND COALESCE(rs.is_demo, false) = false
        AND COALESCE(rs.is_active, true) = true
    `;
  } catch (e) {
    results.errors.push("query: " + e.message);
  }

  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);

  for (const shop of shops) {
    results.scanned++;
    if (shop.digest_enabled === false) { results.skipped++; continue; }

    // Parse the shop's configured digest time (default 08:00 local)
    const parts = String(shop.digest_time || "08:00").split(":");
    const digestHour = parseInt(parts[0], 10) || 8;

    // Only send during the configured local morning hour
    const { hour } = getLocalHourMinute(shop.timezone, now);
    if (hour !== digestHour) { results.skipped++; continue; }

    // Once-per-day guard (UTC date is a safe dedupe key for an hourly cron)
    if (shop.digest_sent_at) {
      const sentDay = new Date(shop.digest_sent_at).toISOString().slice(0, 10);
      if (sentDay === todayUtc) { results.skipped++; continue; }
    }

    if (!shop.mobile && !shop.email) { results.skipped++; continue; }

    results.due++;
    try {
      const cc = await buildCommandCenterForShop(sql, shop.id);
      let delivered = false;

      if (shop.mobile) {
        const wa = await sendWhatsApp(shop.mobile, buildWhatsAppDigest(shop, cc));
        if (wa.ok) delivered = true;
        else results.errors.push(`whatsapp shop#${shop.id}: ${wa.error || wa.status || "failed"}`);
      }
      if (shop.email) {
        const em = await sendEmail(shop.email, `☀️ ${shop.shop_name} — Today's Priorities`, buildEmailDigest(shop, cc));
        if (em.ok) delivered = true;
        else results.errors.push(`email shop#${shop.id}: ${em.error || em.status || "failed"}`);
      }

      // Only mark as sent when at least one channel actually delivered, so a
      // misconfigured provider doesn't suppress the digest for the whole day.
      if (delivered) {
        await sql`UPDATE repair_shops SET digest_sent_at = now(), updated_at = now() WHERE id = ${shop.id}`;
        results.sent++;
      } else {
        results.errors.push(`shop#${shop.id}: no channel delivered (check provider env vars)`);
      }
    } catch (e) {
      results.errors.push(`shop#${shop.id}: ${e.message}`);
    }
  }

  console.log("[cron/digest]", results);
  return response.status(200).json({ ok: true, ...results });
});

// api/cron/subscriptions.js
// Scheduled job: expire subscriptions, send renewal reminders.
// Triggered by Vercel Cron — protect with CRON_SECRET header.

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler } = require("../_lib/errors");
const { sendEmail } = require("../_lib/notify");

module.exports = withErrorHandler(async (request, response) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers["authorization"] || "";
    if (auth !== `Bearer ${secret}`) {
      return response.status(401).json({ error: "Unauthorized" });
    }
  }

  const sql = neon(process.env.DATABASE_URL);
  const results = { expired: 0, reminders: 0, errors: [] };

  // ─── Auto-expire subscriptions ───────────────────────────────────────────
  let autoExpire = true;
  try {
    const ps = await sql`SELECT value FROM platform_settings WHERE key = 'payment_settings' LIMIT 1`;
    if (ps[0]?.value) {
      const cfg = typeof ps[0].value === "string" ? JSON.parse(ps[0].value) : ps[0].value;
      autoExpire = cfg.auto_expire !== false;
    }
  } catch (e) { /* ok */ }

  if (autoExpire) {
    try {
      const expired = await sql`
        UPDATE subscriptions SET status = 'expired', updated_at = now()
        WHERE status = 'active' AND current_period_end < now()
        RETURNING id, repair_shop_id
      `;

      for (const sub of expired) {
        await sql`
          UPDATE repair_shops SET subscription_status = 'expired', updated_at = now()
          WHERE id = ${sub.repair_shop_id}
        `;
        try {
          await sql`
            INSERT INTO subscription_history (subscription_id, repair_shop_id, action, old_status, new_status, actor_type, notes)
            VALUES (${sub.id}, ${sub.repair_shop_id}, 'expired', 'active', 'expired', 'system', 'Auto-expired by cron')
          `;
        } catch (e) { /* ok */ }
        try {
          await sql`
            INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
            VALUES (${sub.repair_shop_id}, 'subscription_expired', 'Subscription Expired',
                    'Your CoolCare Pro subscription has expired. Renew to restore full access.',
                    '/shop-subscription.html')
          `;
        } catch (e) { /* ok */ }
        results.expired++;
      }
    } catch (e) {
      results.errors.push("expire: " + e.message);
    }
  }

  // ─── Renewal reminders ───────────────────────────────────────────────────
  let reminderDays = [7, 3, 1];
  try {
    const ps = await sql`SELECT value FROM platform_settings WHERE key = 'payment_settings' LIMIT 1`;
    if (ps[0]?.value) {
      const cfg = typeof ps[0].value === "string" ? JSON.parse(ps[0].value) : ps[0].value;
      if (Array.isArray(cfg.renewal_reminder_days)) reminderDays = cfg.renewal_reminder_days;
    }
  } catch (e) { /* ok */ }

  for (const days of reminderDays) {
    const d = parseInt(days, 10);
    if (!d || d < 1) continue;
    const eventType = `renewal_reminder_${d}d`;

    try {
      const subs = await sql(
        `SELECT s.id, s.repair_shop_id, s.current_period_end, s.billing_cycle,
                rs.email, rs.owner_name, rs.shop_name
         FROM subscriptions s
         JOIN repair_shops rs ON rs.id = s.repair_shop_id
         WHERE s.status = 'active'
           AND s.current_period_end > now()
           AND s.current_period_end <= now() + ($1 || ' days')::interval
           AND s.current_period_end > now() + (($1 - 1) || ' days')::interval
           AND NOT EXISTS (
             SELECT 1 FROM payment_logs pl
             WHERE pl.repair_shop_id = s.repair_shop_id
               AND pl.event_type = $2
               AND pl.created_at > now() - interval '23 hours'
           )`,
        [d, eventType]
      );

      for (const sub of subs) {
        if (!sub.email) continue;

        const expiryDate = new Date(sub.current_period_end).toLocaleDateString("en", {
          year: "numeric", month: "long", day: "numeric",
        });

        const html = `<div style="font-family:Inter,sans-serif;padding:24px;background:#0a0a0a;color:#ededed;">
          <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid #222;border-radius:12px;padding:32px;">
            <h2 style="color:#fff;margin:0 0 16px;font-size:20px;">Subscription Renewal Reminder</h2>
            <p style="color:#a3a3a3;line-height:1.6;">Hi ${sub.owner_name || sub.shop_name},</p>
            <p style="color:#a3a3a3;line-height:1.6;">Your CoolCare Pro subscription expires in <strong style="color:#fff">${d} day${d > 1 ? "s" : ""}</strong> (${expiryDate}).</p>
            <p style="color:#a3a3a3;line-height:1.6;">Renew now to keep your WhatsApp bot, dashboard, and all features running without interruption.</p>
            <a href="${process.env.APP_URL || "https://coolcare.ai"}/shop-subscription.html" style="display:inline-block;margin-top:16px;background:#fff;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Renew Subscription →</a>
            <hr style="border:none;border-top:1px solid #222;margin:24px 0;">
            <p style="color:#525252;font-size:12px;margin:0;">CoolCare — Better service, one conversation at a time.</p>
          </div></div>`;

        await sendEmail(sub.email, `CoolCare — Subscription renews in ${d} day${d > 1 ? "s" : ""}`, html);

        try {
          await sql`
            INSERT INTO payment_logs (repair_shop_id, gateway, event_type, severity, message)
            VALUES (${sub.repair_shop_id}, 'system', ${eventType}, 'info',
                    ${`Renewal reminder sent (${d} days before expiry)`})
          `;
        } catch (e) { /* ok */ }

        try {
          await sql`
            INSERT INTO shop_notifications (repair_shop_id, type, title, message, link)
            VALUES (${sub.repair_shop_id}, 'renewal_reminder', 'Renewal Reminder',
                    ${`Your subscription expires in ${d} day${d > 1 ? "s" : ""}. Renew now.`},
                    '/shop-subscription.html')
          `;
        } catch (e) { /* ok */ }

        results.reminders++;
      }
    } catch (e) {
      results.errors.push(`reminder_${d}d: ` + e.message);
    }
  }

  console.log("[cron/subscriptions]", results);
  return response.status(200).json({ ok: true, ...results });
});

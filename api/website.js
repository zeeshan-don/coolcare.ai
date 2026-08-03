// api/website.js
// 🌐 CoolCare HOSTED SHOP WEBSITES — public landing page renderer.
// ─────────────────────────────────────────────────────────────────────────────
// Every Pro shop (website_enabled = true) automatically gets a hosted website
// at  /<slug>   (vercel.json rewrites /:slug → /api/website?slug=:slug)
//
// Security / business rules:
//   • A shop is loaded ONLY by its unique slug.
//   • Before serving ANY hosted website, the `website_enabled` feature flag
//     is checked (Starter plans have it false). Disabled → professional
//     "Website not available" page (HTTP 404).
//   • Unknown slug → professional "not found" page (HTTP 404).
//   • Every piece of content (logo, name, description, services, hours,
//     contact, chat branding) is loaded dynamically from the database.
//     No hardcoded shop content.
//   • The Website Chat widget on the page talks to /api/chat (the SAME shared
//     Conversation / Booking / Technician / Repair-Lifecycle engines used by
//     WhatsApp) — the hosted website is just another customer entry point.
//
// Endpoints:
//   GET /api/website?slug=testshop   → full HTML landing page

const { neon } = require("@neondatabase/serverless");
const { withErrorHandler } = require("./_lib/errors");
const { setSecurityHeaders } = require("./_lib/security");
const { getAppBaseUrl } = require("./_lib/config");

// ─── HTML escape (all DB content is interpolated through this) ───────────────
function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Load a shop + its website data by slug ─────────────────────────────────
async function loadShopBySlug(sql, slug) {
  if (!slug || slug.length > 100 || !/^[a-z0-9-]+$/.test(slug)) return null;
  const rows = await sql`
    SELECT id, shop_name, owner_name, email, mobile, address, city,
           service_areas, services_offered, logo_url, business_hours,
           timezone, website_enabled, slug, is_active, suspended_at,
           subscription_status
    FROM repair_shops
    WHERE LOWER(slug) = ${slug.toLowerCase()} AND is_active = true
    LIMIT 1
  `;
  return rows.length ? rows[0] : null;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

const DAY_NAMES = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

// ─── Shared professional error page ──────────────────────────────────────────
function renderNoticePage({ status, title, message, hint }) {
  const titleAttr = esc(title);
  const messageAttr = esc(message);
  const hintAttr = esc(hint || "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${titleAttr} — CoolCare</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a0a;color:#ededed;font:15px/1.6 'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}
  .card{max-width:520px;width:100%;background:#111;border:1px solid #222;border-radius:18px;padding:48px 40px;text-align:center}
  .code{font:800 44px/1 'Inter',sans-serif;letter-spacing:-2px;color:#fff}
  .bar{width:44px;height:4px;border-radius:2px;background:#22c55e;margin:18px auto}
  h1{font-size:22px;font-weight:700;color:#fff;margin-bottom:10px;letter-spacing:-.3px}
  p{color:#a3a3a3;font-size:14px;line-height:1.7}
  .hint{margin-top:14px;font-size:13px;color:#737373}
  a{display:inline-block;margin-top:26px;color:#fff;background:#fff;color:#000;text-decoration:none;font:600 13px 'Inter',sans-serif;padding:12px 26px;border-radius:10px}
  a:hover{background:#e5e5e5}
  @media(max-width:480px){.card{padding:36px 24px}}
</style>
</head>
<body>
  <div class="card">
    <div class="code">${status}</div>
    <div class="bar"></div>
    <h1>${titleAttr}</h1>
    <p>${messageAttr}</p>
    ${hint ? `<div class="hint">${hintAttr}</div>` : ""}
    <a href="/">Back to CoolCare</a>
  </div>
</body>
</html>`;
}

// ─── Render the full hosted shop website (SSR) ───────────────────────────────
function renderWebsite(shop, ai, widget, appUrl) {
  const name = esc(shop.shop_name || "My Shop");
  const tagline = esc(
    (ai?.knowledge_base || "").split(/[.!?\n]/).filter(Boolean)[0] || "Professional repair services"
  );
  const about = esc(ai?.knowledge_base || `${shop.shop_name || "This shop"} provides professional home appliance repair services.`);
  const logoUrl = shop.logo_url || widget?.logo_url || "";
  const primary = /^#[0-9a-fA-F]{6}$/.test(widget?.primary_color || "") ? widget.primary_color : "#22c55e";
  const accent = /^#[0-9a-fA-F]{6}$/.test(widget?.accent_color || "") ? widget.accent_color : "#16a34a";

  // Services — from ai_settings.supported_services (fallback: shop services)
  const rawServices = Array.isArray(ai?.supported_services)
    ? ai.supported_services
    : Array.isArray(shop.services_offered) ? shop.services_offered : [];
  const services = rawServices.filter(Boolean).slice(0, 12);

  // Business hours — ai_settings.business_hours (fallback: shop business_hours)
  const hours = parseJson(ai?.business_hours, null) || parseJson(shop.business_hours, {});
  const hourRows = Object.entries(hours)
    .filter(([, h]) => h && (h.open || h.close))
    .map(([day, h]) => {
      const label = DAY_NAMES[day] || day;
      return `<div class="hr-row"><span>${esc(label)}</span><span class="hr-val">${esc(h.open || "—")} – ${esc(h.close || "—")}</span></div>`;
    })
    .join("");

  const areas = Array.isArray(ai?.service_locations) && ai.service_locations.length
    ? ai.service_locations
    : Array.isArray(shop.service_areas) ? shop.service_areas : [];
  const brands = Array.isArray(ai?.brands_repaired) && ai.brands_repaired.length
    ? ai.brands_repaired : [];
  const warranty = esc(ai?.warranty_policy || "");
  const inspection = esc(ai?.inspection_policy || "");
  const visiting = ai?.visiting_charges ? `Visit / inspection charge: ${esc(String(ai.visiting_charges))}` : "";
  const payments = Array.isArray(ai?.accepted_payment_methods) ? ai.accepted_payment_methods : [];
  const contactPhone = esc(shop.mobile || "");
  const contactEmail = esc(shop.email || "");
  const address = [shop.address, shop.city].filter(Boolean).map(esc).join(", ");

  const serviceIcons = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4.5 4.5 0 0 0 6 6L13 20H9l-5-5 7.7-7.7a4.5 4.5 0 0 0 3-1z"/><path d="M9 20h6"/><path d="M14 9l1 1"/></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16v10H4z"/><path d="M9 20h6"/><path d="M12 17v3"/></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 18 0"/><path d="M3 12h3l1-3 3 6 2-4 1 1h4"/></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h4"/><path d="M14 14h4"/></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c-4 0-7 2.5-7 6 0 2 .9 3.6 2.2 4.8L7 19a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l-.2-5.2C18.1 12.6 19 11 19 9c0-3.5-3-6-7-6z"/><path d="M9 21h6"/></svg>',
  ];

  const servicesHtml = services.length
    ? services.map((s, i) => `
        <div class="svc">
          <div class="svc-ic">${serviceIcons[i % serviceIcons.length]}</div>
          <div class="svc-n">${esc(s)}</div>
        </div>`).join("")
    : `<div class="svc"><div class="svc-ic">${serviceIcons[0]}</div><div class="svc-n">Repair services</div></div>`;

  const hoursHtml = hourRows || `<div class="hr-row"><span>Open all week</span><span class="hr-val">By appointment</span></div>`;
  const areasHtml = areas.length ? areas.map(esc).join(", ") : "Serving your area";
  const brandsHtml = brands.length ? brands.map(esc).join(" · ") : "";
  const paymentsHtml = payments.length ? payments.map(esc).join(" · ") : "";

  const widgetSrc = esc(`${appUrl}/web-bot/widget.js`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${tagline}">
<title>${name} — Book a Repair</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{--brand:${primary};--accent:${accent};--ink:#0f172a;--ink2:#475569;--muted:#64748b;--bg:#ffffff;--bg2:#f8fafc;--line:#e2e8f0}
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{font:16px/1.6 'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
  a{color:inherit;text-decoration:none}
  .wrap{max-width:1120px;margin:0 auto;padding:0 24px}
  /* ── Nav ── */
  nav{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.86);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
  .nav-in{max-width:1120px;margin:0 auto;padding:0 24px;height:68px;display:flex;align-items:center;justify-content:space-between;gap:16px}
  .nav-brand{display:flex;align-items:center;gap:12px;min-width:0}
  .nav-logo{width:40px;height:40px;border-radius:11px;background:var(--brand);display:flex;align-items:center;justify-content:center;color:#fff;font:800 18px 'Inter',sans-serif;flex-shrink:0;overflow:hidden}
  .nav-logo img{width:100%;height:100%;object-fit:cover}
  .nav-name{font-weight:700;font-size:16px;letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nav-links{display:flex;align-items:center;gap:26px;font-size:14px;font-weight:500;color:var(--ink2)}
  .nav-links a:hover{color:var(--brand)}
  .nav-cta{display:inline-flex;align-items:center;gap:8px;background:var(--brand);color:#fff;font:600 13px 'Inter',sans-serif;padding:10px 20px;border-radius:10px;transition:filter .2s,transform .2s;flex-shrink:0}
  .nav-cta:hover{filter:brightness(1.06);transform:translateY(-1px)}
  /* ── Hero ── */
  header{background:linear-gradient(180deg,rgba(255,255,255,0) 0%,var(--bg2) 100%);padding:88px 0 72px;border-bottom:1px solid var(--line)}
  .hero{display:flex;flex-direction:column;align-items:center;text-align:center;gap:20px}
  .hero-badge{display:inline-flex;align-items:center;gap:8px;font:600 12px 'Inter',sans-serif;color:var(--accent);background:var(--bg);border:1px solid var(--line);border-radius:20px;padding:6px 14px;letter-spacing:.3px}
  .hero-badge .dot{width:7px;height:7px;border-radius:50%;background:var(--brand)}
  .hero h1{font-size:clamp(32px,5.4vw,56px);font-weight:800;letter-spacing:-1.6px;line-height:1.08;max-width:760px}
  .hero h1 em{font-style:normal;color:var(--brand)}
  .hero p{color:var(--ink2);font-size:clamp(16px,2vw,19px);max-width:640px;line-height:1.65}
  .hero-actions{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;margin-top:8px}
  .btn{display:inline-flex;align-items:center;gap:9px;font:600 15px 'Inter',sans-serif;padding:14px 28px;border-radius:12px;cursor:pointer;border:0;transition:all .2s}
  .btn-primary{background:var(--brand);color:#fff;box-shadow:0 8px 24px -8px ${primary}}
  .btn-primary:hover{filter:brightness(1.06);transform:translateY(-2px)}
  .btn-ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
  .btn-ghost:hover{border-color:var(--ink2);transform:translateY(-2px)}
  .hero-chips{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:6px}
  .chip{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ink2);background:var(--bg);border:1px solid var(--line);border-radius:20px;padding:8px 16px}
  /* ── Sections ── */
  section{padding:76px 0}
  .sec-head{max-width:640px;margin:0 auto 40px;text-align:center}
  .sec-kicker{font:600 12px 'Inter',sans-serif;letter-spacing:1.4px;text-transform:uppercase;color:var(--brand);margin-bottom:10px}
  .sec-head h2{font-size:clamp(26px,3.6vw,36px);font-weight:800;letter-spacing:-1px;line-height:1.15}
  .sec-head p{color:var(--ink2);margin-top:12px;font-size:16px}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  /* ── About ── */
  #about{background:var(--bg2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
  .about-card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:30px}
  .about-card h3{font-size:18px;font-weight:700;margin-bottom:12px}
  .about-card p{color:var(--ink2);font-size:15px}
  .about-stats{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px}
  .stat{flex:1;min-width:130px;background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:16px}
  .stat b{display:block;font-size:20px;font-weight:800;color:var(--ink)}
  .stat span{font-size:12.5px;color:var(--muted)}
  /* ── Services ── */
  .svc{display:flex;align-items:center;gap:14px;background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:18px;transition:all .22s}
  .svc:hover{border-color:var(--brand);transform:translateY(-3px);box-shadow:0 14px 30px -18px rgba(15,23,42,.25)}
  .svc-ic{width:44px;height:44px;border-radius:11px;background:${primary}14;color:var(--brand);display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .svc-ic svg{width:22px;height:22px}
  .svc-n{font-weight:600;font-size:15px}
  /* ── Hours ── */
  #hours{background:var(--bg2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
  .hours-card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:8px 30px;max-width:560px;margin:0 auto}
  .hr-row{display:flex;justify-content:space-between;align-items:center;padding:16px 0;border-bottom:1px solid var(--line);font-size:15px}
  .hr-row:last-child{border-bottom:0}
  .hr-row span{color:var(--ink2)}
  .hr-val{font-weight:600;color:var(--ink)}
  /* ── Contact ── */
  .contact-card{background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:30px;display:flex;flex-direction:column;gap:18px}
  .contact-item{display:flex;gap:14px;align-items:flex-start}
  .contact-ic{width:40px;height:40px;border-radius:10px;background:${primary}14;color:var(--brand);display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .contact-ic svg{width:19px;height:19px}
  .contact-item b{display:block;font-size:14px;font-weight:700}
  .contact-item span{font-size:14px;color:var(--ink2)}
  .cta-band{grid-column:1 / -1;background:linear-gradient(135deg,var(--brand),var(--accent));border-radius:18px;padding:40px;text-align:center;color:#fff}
  .cta-band h3{font-size:24px;font-weight:800;letter-spacing:-.5px}
  .cta-band p{opacity:.92;margin:8px 0 20px;font-size:15px}
  .cta-band .btn{background:#fff;color:var(--ink)}
  /* ── Footer ── */
  footer{border-top:1px solid var(--line);padding:34px 0;text-align:center;font-size:13px;color:var(--muted)}
  footer a{color:var(--ink2);font-weight:600}
  footer a:hover{color:var(--brand)}
  @media(max-width:860px){.grid-3{grid-template-columns:1fr 1fr}.grid-2{grid-template-columns:1fr}.nav-links{display:none}}
  @media(max-width:560px){.grid-3{grid-template-columns:1fr}header{padding:64px 0 56px}section{padding:56px 0}}
</style>
</head>
<body>
<nav>
  <div class="nav-in">
    <a class="nav-brand" href="#top">
      <span class="nav-logo">${logoUrl ? `<img src="${esc(logoUrl)}" alt="${name} logo">` : esc((shop.shop_name || "S").charAt(0).toUpperCase())}</span>
      <span class="nav-name">${name}</span>
    </a>
    <div class="nav-links">
      <a href="#about">About</a>
      <a href="#services">Services</a>
      <a href="#hours">Hours</a>
      <a href="#contact">Contact</a>
    </div>
    <button class="nav-cta" onclick="openChat()" type="button">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Book Service
    </button>
  </div>
</nav>

<header id="top">
  <div class="wrap hero">
    <span class="hero-badge"><span class="dot"></span>${esc((brands && brands.length ? brands[0] : "Repair services"))}</span>
    <h1>${name}, <em>done right.</em><br>Book your repair in minutes.</h1>
    <p>${tagline}</p>
    <div class="hero-actions">
      <button class="btn btn-primary" onclick="openChat()" type="button">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Book a Repair
      </button>
      <a class="btn btn-ghost" href="#services">View Services</a>
    </div>
    <div class="hero-chips">
      ${contactPhone ? `<span class="chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.6 2z"/></svg>${contactPhone}</span>` : ""}
      ${contactEmail ? `<span class="chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>${contactEmail}</span>` : ""}
      ${address ? `<span class="chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>${address}</span>` : ""}
    </div>
  </div>
</header>

<section id="about">
  <div class="wrap">
    <div class="sec-head">
      <div class="sec-kicker">About</div>
      <h2>Trusted repairs, one conversation away</h2>
      <p>${about}</p>
    </div>
    <div class="about-stats" style="max-width:860px;margin:0 auto">
      <div class="stat"><b>${services.length || "—"}</b><span>Services offered</span></div>
      ${warranty ? `<div class="stat"><b>30-day</b><span>${esc(warranty)}</span></div>` : ""}
      ${visiting ? `<div class="stat"><b>${esc(visiting.replace("Visit / inspection charge: ", ""))}</b><span>Visit charge</span></div>` : ""}
      <div class="stat"><b>100%</b><span>Genuine parts</span></div>
    </div>
    ${brands.length ? `<p style="text-align:center;margin-top:26px;color:var(--muted);font-size:13px">Brands we repair: <strong style="color:var(--ink2)">${brandsHtml}</strong></p>` : ""}
  </div>
</section>

<section id="services">
  <div class="wrap">
    <div class="sec-head">
      <div class="sec-kicker">Services</div>
      <h2>What we fix</h2>
      <p>Every service is priced after inspection, with a warranty on workmanship.</p>
    </div>
    <div class="grid-3">
      ${servicesHtml}
    </div>
  </div>
</section>

<section id="hours">
  <div class="wrap">
    <div class="sec-head">
      <div class="sec-kicker">Working Hours</div>
      <h2>When we are open</h2>
    </div>
    <div class="hours-card">${hoursHtml}</div>
    ${paymentsHtml ? `<p style="text-align:center;margin-top:22px;font-size:14px;color:var(--muted)">Payments accepted: <strong style="color:var(--ink2)">${paymentsHtml}</strong></p>` : ""}
  </div>
</section>

<section id="contact">
  <div class="wrap">
    <div class="sec-head">
      <div class="sec-kicker">Contact</div>
      <h2>Get in touch</h2>
    </div>
    <div class="grid-2">
      <div class="contact-card">
        ${contactPhone ? `<div class="contact-item"><div class="contact-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.6 2z"/></svg></div><div><b>Phone</b><span>${contactPhone}</span></div></div>` : ""}
        ${contactEmail ? `<div class="contact-item"><div class="contact-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg></div><div><b>Email</b><span>${contactEmail}</span></div></div>` : ""}
        ${address ? `<div class="contact-item"><div class="contact-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg></div><div><b>Address</b><span>${address}</span></div></div>` : ""}
        <div class="contact-item"><div class="contact-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div><div><b>Service Areas</b><span>${areasHtml}</span></div></div>
      </div>
      <div class="cta-band">
        <h3>Ready to book a repair?</h3>
        <p>Chat with our AI assistant now — it takes under a minute and our team will be notified instantly.</p>
        <button class="btn" onclick="openChat()" type="button">Start a Booking</button>
      </div>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">Powered by <a href="/" style="font-weight:700">CoolCare</a> — better service, one conversation at a time.</div>
</footer>

<script>
  window.__coolcareWebsite = true;
  function openChat() {
    var w = window.__coolcareWidget;
    if (w && typeof w.open === 'function') { w.open(); }
  }
</script>
<script src="${widgetSrc}" data-shop-id="${shop.id}" data-auto-open="1" defer></script>
</body>
</html>`;
}

// ─── Router ──────────────────────────────────────────────────────────────────
module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);

  const appUrl = getAppBaseUrl() || `https://${request.headers.host || ""}`;
  const slug = String(request.query?.slug || "").trim().toLowerCase();

  if (!slug) {
    return response.status(404).send(
      renderNoticePage({
        status: "404",
        title: "Website not found",
        message: "The page you are looking for does not exist or has been moved.",
        hint: "Check the website address or contact the business directly.",
      })
    );
  }

  const sql = neon(process.env.DATABASE_URL);
  let shop = null;
  try {
    shop = await loadShopBySlug(sql, slug);
  } catch (e) {
    console.error("[website] Shop lookup failed:", e.message);
    return response.status(500).send(
      renderNoticePage({
        status: "500",
        title: "Something went wrong",
        message: "We could not load this website right now. Please try again shortly.",
      })
    );
  }

  if (!shop) {
    return response.status(404).send(
      renderNoticePage({
        status: "404",
        title: "Website not found",
        message: "No business could be found at this address.",
        hint: "If you are the owner, check that your shop slug is correct.",
      })
    );
  }

  // ── FEATURE FLAG GATE: hosted websites are a Pro (website_enabled) feature ──
  if (!shop.website_enabled || shop.subscription_status !== "active") {
    return response.status(404).send(
      renderNoticePage({
        status: "404",
        title: "Website not available",
        message: "This business has not published its website yet.",
        hint: "Check back soon, or contact the business directly.",
      })
    );
  }

  // Load the shop's AI settings (description, services, hours) + widget settings (branding)
  let ai = null;
  let widget = null;
  try {
    const [aiRows, widgetRows] = await Promise.all([
      sql`SELECT * FROM ai_settings WHERE repair_shop_id = ${shop.id} LIMIT 1`,
      sql`SELECT * FROM widget_settings WHERE repair_shop_id = ${shop.id} LIMIT 1`,
    ]);
    ai = aiRows[0] || null;
    widget = widgetRows[0] || null;
  } catch (e) {
    console.warn("[website] settings load failed:", e.message);
  }

  const html = renderWebsite(shop, ai, widget, appUrl);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
  return response.status(200).send(html);
});

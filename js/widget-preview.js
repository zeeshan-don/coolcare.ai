/*!
 * CoolCare — Website Chat live preview engine (shared, REAL — not a demo)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE implementation of the "preview the production widget" experience, used by
 *   • shop-channels.html  → "Preview Widget" button → full-page preview overlay
 *                           opened INSIDE the shop dashboard (mode: "overlay")
 *   • shop-sandbox.html   → the Developer Sandbox test page (mode: "inline")
 *
 * Nothing here is mocked:
 *   • The simulated repair-shop website is rendered with the shop's REAL
 *     branding (name + logo) fetched from the REAL /api/shop?action=shop-settings.
 *   • The PRODUCTION widget (web-bot/widget.js — the exact file customers
 *     embed on their sites) is injected and drives the REAL /api/chat API →
 *     REAL shared conversation engine → REAL bookings, technician assignment,
 *     business-hours logic, human handoff, image upload, notifications.
 *     channel = "website" — the exact same backend workflow as production.
 *   • A signed, short-lived sandbox ticket (issuable only by the authenticated
 *     shop owner via /api/shop?action=sandbox-ticket) lets the preview run
 *     even while the widget is publicly disabled — without weakening the
 *     public /api/chat gate for strangers.
 *   • The collapsible developer panel polls the REAL
 *     /api/shop?action=sandbox-status endpoint for live session state
 *     (conversation state, booking id, assigned technician, API status…).
 *
 * Usage:
 *   WidgetPreview.init({
 *     mode: 'overlay' | 'inline',
 *     shopId: 123,
 *     token: '<cc_token>',
 *     isDemo: false,
 *     mountId: 'previewMount',                     // inline mode only
 *     onWidgetDisabled: function (disabled) {},    // optional
 *   });
 *   WidgetPreview.open() / WidgetPreview.close()   // overlay mode only
 *   WidgetPreview.toast('message')
 */
(function (global) {
  'use strict';

  if (global.WidgetPreview) return; // one instance per page

  // ── State ──────────────────────────────────────────────────────────────────
  var cfg = null;
  var mode = 'inline';
  var shopId = 0;
  var token = '';
  var isDemo = false;

  var overlay = null;       // overlay mode: full-screen preview container
  var noteEl = null;        // overlay mode: "disabled → preview only" note
  var shell = null;         // the fake site shell
  var panelToggle = null;
  var panel = null;
  var pollTimer = null;
  var ticketTimer = null;
  var sandboxTicket = '';
  var widgetRequested = false;
  var widgetEnabled = true;
  var lastStatus = null;

  // ── Styles (namespaced `ccp-` so this module can live on any dashboard page) ──
  var CSS = [
    /* overlay (mode: overlay) */
    '.ccp-overlay{position:fixed;inset:0;z-index:2147482000;background:#0d0d10;overflow-y:auto;display:none;padding:0}',
    '.ccp-overlay.show{display:block}',
    '.ccp-topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:rgba(10,10,12,.96);backdrop-filter:blur(10px);border-bottom:1px solid #222;padding:11px 18px;color:#fff}',
    '.ccp-live-chip{display:inline-flex;align-items:center;gap:7px;background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:#22c55e;font:600 11px Inter,system-ui,sans-serif;letter-spacing:.3px;padding:5px 12px;border-radius:20px;flex-shrink:0}',
    '.ccp-live-chip .ccp-dot2{width:7px;height:7px;border-radius:50%;background:#22c55e;animation:ccpBlink 1.5s ease-in-out infinite}',
    '@keyframes ccpBlink{0%,100%{opacity:1}50%{opacity:.25}}',
    '.ccp-t-title{font:700 13px Inter,system-ui,sans-serif;color:#fff}',
    '.ccp-t-sub{font-size:11.5px;color:#9ca3af}',
    '.ccp-t-right{margin-left:auto;display:flex;align-items:center;gap:10px}',
    '.ccp-close-btn{background:#1c1c1f;border:1px solid #333;color:#e5e5e5;font:600 12px Inter,system-ui,sans-serif;padding:9px 16px;border-radius:9px;cursor:pointer;transition:all .2s}',
    '.ccp-close-btn:hover{background:#26262a;color:#fff;border-color:#555}',
    '.ccp-note{background:rgba(234,179,8,.08);border:1px solid rgba(234,179,8,.28);color:#eab308;font:500 12.5px Inter,system-ui,sans-serif;padding:11px 16px;margin:14px 18px 0;border-radius:10px;display:none}',
    '.ccp-note.show{display:block}',
    /* full-width in the overlay so the floating widget sits ON the site like a real website */
    '.ccp-sitewrap{max-width:1180px;margin:auto;padding:18px 18px 40px}',
    '.ccp-overlay .ccp-sitewrap{max-width:none;padding:0}',
    '.ccp-overlay .ccp-shell{border:0;border-radius:0;box-shadow:none;min-height:100%}',

    /* fake repair-shop website */
    '.ccp-shell{background:#fff;color:#111827;font-family:Inter,system-ui,sans-serif;border:1px solid #2a2a2e;border-radius:16px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.45)}',
    '.ccp-browserbar{display:flex;align-items:center;gap:8px;background:#e5e7eb;padding:10px 14px;border-bottom:1px solid #d1d5db}',
    '.ccp-dot{width:12px;height:12px;border-radius:50%}',
    '.ccp-url{flex:1;background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:5px 12px;font:400 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#6b7280}',
    '.ccp-site{font-family:Inter,system-ui,sans-serif;color:#111827;background:#fff}',
    '.ccp-nav{display:flex;align-items:center;justify-content:space-between;padding:16px 40px;border-bottom:1px solid #f3f4f6;background:#fff}',
    '.ccp-mode-inline .ccp-nav{position:sticky;top:0;z-index:5}',
    '.ccp-logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;color:#111827}',
    '.ccp-logo img{width:38px;height:38px;border-radius:9px}',
    '.ccp-snav{display:flex;gap:26px;font-size:14px;font-weight:500;color:#4b5563}',
    '.ccp-snav span{cursor:pointer}.ccp-snav span:hover{color:#16a34a}',
    '.ccp-hero{text-align:center;padding:64px 24px 56px;background:linear-gradient(180deg,#f0fdf4,transparent)}',
    '.ccp-hero h2{font-size:40px;letter-spacing:-1px;margin:0 0 12px;color:#111827}',
    '.ccp-hero p{font-size:17px;color:#4b5563;max-width:640px;margin:0 auto 26px}',
    '.ccp-cta{display:inline-block;background:#16a34a;color:#fff;font-weight:700;font-size:15px;padding:13px 30px;border-radius:999px;cursor:pointer;box-shadow:0 8px 20px rgba(22,163,74,.3)}',
    '.ccp-serv{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:40px;max-width:1080px;margin:auto}',
    '.ccp-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px;text-align:center;transition:all .2s;cursor:default}',
    '.ccp-card:hover{box-shadow:0 10px 26px rgba(0,0,0,.08);transform:translateY(-2px)}',
    '.ccp-card .ccp-ci{font-size:34px}',
    '.ccp-card b{display:block;margin:10px 0 4px;font-size:15px;color:#111827}',
    '.ccp-card p{font-size:13px;color:#6b7280;margin:0}',
    '.ccp-about{background:#f9fafb;padding:44px 40px;border-top:1px solid #f3f4f6;display:grid;grid-template-columns:1fr 1fr;gap:30px}',
    '.ccp-about h3{font-size:22px;margin:0 0 10px;color:#111827}',
    '.ccp-about p{color:#4b5563;font-size:14.5px;margin:0 0 12px}',
    '.ccp-about .ccp-tick{color:#16a34a;font-weight:600}',
    '.ccp-contact{text-align:center;padding:44px 24px;background:#111827;color:#e5e7eb}',
    '.ccp-contact h3{font-size:22px;margin:0 0 8px;color:#fff}',
    '.ccp-contact p{color:#9ca3af;font-size:14px;margin:2px 0}',
    '.ccp-foot{background:#0b1220;color:#6b7280;text-align:center;padding:18px;font-size:12.5px}',

    /* collapsible developer panel */
    '.ccp-panel-toggle{position:fixed;right:22px;top:90px;z-index:2147482900;background:#1a1a1c;border:1px solid #333;color:#ededed;font:600 12px Inter,system-ui,sans-serif;padding:10px 16px;border-radius:12px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.4);transition:all .2s;display:none}',
    '.ccp-panel-toggle:hover{color:#fff;border-color:#555}',
    '.ccp-panel-toggle.show{display:block}',
    '.ccp-panel{position:fixed;right:22px;top:134px;width:350px;max-width:calc(100vw - 30px);max-height:calc(100vh - 160px);overflow-y:auto;background:rgba(18,18,20,.97);backdrop-filter:blur(14px);border:1px solid #333;border-radius:16px;z-index:2147482950;box-shadow:0 24px 80px rgba(0,0,0,.6);display:none;padding:18px 18px 14px}',
    '.ccp-panel.show{display:block}',
    '.ccp-panel h4{font-size:13px;margin:0 0 12px;color:#fff;display:flex;align-items:center;gap:8px}',
    '.ccp-p-live{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:ccpBlink 1.5s ease-in-out infinite}',
    '.ccp-p-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)}',
    '.ccp-pk{font-size:11px;font-weight:600;color:#737373;letter-spacing:.3px;text-transform:uppercase;padding-top:2px}',
    '.ccp-pv{font:600 12px Inter,system-ui,sans-serif;color:#ededed;text-align:right;word-break:break-word;max-width:60%}',
    '.ccp-pv.good{color:#22c55e}.ccp-pv.bad{color:#ef4444}.ccp-pv.mid{color:#eab308}.ccp-pv.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
    '.ccp-p-actions{display:flex;gap:8px;margin-top:14px}',
    '.ccp-p-actions button{flex:1;background:#1a1a1c;border:1px solid #333;color:#a3a3a3;font:600 11px Inter,system-ui,sans-serif;padding:9px;border-radius:9px;cursor:pointer;transition:all .2s}',
    '.ccp-p-actions button:hover{color:#fff;border-color:#555}',
    '.ccp-p-actions .danger:hover{color:#ef4444;border-color:#ef4444}',
    '.ccp-p-ts{font-size:10px;color:#525252;margin-top:10px;text-align:center}',
    '.ccp-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#fff;color:#000;padding:14px 26px;border-radius:10px;font-size:13px;font-weight:600;opacity:0;transition:opacity .2s;z-index:2147482999;pointer-events:none}',
    '.ccp-toast.show{opacity:1}',
    '@media(max-width:900px){.ccp-serv{grid-template-columns:1fr}.ccp-about{grid-template-columns:1fr}.ccp-nav{padding:14px 20px}.ccp-snav{display:none}.ccp-hero h2{font-size:30px}}',
    '@media(max-width:680px){.ccp-panel-toggle{right:12px}.ccp-panel{right:12px;top:120px}.ccp-sitewrap{padding:10px 8px 24px}.ccp-shell{border-radius:12px}}',
  ].join('');

  // ── Small DOM helpers ───────────────────────────────────────────────────────
  function make(tag, attrs, html) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'style') node.style.cssText = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (html != null) node.innerHTML = html;
    return node;
  }

  function ensureStyle() {
    if (document.getElementById('ccp-style')) return;
    var s = make('style', { id: 'ccp-style' });
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── Fake repair-shop website (rendered with real shop branding) ──────────────
  function buildSiteHtml() {
    var siteName = '<span id="ccpSiteName">Your Repair Shop</span>';
    return (
      '<div class="ccp-shell">' +
        '<div class="ccp-browserbar">' +
          '<span class="ccp-dot" style="background:#f87171"></span>' +
          '<span class="ccp-dot" style="background:#fbbf24"></span>' +
          '<span class="ccp-dot" style="background:#34d399"></span>' +
          '<span class="ccp-url" id="ccpFakeUrl">https://my-repair-shop.example.com</span>' +
        '</div>' +
        '<div class="ccp-site" id="ccpSite">' +
          '<header class="ccp-nav">' +
            '<div class="ccp-logo"><img id="ccpSiteLogo" src="/demo-logo.svg" alt="logo" onerror="this.style.display=\'none\'">' + siteName + '</div>' +
            '<nav class="ccp-snav"><span>Services</span><span>About</span><span>Contact</span><span>Book Now</span></nav>' +
          '</header>' +
          '<div class="ccp-hero">' +
            '<h2 id="ccpHeroTitle">Same-Day Appliance Repair You Can Trust</h2>' +
            '<p>Expert technicians for AC, refrigerator, washing machine, geyser &amp; more — serviced at your doorstep with genuine parts and warranty.</p>' +
            '<div class="ccp-cta">📞 Call Now: 1800-000-0000</div>' +
          '</div>' +
          '<div class="ccp-serv">' +
            '<div class="ccp-card"><div class="ccp-ci">❄️</div><b>AC Repair</b><p>Cooling, gas refill, installation &amp; deep clean.</p></div>' +
            '<div class="ccp-card"><div class="ccp-ci">🧊</div><b>Refrigerator</b><p>Not cooling, water leaks, compressor issues.</p></div>' +
            '<div class="ccp-card"><div class="ccp-ci">🌀</div><b>Washing Machine</b><p>Drum, motor &amp; drainage fault repair.</p></div>' +
            '<div class="ccp-card"><div class="ccp-ci">🔥</div><b>Geyser</b><p>No hot water, thermostat &amp; element replacement.</p></div>' +
            '<div class="ccp-card"><div class="ccp-ci">📺</div><b>TV &amp; Microwave</b><p>Display, heating &amp; electrical repairs.</p></div>' +
            '<div class="ccp-card"><div class="ccp-ci">💧</div><b>RO Purifier</b><p>Filter change, motor &amp; tank service.</p></div>' +
          '</div>' +
          '<div class="ccp-about">' +
            '<div><h3>Why choose us?</h3>' +
              '<p><span class="ccp-tick">✓</span> Verified &amp; background-checked technicians</p>' +
              '<p><span class="ccp-tick">✓</span> Transparent pricing — no hidden charges</p>' +
              '<p><span class="ccp-tick">✓</span> 30-day service warranty on all repairs</p>' +
              '<p><span class="ccp-tick">✓</span> Same-day doorstep service</p>' +
            '</div>' +
            '<div><h3>About our shop</h3>' +
              '<p>We\'ve been fixing home appliances for over 15 years. Our trained technicians use genuine parts and are rated 4.9/5 by thousands of happy customers.</p>' +
            '</div>' +
          '</div>' +
          '<div class="ccp-contact">' +
            '<h3>Get in touch</h3>' +
            '<p>📍 12, 1st Main Road, Your City</p>' +
            '<p>📞 1800-000-0000 &nbsp;·&nbsp; ✉️ hello@example.com</p>' +
            '<p>🕘 Open 8 AM – 8 PM, all days</p>' +
          '</div>' +
          '<footer class="ccp-foot">© 2026 <span id="ccpFootName">Your Repair Shop</span> · Powered by CoolCare AI</footer>' +
        '</div>' +
      '</div>'
    );
  }

  // ── Build the site shell + (overlay mode) the full-page container ────────────
  function buildShell() {
    var node = make('div');
    node.innerHTML = buildSiteHtml();
    if (mode === 'inline') node.classList.add('ccp-mode-inline');
    return node;
  }

  function buildOverlay() {
    var o = make('div', { id: 'ccp-preview-overlay', class: 'ccp-overlay' });
    var topbar = make('div', { class: 'ccp-topbar' });
    topbar.innerHTML =
      '<span class="ccp-live-chip"><span class="ccp-dot2"></span>LIVE PREVIEW</span>' +
      '<div>' +
        '<div class="ccp-t-title">Website Chat Preview</div>' +
        '<div class="ccp-t-sub">This is the exact widget your customers embed — real AI, real bookings, real technicians.</div>' +
      '</div>' +
      '<div class="ccp-t-right">' +
        '<button type="button" class="ccp-close-btn" id="ccpCloseBtn">✕ Close Preview</button>' +
      '</div>';
    o.appendChild(topbar);

    noteEl = make('div', { class: 'ccp-note', id: 'ccpNote' });
    noteEl.textContent = '🔒 Website Chat is currently disabled for visitors. You are previewing with an authenticated test session — the real widget, real AI and real booking engine. Enable it when you are ready to go live.';
    o.appendChild(noteEl);

    var wrap = make('div', { class: 'ccp-sitewrap' });
    shell = buildShell();
    wrap.appendChild(shell);
    o.appendChild(wrap);
    document.body.appendChild(o);

    o.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'ccpCloseBtn') close();
    });
    return o;
  }

  // ── Developer panel ─────────────────────────────────────────────────────────
  function buildPanel() {
    panelToggle = make('button', { class: 'ccp-panel-toggle', id: 'ccpPanelToggle', type: 'button' });
    panelToggle.textContent = '🛠 Developer Panel';
    panelToggle.addEventListener('click', togglePanel);
    document.body.appendChild(panelToggle);

    panel = make('div', { class: 'ccp-panel', id: 'ccpDevPanel' });
    panel.innerHTML =
      '<h4><span class="ccp-p-live"></span> Live Session — Website Chat</h4>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Shop ID</span><span class="ccp-pv code" id="ccp-d-shop">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Widget ID</span><span class="ccp-pv code" id="ccp-d-widget">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Conversation ID</span><span class="ccp-pv code" id="ccp-d-visitor">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Channel</span><span class="ccp-pv">Website 🌐</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Conversation state</span><span class="ccp-pv code" id="ccp-d-state">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">AI status</span><span class="ccp-pv" id="ccp-d-ai">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Booking ID</span><span class="ccp-pv code" id="ccp-d-bookingId">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Booking status</span><span class="ccp-pv" id="ccp-d-booking">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Assigned technician</span><span class="ccp-pv" id="ccp-d-tech">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">API status</span><span class="ccp-pv good" id="ccp-d-conn">Online</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">API response time</span><span class="ccp-pv" id="ccp-d-rt">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Business hours</span><span class="ccp-pv" id="ccp-d-hours">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Active language</span><span class="ccp-pv" id="ccp-d-lang">—</span></div>' +
      '<div class="ccp-p-row"><span class="ccp-pk">Prompt version</span><span class="ccp-pv code" id="ccp-d-prompt">—</span></div>' +
      '<div class="ccp-p-actions">' +
        '<button type="button" id="ccpReset">↺ Reset session</button>' +
        '<button type="button" class="danger" id="ccpCloseHandoff">Close handoff</button>' +
      '</div>' +
      '<div class="ccp-p-ts" id="ccp-d-ts"></div>';
    document.body.appendChild(panel);

    document.getElementById('ccpReset').addEventListener('click', resetSession);
    document.getElementById('ccpCloseHandoff').addEventListener('click', closeHandoff);

    if (mode === 'inline') panelToggle.classList.add('show');
    else panelToggle.classList.remove('show');
  }

  var STATUS_LABELS = {
    NO_SESSION: 'No session yet — open the chat 👇',
    COLLECTING_APPLIANCE: 'Collecting appliance…',
    COLLECTING_ISSUE: 'Collecting issue…',
    COLLECTING_PHOTO: 'Asking for photo…',
    COLLECTING_NAME: 'Collecting name…',
    COLLECTING_ADDRESS: 'Collecting address…',
    COLLECTING_PHONE: 'Asking for phone…',
    COLLECTING_LOCALITY: 'Collecting area…',
    COLLECTING_DATE: 'Collecting date…',
    SELECTING_SLOT: 'Selecting slot…',
    CONFIRMATION_PENDING: 'Awaiting confirmation…',
    BOOKED: '✅ Booked',
    CANCELLED: '✕ Cancelled',
    HUMAN_HANDOFF: '🙋 Human handoff',
  };

  // ── Real branding into the fake site ────────────────────────────────────────
  function loadShop() {
    if (!token) return;
    fetch('/api/shop?action=shop-settings', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) {
        if (r.status === 401) { global.location.href = '/login.html'; throw new Error('unauthorized'); }
        return r.json();
      })
      .then(function (d) {
        var s = (d && (d.shop || d.settings)) || {};
        if (s.shop_name) {
          var elName = document.getElementById('ccpSiteName');
          var elFoot = document.getElementById('ccpFootName');
          var elHero = document.getElementById('ccpHeroTitle');
          var elUrl = document.getElementById('ccpFakeUrl');
          if (elName) elName.textContent = s.shop_name;
          if (elFoot) elFoot.textContent = s.shop_name;
          if (elHero) elHero.textContent = s.shop_name + ' — Same-Day Appliance Repair You Can Trust';
          if (elUrl) {
            var slug = s.shop_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-repair-shop';
            elUrl.textContent = 'https://' + slug + '.example.com';
          }
        }
        if (s.logo_url) {
          var img = document.getElementById('ccpSiteLogo');
          if (img) img.src = s.logo_url;
        }
      })
      .catch(function () { /* keep defaults */ });
  }

  // ── Real widget enabled state (drives the disabled note / warn banner) ──────
  function checkEnabled() {
    if (!token) return;
    fetch('/api/shop?action=widget-settings', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        widgetEnabled = !!(d && d.settings && d.settings.enabled);
        if (noteEl) noteEl.classList.toggle('show', !widgetEnabled && !isDemo);
        if (cfg && typeof cfg.onWidgetDisabled === 'function') cfg.onWidgetDisabled(!widgetEnabled);
      })
      .catch(function () { /* assume enabled */ });
  }

  // ── Sandbox ticket (signed, authenticated) so the REAL widget can run the REAL
  // engine even while disabled — without weakening the public /api/chat gate. ──
  function refreshTicket() {
    if (!token) return Promise.resolve('');
    return fetch('/api/shop?action=sandbox-ticket', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        sandboxTicket = (d && d.token) || '';
        global.__coolcareSandboxToken = sandboxTicket; // widget picks up freshest value
        return sandboxTicket;
      })
      .catch(function () { return ''; });
  }

  // ── Inject the PRODUCTION widget (same file customers embed) ────────────────
  function injectWidget() {
    if (document.getElementById('cc-widget-root')) { widgetRequested = true; return; }
    if (widgetRequested) return; // already injecting
    widgetRequested = true;
    refreshTicket().then(function () {
      if (document.getElementById('cc-widget-root')) return;
      var s = document.createElement('script');
      s.src = global.location.origin + '/web-bot/widget.js';
      s.setAttribute('data-widget-id', String(shopId));
      s.setAttribute('data-force-enable', '1'); // authenticated preview override
      if (sandboxTicket) s.setAttribute('data-sandbox-token', sandboxTicket);
      document.body.appendChild(s);
    });
  }

  // The widget stores its visitor id in localStorage: cc_widget_<shopId>
  function getVisitorId() {
    try {
      var v = localStorage.getItem('cc_widget_' + shopId);
      if (v && /^web_[A-Za-z0-9\-]{8,64}$/.test(v)) return v;
    } catch (e) { /* private mode */ }
    return null;
  }

  // ── Dev panel polling (REAL /api/shop?action=sandbox-status) ────────────────
  function pollStatus() {
    var visitor = getVisitorId();
    if (!visitor) {
      set('ccp-d-visitor', 'Waiting for widget…');
      set('ccp-d-ai', 'Open the chat below to start a session');
      set('ccp-d-ts', 'Waiting ' + new Date().toLocaleTimeString());
      return;
    }
    var t0 = performance.now();
    fetch('/api/shop?action=sandbox-status&visitor=' + encodeURIComponent(visitor), {
      headers: { Authorization: 'Bearer ' + token },
    })
      .then(function (res) {
        var ms = Math.round(performance.now() - t0);
        set('ccp-d-rt', ms + ' ms');
        if (res.status === 401) { global.location.href = '/login.html'; throw new Error('unauthorized'); }
        if (!res.ok) {
          conn('Error ' + res.status, 'bad');
          return null;
        }
        conn('Online', 'good');
        return res.json();
      })
      .then(function (d) {
        if (!d) return;
        lastStatus = d;
        renderPanel(d);
      })
      .catch(function (err) {
        if (err && err.message === 'unauthorized') return;
        conn('Offline', 'bad');
      });
  }

  function set(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text == null ? '—' : text;
  }

  function conn(text, cls) {
    var node = document.getElementById('ccp-d-conn');
    if (node) { node.textContent = text; node.className = 'ccp-pv ' + cls; }
  }

  function renderPanel(d) {
    set('ccp-d-shop', d.shopId != null ? d.shopId : '—');
    set('ccp-d-widget', d.widgetId != null ? d.widgetId : '—');
    set('ccp-d-visitor', d.visitorId || '—');

    // Conversation state
    var st = d.state || {};
    var parts = [];
    if (st.appliance) parts.push(st.appliance);
    if (st.issue) parts.push(st.issue);
    if (st.customer_name) parts.push('👤 ' + st.customer_name);
    if (st.area) parts.push('📍 ' + st.area);
    if (st.human_handoff) parts.push('🙋 handoff');
    set('ccp-d-state', parts.length ? parts.join(' · ') : (d.aiStatus === 'NO_SESSION' ? 'Waiting for first message' : 'Collecting details…'));

    // AI status
    set('ccp-d-ai', STATUS_LABELS[d.aiStatus] || d.aiStatus || '—');

    // Booking ID + status
    var bookingId = d.bookingId || (d.booking && d.booking.id) || null;
    var bidNode = document.getElementById('ccp-d-bookingId');
    if (bidNode) {
      if (bookingId) { bidNode.textContent = '#' + bookingId; bidNode.className = 'ccp-pv code good'; }
      else { bidNode.textContent = '—'; bidNode.className = 'ccp-pv code'; }
    }
    var bs = d.bookingStatus;
    var bNode = document.getElementById('ccp-d-booking');
    if (bNode) {
      bNode.textContent = bs || 'No booking yet';
      bNode.className = 'ccp-pv ' + (bs === 'completed' ? 'good' : (bs === 'cancelled' || bs === 'rejected' ? 'bad' : bs ? 'mid' : ''));
    }

    // Technician
    set('ccp-d-tech', d.technician && d.technician.name ? (d.technician.name + (d.technician.phone ? ' · ' + d.technician.phone : '')) : 'Not assigned');

    set('ccp-d-lang', (d.language || 'en').toUpperCase());
    set('ccp-d-prompt', d.promptVersion || '—');
    set('ccp-d-ts', 'Updated ' + new Date().toLocaleTimeString());

    // Business hours (today, shop-local)
    var bh = d.businessHours;
    if (bh && typeof bh === 'object' && Object.keys(bh).length) {
      var days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      var today = days[new Date().getDay()];
      var t = bh[today];
      set('ccp-d-hours', t && t.open ? (today + ': ' + t.open + '–' + t.close) : 'Configured');
    } else {
      set('ccp-d-hours', 'Not configured');
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollStatus, 3000);
    pollStatus();
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ── Panel actions ───────────────────────────────────────────────────────────
  function togglePanel() {
    var show = !panel.classList.contains('show');
    panel.classList.toggle('show', show);
    panelToggle.textContent = show ? '🛠 Close Panel' : '🛠 Developer Panel';
  }

  function resetSession() {
    try { localStorage.removeItem('cc_widget_' + shopId); } catch (e) { /* ignore */ }
    panel.classList.remove('show');
    panelToggle.textContent = '🛠 Developer Panel';
    showToast('Session reset — widget will start fresh');
    setTimeout(function () { global.location.reload(); }, 500);
  }

  function closeHandoff() {
    var visitor = getVisitorId();
    if (!visitor) { showToast('No active conversation'); return; }
    fetch('/api/shop', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'close-human-handoff', customerNumber: visitor }),
    })
      .then(function () { showToast('✅ Handoff closed — AI resumed'); pollStatus(); })
      .catch(function () { showToast('Failed'); });
  }

  // ── Toast (module-owned, namespaced) ────────────────────────────────────────
  var toastTimer = null;
  function showToast(msg) {
    var t = document.getElementById('ccpToast');
    if (!t) {
      t = make('div', { class: 'ccp-toast', id: 'ccpToast' });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  // ── Overlay open/close (mode: overlay) ─────────────────────────────────────
  function open() {
    if (!overlay) return;
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
    injectWidget();
    ensureWidgetVisible();
    showDevUI(true);
    startPolling();
    refreshTicket(); // keep long sessions alive
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('show');
    document.body.style.overflow = '';
    showDevUI(false);
    stopPolling();
    hideWidget();
  }

  function showDevUI(visible) {
    panelToggle.classList.toggle('show', visible);
    if (!visible) {
      panel.classList.remove('show');
      panelToggle.textContent = '🛠 Developer Panel';
    }
  }

  // The widget host lives at document.body level (the widget appends it there).
  // Keep it visible only while the preview is open so it never floats over the
  // dashboard after the preview is closed.
  function ensureWidgetVisible() {
    var host = document.getElementById('cc-widget-root');
    if (host && host.style.display === 'none') host.style.display = '';
    // If the widget already booted once, politely pop the chat open again.
    if (host && host.shadowRoot) {
      try {
        var ccw = host.shadowRoot.querySelector('.ccw');
        var bubble = host.shadowRoot.querySelector('.bubble');
        if (ccw && bubble && !ccw.classList.contains('open')) bubble.click();
      } catch (e) { /* ignore */ }
    }
  }

  function hideWidget() {
    var host = document.getElementById('cc-widget-root');
    if (host) host.style.display = 'none';
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  function init(opts) {
    if (cfg) return global.WidgetPreview;
    opts = opts || {};
    cfg = opts;
    mode = opts.mode === 'overlay' ? 'overlay' : 'inline';
    shopId = parseInt(opts.shopId, 10) || 0;
    token = opts.token || '';
    isDemo = !!opts.isDemo;

    ensureStyle();

    if (mode === 'overlay') {
      buildOverlay();
    } else {
      var mount = document.getElementById(opts.mountId || 'previewMount');
      if (!mount) mount = document.body;
      shell = buildShell();
      mount.appendChild(shell);
    }

    buildPanel();
    // Show the ids immediately — the live poll fills in the rest.
    set('ccp-d-shop', shopId);
    set('ccp-d-widget', shopId);
    loadShop();
    checkEnabled();

    if (mode === 'inline') {
      injectWidget();
      startPolling();
    }

    // Keep the sandbox ticket fresh (tickets expire after 30 min)
    ticketTimer = setInterval(refreshTicket, 10 * 60 * 1000);

    // Escape closes the preview overlay
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mode === 'overlay' && overlay && overlay.classList.contains('show')) close();
    });

    return global.WidgetPreview;
  }

  global.WidgetPreview = {
    init: init,
    open: open,
    close: close,
    toast: showToast,
  };
})(window);

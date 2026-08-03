/*!
 * CoolCare Website Live Chat Widget — v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Embed on ANY website with a single script tag:
 *
 *   <script src="https://coolcare.zeeshstudios.in/web-bot/widget.js" data-shop-id="SHOP_ID"></script>
 *
 * - No iframe. Renders inside a Shadow DOM so it can never clash with the
 *   host page's CSS/JS. Feels native.
 * - Talks to the SAME backend + AI engine as WhatsApp (api/chat.js →
 *   api/_lib/conversation-engine.js). One engine, two frontends.
 *
 * Features: floating bubble, responsive, dark/light mode, typing indicator,
 * seen status, image upload, file upload, emoji, timestamps, business
 * branding (logo/colors/name), multi-language UI, conversation history
 * (localStorage visitor id), human handoff, business hours support.
 */
(function () {
  "use strict";

  if (window.__coolcareWidget) return; // guard against double-include
  window.__coolcareWidget = true;

  // ── Resolve script tag attributes ──────────────────────────────────────────
  var scripts = document.getElementsByTagName("script");
  var script = scripts[scripts.length - 1];
  // Accept both data-shop-id (classic) and data-widget-id (new embed format)
  var shopId = script.getAttribute("data-widget-id") ||
    script.getAttribute("data-shop-id") ||
    script.dataset.shopId || script.dataset.widgetId || "";
  // Sandbox override — used ONLY by the authenticated Developer Sandbox page so
  // the shop owner can preview & test the widget before enabling it publicly.
  // The signed ticket (issued by /api/shop?action=sandbox-ticket) is what the
  // backend accepts as proof that this preview is legitimate.
  var forceEnable = script.getAttribute("data-force-enable") === "1" ||
    script.getAttribute("data-force-enable") === "true";
  var sandboxToken = script.getAttribute("data-sandbox-token") || "";
  // Hosted shop websites pass data-auto-open="1" so the chat opens by default
  // on the landing page (bookings start right away).
  var forcedAutoOpen = script.getAttribute("data-auto-open") === "1" ||
    script.getAttribute("data-auto-open") === "true";

  // Sandbox token may be refreshed by the host page while the widget is open —
  // prefer the freshest value so long testing sessions don't hit token expiry.
  function currentSandboxToken() {
    return sandboxToken || (window.__coolcareSandboxToken || "");
  }
  var apiBase = script.getAttribute("data-api") ||
    script.getAttribute("data-api-base") ||
    (function () {
      var src = script.getAttribute("src") || "";
      // Derive origin from the script URL (path-agnostic — works from
      // /widget.js or /web-bot/widget.js): https://host/widget.js
      var m = src.match(/^(https?:\/\/[^/]+)/);
      return m ? m[1] : window.location.origin;
    })();
  var forcedPosition = script.getAttribute("data-position") || null;
  var forcedColor = script.getAttribute("data-color") || null;
  var forcedTitle = script.getAttribute("data-title") || null;
  var forcedGreeting = script.getAttribute("data-greeting") || null;

  if (!shopId) {
    console.warn("[CoolCare] data-shop-id is required. Widget disabled.");
    return;
  }

  // ── i18n (widget chrome only — the AI conversation is multi-language) ──────
  var STRINGS = {
    en: {
      online: "Typically replies instantly",
      offline: "We're offline right now — we'll reply when we're back",
      placeholder: "Type a message…",
      send: "Send",
      attach: "Attach an image",
      emoji: "Emoji",
      close: "Close chat",
      open: "Chat with us",
      reset: "Start over",
      resetConfirm: "Reset this conversation?",
      transfer: "We've handed you to our team — a human will reply shortly.",
      you: "You",
      justNow: "just now",
    },
    hi: {
      online: "आमतौर पर तुरंत जवाब देते हैं",
      offline: "हम अभी ऑफ़लाइन हैं — वापस आने पर जवाब देंगे",
      placeholder: "संदेश लिखें…",
      send: "भेजें",
      attach: "छवि संलग्न करें",
      emoji: "इमोजी",
      close: "चैट बंद करें",
      open: "हमसे बात करें",
      reset: "फिर से शुरू करें",
      resetConfirm: "यह बातचीत रीसेट करें?",
      transfer: "हम आपको हमारी टीम से जोड़ रहे हैं — जल्द ही जवाब मिलेगा।",
      you: "आप",
      justNow: "अभी",
    },
    ar: {
      online: "يرد عادةً في الحال",
      offline: "نحن غير متصلين الآن — سنرد عندما نعود",
      placeholder: "اكتب رسالة…",
      send: "إرسال",
      attach: "إرفاق صورة",
      emoji: "رموز تعبيرية",
      close: "إغلاق الدردشة",
      open: "تحدث معنا",
      reset: "ابدأ من جديد",
      resetConfirm: "إعادة تعيين هذه المحادثة؟",
      transfer: "تم تحويلك إلى فريقنا — سيرد شخص قريباً.",
      you: "أنت",
      justNow: "الآن",
    },
  };

  function detectLang() {
    var nav = (navigator.language || "en").toLowerCase();
    if (nav.startsWith("ar")) return "ar";
    if (nav.startsWith("hi") || nav.startsWith("bn") || nav.startsWith("mr")) return "hi";
    return "en";
  }
  var lang = detectLang();
  var T = STRINGS[lang] || STRINGS.en;

  // ── Visitor identity (persists across visits) ──────────────────────────────
  var STORAGE_KEY = "cc_widget_" + shopId;
  function getVisitorId() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && /^web_[A-Za-z0-9\-]{8,64}$/.test(stored)) return stored;
    } catch (e) { /* private mode */ }
    var id = "web_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* ignore */ }
    return id;
  }
  var visitorId = getVisitorId();

  // ── State ──────────────────────────────────────────────────────────────────
  var config = {
    enabled: true,
    businessName: "Chat",
    logoUrl: "",
    primaryColor: "#22c55e",
    accentColor: "#16a34a",
    widgetPosition: "bottom-right",
    theme: "auto",
    showAvatar: true,
    autoOpen: false,
    language: "auto",
    welcomeMessage: "",
    offlineMessage: "",
    isOpen: true,
  };
  var open = false;
  var pollTimer = null;
  var sentIds = {};
  var booted = false;
  // In-flight send guard: one user message → one backend request. While a send
  // is awaiting its response, re-submitting the SAME text is dropped (double
  // Enter/click, paste+Enter races, retries). Different text queues normally.
  var inFlightText = null;

  // ── Shadow DOM host ────────────────────────────────────────────────────────
  var host = document.createElement("div");
  host.id = "cc-widget-root";
  var shadow = host.attachShadow({ mode: "open" });

  var css = `
  :host{all:initial}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  .ccw{--brand:${forcedColor || "#22c55e"};--accent:#16a34a;
    position:fixed;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
    -webkit-font-smoothing:antialiased;color-scheme:light}
  .ccw.dark{color-scheme:dark}
  .ccw[data-pos="bottom-left"]{left:22px;bottom:22px;right:auto}
  .ccw[data-pos="bottom-right"]{right:22px;bottom:22px}
  @media(max-width:480px){.ccw[data-pos="bottom-left"]{left:12px;bottom:12px}.ccw[data-pos="bottom-right"]{right:12px;bottom:12px}}
  .ccw *{box-sizing:border-box}

  /* ── Bubble ── */
  .bubble{width:62px;height:62px;border-radius:50%;background:var(--brand);
    display:flex;align-items:center;justify-content:center;cursor:pointer;
    box-shadow:0 8px 28px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.18);
    transition:transform .25s cubic-bezier(.2,.8,.3,1),box-shadow .25s;position:relative;user-select:none}
  .bubble:hover{transform:scale(1.07);box-shadow:0 12px 34px rgba(0,0,0,.34)}
  .bubble:active{transform:scale(.96)}
  .bubble svg{width:30px;height:30px;fill:#fff;transition:all .25s}
  .bubble .close-ico{display:none}
  .ccw.open .bubble .open-ico{display:none}
  .ccw.open .bubble .close-ico{display:block}
  .bubble::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:2px solid var(--brand);opacity:0;
    animation:pulse 2.2s ease-out infinite}
  .ccw.open .bubble::after{display:none}
  @keyframes pulse{0%{transform:scale(1);opacity:.55}70%{transform:scale(1.28);opacity:0}100%{opacity:0}}
  .bubble .unread{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;border-radius:10px;
    background:#ef4444;color:#fff;font:700 11px/20px -apple-system,sans-serif;text-align:center;
    padding:0 5px;display:none;box-shadow:0 2px 6px rgba(0,0,0,.3)}
  .bubble .unread.show{display:block}

  /* ── Window ── */
  .window{position:fixed;width:min(390px,calc(100vw - 24px));height:min(640px,calc(100vh - 120px));
    border-radius:18px;overflow:hidden;background:var(--bg,#fff);color:var(--ink,#1a1a1a);
    box-shadow:0 24px 70px rgba(0,0,0,.32),0 4px 16px rgba(0,0,0,.14);
    display:none;flex-direction:column;opacity:0;transform:translateY(14px) scale(.97);
    transition:opacity .22s ease,transform .25s cubic-bezier(.2,.8,.3,1)}
  .ccw[data-pos="bottom-left"] .window{left:22px;bottom:96px}
  .ccw[data-pos="bottom-right"] .window{right:22px;bottom:96px}
  @media(max-width:480px){.window{left:0!important;right:0!important;bottom:0!important;width:100vw;height:100vh;max-height:100vh;border-radius:0}}
  .ccw.open .window{display:flex;opacity:1;transform:translateY(0) scale(1)}
  .ccw.dark{--bg:#121212;--bg2:#1b1b1b;--bg3:#232323;--ink:#ececec;--ink2:#a9a9a9;--border:#2a2a2a}
  .ccw.light{--bg:#ffffff;--bg2:#f5f6f7;--bg3:#ececec;--ink:#1a1a1a;--ink2:#6b7280;--border:#e6e7e9}

  /* Header */
  .head{background:var(--brand);color:#fff;padding:16px 16px 14px;flex-shrink:0;position:relative}
  .head::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:1px;background:rgba(255,255,255,.14)}
  .head-top{display:flex;align-items:center;gap:12px}
  .logo{width:42px;height:42px;border-radius:11px;background:rgba(255,255,255,.18);display:flex;
    align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;border:1px solid rgba(255,255,255,.25)}
  .logo img{width:100%;height:100%;object-fit:cover}
  .logo .ph{color:#fff;font:800 18px -apple-system,sans-serif}
  .head-info{flex:1;min-width:0}
  .head-title{font:700 15px -apple-system,sans-serif;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .head-status{font:500 11px -apple-system,sans-serif;opacity:.9;margin-top:2px;display:flex;align-items:center;gap:6px}
  .head-status .dot{width:7px;height:7px;border-radius:50%;background:#fff;display:inline-block;animation:blink 1.6s ease-in-out infinite}
  .ccw.open .head-status .dot{background:var(--accent,#fff)}
  .head-status.off .dot{background:rgba(255,255,255,.55);animation:none}
  .head-reset{margin-left:auto;background:rgba(255,255,255,.16);border:none;color:#fff;border-radius:8px;
    font:600 11px -apple-system,sans-serif;padding:7px 11px;cursor:pointer;flex-shrink:0;transition:background .2s}
  .head-reset:hover{background:rgba(255,255,255,.28)}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}

  /* Messages */
  .msgs{flex:1;overflow-y:auto;padding:18px 16px 8px;background:var(--bg);display:flex;flex-direction:column;gap:10px;
    scroll-behavior:smooth}
  .msgs::-webkit-scrollbar{width:5px}.msgs::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
  .msg{display:flex;gap:9px;max-width:86%;animation:msgIn .28s cubic-bezier(.2,.8,.3,1)}
  @keyframes msgIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .msg.bot{align-self:flex-start}
  .msg.user{align-self:flex-end;flex-direction:row-reverse}
  .avatar{width:28px;height:28px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;
    justify-content:center;font:700 12px -apple-system,sans-serif;color:var(--ink2);flex-shrink:0;margin-top:14px;overflow:hidden}
  .avatar img{width:100%;height:100%;object-fit:cover}
  .msg.user .avatar{display:none}
  .bubble-msg{background:var(--bg2);border:1px solid var(--border);border-radius:14px 14px 14px 4px;
    padding:10px 14px;font:400 13.5px/1.55 -apple-system,sans-serif;color:var(--ink);word-break:break-word;
    white-space:pre-wrap;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .msg.user .bubble-msg{background:var(--brand);border-color:transparent;color:#fff;border-radius:14px 14px 4px 14px}
  .msg .media{margin-top:8px;border-radius:10px;overflow:hidden;max-width:230px;border:1px solid var(--border);display:block}
  .msg .media img{width:100%;display:block;max-height:180px;object-fit:cover}
  .msg .file-chip{display:inline-flex;align-items:center;gap:8px;background:var(--bg3);border-radius:9px;
    padding:8px 12px;font:600 12px -apple-system,sans-serif;color:var(--ink);margin-top:6px;text-decoration:none}
  .msg-meta{margin-top:4px;display:flex;align-items:center;gap:5px;font:500 10px -apple-system,sans-serif;color:var(--ink2)}
  .msg.user .msg-meta{justify-content:flex-end}
  .ticks{color:rgba(255,255,255,.85);font-size:11px;letter-spacing:-1px}
  .ticks.seen{color:#bfefff}

  /* System / transfer */
  .sys{align-self:center;text-align:center;font:500 11.5px -apple-system,sans-serif;color:var(--ink2);
    background:var(--bg3);padding:6px 14px;border-radius:12px;max-width:90%}

  /* Typing */
  .typing{display:inline-flex;gap:4px;align-items:center;padding:4px 2px}
  .typing span{width:7px;height:7px;border-radius:50%;background:var(--ink2);animation:tp 1.2s ease-in-out infinite}
  .typing span:nth-child(2){animation-delay:.18s}.typing span:nth-child(3){animation-delay:.36s}
  @keyframes tp{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-5px);opacity:1}}

  /* Input */
  .input-bar{display:flex;align-items:flex-end;gap:8px;padding:12px 14px;background:var(--bg);
    border-top:1px solid var(--border);flex-shrink:0}
  .emoji-btn,.attach-btn{width:38px;height:38px;border-radius:10px;border:none;background:var(--bg2);
    cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:19px;flex-shrink:0;
    transition:background .2s,transform .15s;color:var(--ink)}
  .emoji-btn:hover,.attach-btn:hover{background:var(--bg3);transform:scale(1.06)}
  .text-input{flex:1;resize:none;border:1px solid var(--border);background:var(--bg2);color:var(--ink);
    border-radius:12px;padding:10px 13px;font:400 13.5px/1.4 -apple-system,sans-serif;min-height:40px;max-height:110px;
    outline:none;transition:border-color .2s}
  .text-input:focus{border-color:var(--brand)}
  .text-input::placeholder{color:var(--ink2)}
  .send-btn{width:38px;height:38px;border-radius:10px;border:none;background:var(--brand);color:#fff;
    cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s}
  .send-btn:hover{filter:brightness(1.1);transform:scale(1.05)}
  .send-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
  .send-btn svg{width:18px;height:18px;fill:#fff}
  .emoji-panel{display:none;flex-wrap:wrap;gap:6px;padding:10px 14px;background:var(--bg);
    border-top:1px solid var(--border)}
  .emoji-panel.show{display:flex}
  .emoji-panel button{font-size:21px;background:none;border:none;cursor:pointer;padding:4px;border-radius:8px;transition:transform .12s}
  .emoji-panel button:hover{transform:scale(1.3)}

  .offline-banner{background:var(--bg3);color:var(--ink2);font:500 11.5px -apple-system,sans-serif;
    padding:9px 16px;text-align:center;flex-shrink:0}
  `;

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  // ── Build DOM ──────────────────────────────────────────────────────────────
  var root = document.createElement("div");
  root.className = "ccw" + (config.theme === "dark" ? " dark" : config.theme === "light" ? " light" : "");
  root.dataset.pos = "bottom-right";
  root.innerHTML = `
    <div class="bubble" title="${T.open}" aria-label="${T.open}">
      <span class="unread" id="cc-unread"></span>
      <svg class="open-ico" viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.8 1.5 5.3 3.9 7-.3 1.3-.9 2.5-1.7 3.4-.2.3 0 .8.4.8 1.7-.2 3.2-.8 4.4-1.6.9.2 1.9.3 3 .3 5.5 0 10-3.9 10-8.7S17.5 3 12 3z"/></svg>
      <svg class="close-ico" viewBox="0 0 24 24"><path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4l-4.9-4.9 4.9-4.9a1 1 0 0 0 0-1.4z"/></svg>
    </div>
    <div class="window">
      <div class="head">
        <div class="head-top">
          <div class="logo" id="cc-logo"></div>
          <div class="head-info">
            <div class="head-title" id="cc-title">Chat</div>
            <div class="head-status" id="cc-status"><span class="dot"></span><span id="cc-status-text">${T.online}</span></div>
          </div>
          <button class="head-reset" id="cc-reset" title="${T.reset}">↺ ${T.reset}</button>
        </div>
      </div>
      <div class="offline-banner" id="cc-offline" style="display:none"></div>
      <div class="msgs" id="cc-msgs"></div>
      <div class="emoji-panel" id="cc-emoji"></div>
      <div class="input-bar">
        <button class="emoji-btn" id="cc-emoji-btn" title="${T.emoji}">😊</button>
        <button class="attach-btn" id="cc-attach" title="${T.attach}">📎</button>
        <textarea class="text-input" id="cc-input" rows="1" placeholder="${T.placeholder}"></textarea>
        <button class="send-btn" id="cc-send" title="${T.send}">
          <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
        </button>
      </div>
    </div>
    <input type="file" id="cc-file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display:none">
  `;
  shadow.appendChild(root);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function $(id) { return shadow.getElementById(id); }
  var msgsEl = $("cc-msgs");
  var inputEl = $("cc-input");
  var unreadEl = $("cc-unread");

  function apiUrl(action, params) {
    var url = apiBase + "/api/chat" + (action ? "?action=" + action : "");
    if (params) {
      Object.keys(params).forEach(function (k) {
        url += (url.indexOf("?") === -1 ? "?" : "&") + encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
      });
    }
    return url;
  }

  function post(body) {
    return fetch(apiBase + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || "Request failed"); });
      return r.json();
    });
  }

  function applyConfig(cfg) {
    config = Object.assign(config, cfg);
    root.dataset.pos = config.widgetPosition || forcedPosition || "bottom-right";
    root.className = "ccw";
    var theme = forcedTheme() || config.theme || "auto";
    if (theme === "dark") root.classList.add("dark");
    else if (theme === "light") root.classList.add("light");
    else {
      var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.add(prefersDark ? "dark" : "light");
    }
    var brand = forcedColor || config.primaryColor || "#22c55e";
    root.style.setProperty("--brand", brand);
    var accent = config.accentColor || "#16a34a";
    root.style.setProperty("--accent", accent);
    // Language override for the widget chrome (AI conversation stays auto-detected)
    if (config.language && config.language !== "auto" && STRINGS[config.language]) {
      lang = config.language;
      T = STRINGS[lang];
      applyChromeStrings();
    }
    $("cc-title").textContent = forcedTitle || config.businessName || "Chat";
    // Logo
    var logo = $("cc-logo");
    logo.innerHTML = "";
    if (config.logoUrl) {
      var img = document.createElement("img");
      img.src = config.logoUrl;
      img.alt = "";
      img.onerror = function () { logo.innerHTML = '<span class="ph">' + (config.businessName || "C").charAt(0).toUpperCase() + "</span>"; };
      logo.appendChild(img);
    } else {
      logo.innerHTML = '<span class="ph">' + (config.businessName || "C").charAt(0).toUpperCase() + "</span>";
    }
    // Status
    var status = $("cc-status");
    var statusText = $("cc-status-text");
    if (config.isOpen === false) {
      status.classList.add("off");
      statusText.textContent = T.offline;
    } else {
      status.classList.remove("off");
      statusText.textContent = T.online;
    }
    // Offline banner
    var banner = $("cc-offline");
    if (config.isOpen === false) {
      banner.style.display = "block";
      banner.textContent = config.offlineMessage || T.offline;
    } else {
      banner.style.display = "none";
    }
  }

  function forcedTheme() {
    return script.getAttribute("data-theme") || null;
  }

  // Re-apply static chrome strings (used when the language changes via config)
  function applyChromeStrings() {
    var inp = $("cc-input"); if (inp) inp.placeholder = T.placeholder;
    var reset = $("cc-reset"); if (reset) { reset.title = T.reset; reset.textContent = "↺ " + T.reset; }
    var emoji = $("cc-emoji-btn"); if (emoji) emoji.title = T.emoji;
    var attach = $("cc-attach"); if (attach) attach.title = T.attach;
    var send = $("cc-send"); if (send) send.title = T.send;
    var bubble = root.querySelector(".bubble");
    if (bubble) { bubble.title = T.open; bubble.setAttribute("aria-label", T.open); }
  }

  // ── Message rendering ──────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d)) return "";
      var now = new Date();
      var diff = now - d;
      if (diff < 60000) return T.justNow;
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  function addMessage(msg) {
    if (!msg || !msg.role) return;
    // Dedupe by id AND created_at. The same bot reply reaches the widget twice:
    // once as the POST /send response (with a synthetic id) and again via the
    // 4s poll (with its real DB id). Keying on created_at catches the poll copy,
    // so one user message renders EXACTLY one AI response.
    var idKey = msg.id ? String(msg.id) : null;
    var tsKey = msg.created_at ? "ts:" + msg.created_at : null;
    if (idKey && sentIds[idKey]) return;
    if (tsKey && sentIds[tsKey]) return;
    if (idKey) sentIds[idKey] = true;
    if (tsKey) sentIds[tsKey] = true;

    var wrap = document.createElement("div");
    wrap.className = "msg " + (msg.role === "bot" ? "bot" : "user");

    if (msg.role === "bot" && config.showAvatar !== false) {
      var av = document.createElement("div");
      av.className = "avatar";
      if (config.logoUrl) {
        var img = document.createElement("img");
        img.src = config.logoUrl; img.alt = "";
        av.appendChild(img);
      } else {
        av.textContent = (config.businessName || "C").charAt(0).toUpperCase();
      }
      wrap.appendChild(av);
    }

    var col = document.createElement("div");
    col.style.cssText = "display:flex;flex-direction:column";
    var bubble = document.createElement("div");
    bubble.className = "bubble-msg";

    var text = msg.message || "";
    // Simple markdown-lite: **bold**, *italic*, links
    text = esc(text);
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
    text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">$1</a>');
    bubble.innerHTML = text.replace(/\n/g, "<br>");

    col.appendChild(bubble);

    if (msg.media_url) {
      var media = document.createElement("div");
      media.className = "media";
      var img = document.createElement("img");
      img.src = msg.media_url; img.alt = "";
      media.appendChild(img);
      col.appendChild(media);
    }

    if (msg.file_name) {
      var chip = document.createElement("div");
      chip.className = "file-chip";
      var chipIcon = document.createElement("span");
      chipIcon.textContent = "📎";
      var chipName = document.createElement("span");
      chipName.textContent = msg.file_name;
      chip.appendChild(chipIcon);
      chip.appendChild(chipName);
      col.appendChild(chip);
    }

    var meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = fmtTime(msg.created_at);
    if (msg.role === "user") {
      var ticks = document.createElement("span");
      ticks.className = "ticks" + (msg.seen ? " seen" : "");
      ticks.textContent = msg.seen ? "✓✓" : "✓";
      meta.appendChild(ticks);
    }
    col.appendChild(meta);
    wrap.appendChild(col);
    msgsEl.appendChild(wrap);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function addSystem(text) {
    var s = document.createElement("div");
    s.className = "sys";
    s.textContent = text;
    msgsEl.appendChild(s);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function showTyping() {
    hideTyping();
    var w = document.createElement("div");
    w.className = "msg bot";
    w.id = "cc-typing";
    var col = document.createElement("div");
    col.style.cssText = "display:flex;flex-direction:column";
    var b = document.createElement("div");
    b.className = "bubble-msg";
    b.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    col.appendChild(b);
    w.appendChild(col);
    msgsEl.appendChild(w);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function hideTyping() {
    var t = shadow.getElementById("cc-typing");
    if (t) t.remove();
  }

  function setBubbleOpen(v) {
    root.classList.toggle("open", v);
    if (v) unreadEl.classList.remove("show");
  }

  // ── Business logic ─────────────────────────────────────────────────────────
  function sendMessage(text, imageData) {
    if (!text && !imageData) return;
    // Duplicate-submit guard: identical text already in flight → drop.
    if (!imageData && text && inFlightText !== null && text === inFlightText) return;
    if (!imageData && text) inFlightText = text;
    var messageType = imageData ? "image" : "text";
    var payload = {
      action: "send",
      shopId: shopId,
      visitorId: visitorId,
      message: text || "",
      messageType: messageType,
    };
    var sTok = forceEnable ? currentSandboxToken() : "";
    if (sTok) payload.sandboxToken = sTok;
    if (imageData) payload.imageData = imageData;

    // Optimistically render the user message
    addMessage({
      id: "local-" + Date.now(),
      role: "user",
      message: text || "(image)",
      created_at: new Date().toISOString(),
      seen: false,
    });
    if (imageData) {
      // show the image preview
      var msgs = msgsEl.querySelectorAll(".msg.user");
      var last = msgs[msgs.length - 1];
      if (last) {
        var img = document.createElement("img");
        img.src = imageData;
        img.className = "media";
        img.style.cssText = "display:block;max-width:200px;border-radius:10px;margin-top:6px";
        last.querySelector(".bubble-msg").appendChild(img);
      }
    }

    inputEl.value = "";
    inputEl.style.height = "auto";
    showTyping();
    sendBtn.disabled = true;

    post(payload)
      .then(function (data) {
        hideTyping();
        sendBtn.disabled = false;
        inFlightText = null;
        // Duplicate reply from the API (suppressed server-side) → do not render.
        if (data.duplicate) return;
        // Use the server's created_at (replyCreatedAt) so the polled copy of
        // this reply is deduped instead of rendered a second time.
        if (data.reply) addMessage({ id: "bot-" + Date.now(), role: "bot", message: data.reply, created_at: data.replyCreatedAt || new Date().toISOString() });
        if (data.isOpen === false) {
          var status = $("cc-status");
          status.classList.add("off");
          $("cc-status-text").textContent = T.offline;
        }
      })
      .catch(function (err) {
        hideTyping();
        sendBtn.disabled = false;
        inFlightText = null;
        addSystem(err.message || "Something went wrong. Please try again.");
      });
  }

  // ── Init flow ──────────────────────────────────────────────────────────────
  function boot() {
    if (booted) return;
    booted = true;
    document.body.appendChild(host);

    fetch(apiUrl("config", { shopId: shopId }))
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (cfg && cfg.enabled === false && !forceEnable) {
          // Widget disabled — hide entirely (unless sandbox force-enable)
          host.remove();
          return;
        }
        applyConfig(cfg || {});
        initInteractions();
        startSession();
        // Auto-open the chat window when configured (or in the sandbox preview)
        if (config.autoOpen || forceEnable || forcedAutoOpen) {
          setTimeout(function () {
            open = true;
            setBubbleOpen(true);
            if (inputEl) inputEl.focus();
          }, 700);
        }
      })
      .catch(function () {
        // Network failure — keep a minimal bubble so visitors can still chat
        applyConfig({ businessName: "Chat" });
        initInteractions();
      });
  }

  var sendBtn, attachInput;

  function initInteractions() {
    sendBtn = $("cc-send");
    attachInput = $("cc-file");

    var bubble = root.querySelector(".bubble");
    bubble.addEventListener("click", function () {
      open = !open;
      setBubbleOpen(open);
      if (open) {
        // Mark all as seen on open
        document.querySelectorAll(".ccw .ticks").forEach(function (t) { /* noop */ });
        inputEl.focus();
      }
    });

    var resetBtn = $("cc-reset");
    resetBtn.addEventListener("click", function () {
      if (window.confirm(T.resetConfirm)) {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
        visitorId = getVisitorId();
        msgsEl.innerHTML = "";
        startSession();
      }
    });

    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputEl.value.trim(), null);
      }
      autoGrow();
    });
    inputEl.addEventListener("input", autoGrow);
    function autoGrow() {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 110) + "px";
    }

    sendBtn.addEventListener("click", function () { sendMessage(inputEl.value.trim(), null); });

    $("cc-attach").addEventListener("click", function () { attachInput.click(); });
    attachInput.addEventListener("change", function () {
      var file = attachInput.files[0];
      attachInput.value = "";
      if (!file) return;
      var isImage = /^image\//.test(file.type);
      var isDoc = ["application/pdf", "text/plain", "text/csv", "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].indexOf(file.type) !== -1;
      if (!isImage && !isDoc) { addSystem("Unsupported file type."); return; }
      if (isImage && file.size > 2 * 1024 * 1024) { addSystem("Image too large (max 2 MB)."); return; }
      if (isDoc && file.size > 3 * 1024 * 1024) { addSystem("File too large (max 3 MB)."); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = reader.result;
        showTyping();
        sendBtn.disabled = true;
        if (isImage) {
          // Upload → then send as image message
          post({ action: "upload", shopId: shopId, visitorId: visitorId, imageData: dataUrl })
            .then(function () { return post({ action: "send", shopId: shopId, visitorId: visitorId, message: "", messageType: "image", imageData: dataUrl }); })
            .then(function (data) {
              hideTyping();
              sendBtn.disabled = false;
              if (data.duplicate) return;
              addMessage({ id: "img-" + Date.now(), role: "user", message: "(image)", media_url: dataUrl, created_at: new Date().toISOString() });
              if (data.reply) addMessage({ id: "bot-" + Date.now(), role: "bot", message: data.reply, created_at: data.replyCreatedAt || new Date().toISOString() });
            })
            .catch(function (err) { hideTyping(); sendBtn.disabled = false; addSystem(err.message); });
        } else {
          // Upload → then send as document message
          post({ action: "upload", shopId: shopId, visitorId: visitorId, kind: "document", fileData: dataUrl })
            .then(function () { return post({ action: "send", shopId: shopId, visitorId: visitorId, message: "", messageType: "document", fileData: dataUrl, filename: file.name }); })
            .then(function (data) {
              hideTyping();
              sendBtn.disabled = false;
              if (data.duplicate) return;
              addMessage({ id: "doc-" + Date.now(), role: "user", message: "(file)", file_name: file.name || "file", created_at: new Date().toISOString() });
              if (data.reply) addMessage({ id: "bot-" + Date.now(), role: "bot", message: data.reply, created_at: data.replyCreatedAt || new Date().toISOString() });
            })
            .catch(function (err) { hideTyping(); sendBtn.disabled = false; addSystem(err.message); });
        }
      };
      reader.readAsDataURL(file);
    });

    // Emoji panel
    var emojiBtn = $("cc-emoji-btn");
    var emojiPanel = $("cc-emoji");
    var EMOJIS = ["😀","😄","😊","🙂","😉","😍","🤔","😅","😢","😭","👍","👎","🙏","👌","💪","🎉","✅","❌","🔧","🛠️","📱","💧","❄️","🔥","⚡","🔌","🧊","🚿","🏠","💰","⏰","📅"];
    EMOJIS.forEach(function (e) {
      var b = document.createElement("button");
      b.textContent = e;
      b.type = "button";
      b.addEventListener("click", function () {
        inputEl.value += e;
        inputEl.focus();
        autoGrow();
      });
      emojiPanel.appendChild(b);
    });
    emojiBtn.addEventListener("click", function () { emojiPanel.classList.toggle("show"); });
    emojiPanel.addEventListener("click", function (e) { if (e.target === emojiPanel) emojiPanel.classList.remove("show"); });

    startPolling();
  }

  // ── Session / history ──────────────────────────────────────────────────────
  function startSession() {
    post({ action: "start", shopId: shopId, visitorId: visitorId, sandboxToken: (forceEnable ? (currentSandboxToken() || undefined) : undefined) })
      .then(function (data) {
        if (data.greeting) {
          addMessage({ id: "greet-" + Date.now(), role: "bot", message: data.greeting, created_at: new Date().toISOString() });
        }
        if (data.isOpen === false) {
          $("cc-status").classList.add("off");
          $("cc-status-text").textContent = T.offline;
        }
        loadHistory();
      })
      .catch(function (err) {
        addSystem(err.message || "Could not connect to chat.");
      });
  }

  function loadHistory() {
    // Fetch the last 50 bot messages so a returning visitor sees their history
    fetch(apiUrl("poll", { shopId: shopId, visitorId: visitorId, after: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString() }))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        (data.messages || []).forEach(function (m) { addMessage(m); });
      })
      .catch(function () { /* silent */ });
  }

  // ── Poll for new messages (e.g. human replies after handoff) ───────────────
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    var lastPoll = new Date().toISOString();
    pollTimer = setInterval(function () {
      fetch(apiUrl("poll", { shopId: shopId, visitorId: visitorId, after: lastPoll }))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var msgs = data.messages || [];
          if (msgs.length) {
            lastPoll = msgs[msgs.length - 1].created_at || lastPoll;
            msgs.forEach(function (m) { addMessage(m); });
          }
        })
        .catch(function () { /* silent */ });
    }, 4000);
  }

  // ── Boot on DOM ready ──────────────────────────────────────────────────────
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  ready(boot);

  // ── Public API ─────────────────────────────────────────────────────────────
  // Lets the host page (e.g. the CoolCare hosted website's "Book Service" CTA)
  // open the chat window programmatically.
  window.__coolcareWidget = {
    open: function () {
      if (!booted) return;
      open = true;
      setBubbleOpen(true);
      if (inputEl) inputEl.focus();
    },
  };
})();

# 🌐 CoolCare Website Live Chat (web-bot)

This folder groups every file that belongs to the **Website Chat** channel — the
second front-end into the same CoolCare AI engine that powers WhatsApp.

```
web-bot/
├── widget.js          ← The embeddable widget (Shadow DOM, no iframe). Served at /web-bot/widget.js
├── shop-widget.html   ← Shop-owner admin page: enable/disable, branding, embed-code generator
├── website-chat.sql   ← Idempotent DB migration (channel + source + customer_phone columns, widget_settings table)
├── WEBSITE-CHAT.md    ← Full architecture / API / security / deployment / testing docs
└── README.md          ← This file
```

## Install on any website

```html
<script src="https://coolcare.ai/web-bot/widget.js" data-shop-id="SHOP_ID"></script>
```

## Where the API lives

Vercel only deploys serverless functions from the `api/` directory, so the
public widget API intentionally stays there:

| File | Purpose |
|------|---------|
| `api/chat.js` | Public widget API: config / start / send / poll / upload (CORS, rate-limited, sanitized) |
| `api/_lib/conversation-engine.js` | **Shared** AI engine — used by BOTH WhatsApp and Website chat (do not move) |
| `api/_lib/rate-limit.js` | Adds `chatLimiter` (shared) |
| `api/_lib/demo-data.js` | Demo `buildDemoWidgetSettingsResponse` (shared) |
| `api/shop.js` | `widget-settings` GET/POST handlers + `source` on bookings (shared) |

## One engine, two frontends, one dashboard

- 💬 WhatsApp → `api/whatsapp.js` → shared engine
- 🌐 Website → `web-bot/widget.js` → `api/chat.js` → shared engine

Bookings from the widget are tagged `source = 'website'` and appear in the same
dashboard with a 🌐 badge — exactly like WhatsApp's 💬.

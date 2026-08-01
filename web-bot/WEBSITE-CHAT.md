# 🌐 CoolCare Website Live Chat

**The second communication channel for CoolCare AI.**

| Channel | Front-end | Back-end |
|---|---|---|
| 💬 WhatsApp | Meta Cloud API webhook | `api/whatsapp.js` |
| 🌐 Website | `widget.js` (embed on any site) | `api/chat.js` |

Both channels share **one AI engine** (`api/_lib/conversation-engine.js`), **one
database**, **one booking system** and **one dashboard**. The owner never cares
where a customer came from — every message and booking lands in the same place,
tagged with its source (🌐 Website / 💬 WhatsApp).

---

## 1. Architecture diagram

```
                          ┌─────────────────────────────────────────────┐
                          │              COOLCARE BACKEND               │
                          │                                             │
  💬 Customer on          │  api/whatsapp.js        api/chat.js        │   🌐 Customer on
  WhatsApp ──────────────▶│  (webhook front-end)    (widget API front) │◀──────────── repairshop.com
                          │        │                     │             │            (widget.js)
                          │        └─────────┬───────────┘             │
                          │                  ▼                         │
                          │     api/_lib/conversation-engine.js        │
                          │     ┌───────────────────────────────────┐  │
                          │     │  handleMessage() state machine    │  │
                          │     │  · booking flow (i18n en/hi/ta/ar)│  │
                          │     │  · technician auto-assignment     │  │
                          │     │  · human handoff                 │  │
                          │     │  · smart scheduling              │  │
                          │     │  · knowledge base                │  │
                          │     └───────────────────────────────────┘  │
                          │              │            │               │
                          │              ▼            ▼               │
                          │        ┌──────────────────────┐           │
                          │        │  Neon Postgres (one  │           │
                          │        │  database, one schema│           │
                          │        └──────────────────────┘           │
                          │              │                            │
                          │              ▼                            │
                          │        api/shop.js → ONE dashboard        │
                          │        (bookings, transcripts, KPIs,      │
                          │         notifications)                    │
                          └─────────────────────────────────────────────┘
```

**The one-engine rule:** `handleMessage(customerNumber, text, type, media, opts)`
is the ONLY place conversation logic exists. WhatsApp calls it with
`{ channel: "whatsapp" }`, the website widget calls it with
`{ channel: "website", shopId }`. Booking creation, technician assignment,
prompts and knowledge-base logic are never duplicated.

---

## 2. Database changes (`website-chat.sql`)

| Table | Change |
|---|---|
| `conversations` | `+ channel TEXT DEFAULT 'whatsapp'` (whatsapp \| website) |
| `conversation_state` | `+ channel TEXT DEFAULT 'whatsapp'` |
| `bookings` | `+ source TEXT DEFAULT 'whatsapp'` (whatsapp \| website) |
| `whatsapp_conversations` | `+ channel TEXT DEFAULT 'whatsapp'` (unified dashboard log) |
| `widget_settings` *(new)* | Per-shop branding: `enabled, business_name, welcome_message, offline_message, primary_color, widget_position, logo_url, theme, show_avatar` |

All statements are idempotent (`IF NOT EXISTS`). Run once in the Neon console:

```sql
\i website-chat.sql   -- or paste the file contents
```

---

## 3. API changes

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/chat?shopId=X` | none (CORS `*`) | Widget config: branding, colors, position, business hours, `enabled` |
| `GET /api/chat?action=poll&shopId&visitorId&after=` | none | Poll new bot messages (history / reconnect) |
| `POST /api/chat {action:"start"}` | none | Begin visitor session → welcome message |
| `POST /api/chat {action:"send"}` | none | Run shared engine, persist both sides, return reply |
| `POST /api/chat {action:"upload"}` | none | Sanitize image upload (MIME + magic bytes + 2 MB cap) |
| `GET /api/shop?action=widget-settings` | JWT shop | Read widget settings + generated embed code |
| `POST /api/shop {action:"save-widget-settings"}` | JWT shop | Save branding / enable-disable |
| `GET /api/shop` | JWT shop | Dashboard now returns `source` on every booking |
| `GET /api/shop?action=conversation-transcript` | JWT shop | Messages now include `channel` |

WhatsApp endpoints are **unchanged** — `api/whatsapp.js` now just imports the
shared engine instead of containing it.

---

## 4. Frontend changes

| File | Change |
|---|---|
| `web-bot/shop-widget.html` *(new)* | Admin page: enable/disable, branding, color, position, logo, theme, welcome/offline messages, embed-code generator with copy button |
| `shop-dashboard.html` | Booking cards show source badge (🌐 / 💬); nav link to Website Chat |
| `shop-settings.html`, `shop-ai-settings.html` | Nav link to Website Chat |
| `web-bot/widget.js` *(new)* | The embeddable widget (see §5) — served at `/web-bot/widget.js` |

> 📁 All website-chat feature files live in the `web-bot/` folder:
> `widget.js`, `shop-widget.html`, `website-chat.sql`, `WEBSITE-CHAT.md`, `README.md`.
> The public API (`api/chat.js`) stays in `api/` because Vercel only deploys
> serverless functions from that directory. See `web-bot/README.md`.

No second dashboard was created — website bookings appear in the same
dashboard, pipeline filters, CSV export, KPIs and notifications as WhatsApp.

---

## 5. Widget structure

`widget.js` is a single self-contained IIFE (~700 lines, zero dependencies).

```
widget.js
├── Boot (read data-shop-id, data-api, overrides; guard double-include)
├── i18n chrome strings (en / hi / ar) — conversation itself is AI-multilingual
├── Visitor identity → localStorage visitorId (web_<uuid>), survives refresh
├── Shadow DOM injection (no iframe — CSS/JS can never clash with host site)
│   ├── Floating bubble (position from config) + unread count + pulse ring
│   ├── Chat window (390px / full-screen on mobile)
│   │   ├── Header: logo, business name, live/offline status, reset
│   │   ├── Offline banner (business hours aware)
│   │   ├── Messages: bubbles, avatars, timestamps, ticks (✓ / ✓✓ seen)
│   │   ├── Typing indicator (animated 3-dot)
│   │   ├── Image attach + emoji panel + auto-growing input
│   │   └── Send button
├── Polling (4s) for bot replies / human replies after handoff
├── Business hours: server returns isOpen; offline banner + offline message
└── Human handoff: engine-side, widget shows transfer notice
```

Install snippet (one line, nothing else):

```html
<script src="https://coolcare.ai/web-bot/widget.js" data-shop-id="SHOP_ID"></script>
```

---

## 6. Installation process

1. Shop owner logs into the dashboard → **Website Chat**.
2. Fills in branding (name, logo URL, primary color, position, welcome &
   offline messages, theme), toggles **Enable**, hits Save.
3. Copies the generated one-line embed code.
4. Pastes it before `</body>` on their site (or the site builder's custom-code
   footer field), publishes.
5. Floating chat button appears automatically. No backend access required.

For a dedicated domain, point a subdomain (e.g. `widget.coolcare.ai`) at the
same Vercel deployment and use `https://widget.coolcare.ai/web-bot/widget.js` — the
widget resolves its API base from its own script URL automatically.

---

## 7. Security review

| Threat | Mitigation |
|---|---|
| Unauthorized access | shopId validated against `repair_shops` (active, not suspended, subscription active); widget `enabled` gate |
| Abuse / spam | `chatLimiter` 40 req/min/IP + visitor-id format check (`web_[A-Za-z0-9-]{8,64}`) |
| Prompt injection | Engine system prompts now instruct the model to ignore role-changing / rule-revealing instructions; user text treated as data in extraction prompts |
| Malicious uploads | Allowlist MIME (JPEG/PNG/WebP/GIF) **+ magic-byte verification**, 2 MB cap, base64-only |
| XSS | Widget renders through Shadow DOM + `esc()` for all text; messages stored/rendered as text, never raw HTML |
| CSRF / CORS | Widget API is CORS `*` by design (public); all write paths rate-limited; dashboard/admin APIs remain JWT-gated |
| Data leakage | `conversation-transcript` still scoped to `repair_shop_id`; visitor sessions are namespaced per shop |
| DoS on polling | Poll is read-only, rate-limited, returns ≤50 rows, `after`-timestamp based |

---

## 8. Deployment plan

1. **Migrate DB** — run `website-chat.sql` in Neon.
2. **Deploy backend** — push `api/chat.js`, updated `api/shop.js`,
   `api/_lib/conversation-engine.js`, rewritten `api/whatsapp.js`, updated
   `rate-limit.js`, `demo-data.js` to Vercel.
3. **Deploy static** — `web-bot/widget.js`, `web-bot/shop-widget.html` are
   served as static files automatically (`vercel.json` rewrites keep the old
   `/widget.js` and `/shop-widget.html` URLs working for backward compat).
4. **Verify WhatsApp regression** — send a WhatsApp message; the booking flow,
   handoff, and i18n must behave exactly as before (same engine, same DB).
5. **Verify widget** — open a shop with widget enabled; run a full booking flow
   from the widget; confirm the booking appears in the dashboard with 🌐 badge
   and a technician is auto-assigned.
6. Optional: point `widget.coolcare.ai` subdomain at the deployment.
7. Update `DEPLOYMENT-CHECKLIST.md` if desired.

---

## 9. Testing checklist

**Widget**
- [ ] Bubble appears bottom-right (and bottom-left when configured)
- [ ] No CSS/JS clash with a host page (Shadow DOM)
- [ ] Dark/light theme follows visitor preference
- [ ] Typing indicator shows while AI replies
- [ ] ✓ / ✓✓ seen ticks update
- [ ] Image upload works; SVG/oversize rejected
- [ ] Emoji insert + send
- [ ] Timestamps render
- [ ] Reload page → conversation history restored (same visitorId)
- [ ] Reset button starts a fresh session

**Business hours**
- [ ] Outside hours → offline banner + offline message shown
- [ ] Booking still created outside hours; technician still assigned

**Dashboard (one dashboard, two channels)**
- [ ] Website booking appears with 🌐 badge; WhatsApp with 💬
- [ ] Filters, search, CSV, KPIs count both channels
- [ ] Transcript shows `channel` per message
- [ ] Shop notification fires on first website message

**Regression (WhatsApp)**
- [ ] Full booking flow via WhatsApp still works (state machine)
- [ ] Human handoff still works
- [ ] Image/document handling unchanged

**Security**
- [ ] Invalid shopId → 404/403, no data leaked
- [ ] Widget disabled → config `enabled:false`, widget hides itself
- [ ] Rate limit triggers 429 after 40 req/min
- [ ] Malformed visitorId rejected
- [ ] Prompt-injection attempt yields a safe, non-revealing answer

---

## 10. Implementation summary

- **`api/_lib/conversation-engine.js`** — extracted the single AI engine from
  `whatsapp.js`, made it channel-aware (`channel`, `shopId` opts, `source` on
  bookings, `channel` on messages) and hardened prompts against injection.
- **`api/whatsapp.js`** — now a thin webhook wrapper importing the engine.
- **`api/chat.js`** — public widget API (config/start/send/poll/upload) with
  CORS, rate limiting, shop validation, sanitized uploads.
- **`api/shop.js`** — widget-settings GET/POST, `source` on dashboard bookings,
  `channel` on transcripts, demo support.
- **`web-bot/widget.js`** — premium Shadow-DOM widget (branding, i18n, uploads,
  typing, seen status, business hours, history, handoff).
- **`web-bot/shop-widget.html`** — admin page with embed-code generator.
- **`shop-dashboard.html`** — source badges + nav link.
- **`web-bot/website-chat.sql`** — idempotent migration.

All of the above (except `api/chat.js`, which Vercel requires in `api/`) are
consolidated in the `web-bot/` folder.

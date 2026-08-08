# CoolCare Deployment Checklist

## ✅ Changes Already Pushed to GitHub
All code is committed and pushed to `origin/main` (commit `37f58ec`):
- ✓ Fixed `api/dashboard.js` (removed `b.address`)
- ✓ Created repair shop auth system (signup, login, logout)
- ✓ Created shop dashboard & booking management
- ✓ Added WhatsApp status notifications
- ✓ Updated `package.json` with bcryptjs & jsonwebtoken

---

## 🚨 Critical: Database Migration Required

**You must run the migration SQL in your Neon database console** before the new features will work.

### Steps:
1. Log in to https://console.neon.tech
2. Open your CoolCare project database
3. Go to SQL Editor
4. Copy and paste the entire contents of `migration-combined.sql`
5. Click **Run**

The migration:
- Creates the `repair_shops` table
- Adds `repair_shop_id` FK to `bookings`
- Adds new job status values (accepted, rejected, on_the_way, arrived)
- Adds technician_name, technician_notes, estimated_cost, final_cost columns to bookings
- Creates `jwt_denylist` table for logout
- Re-adds `address` column to bookings (if missing)

**All statements use `IF NOT EXISTS` / `IF EXISTS` — safe to re-run.**

---

## 🔑 Environment Variables Required

Add these to your Vercel project settings:

| Variable | Value | Status |
|---|---|---|
| `DATABASE_URL` | `postgresql://...` | ✓ Already set |
| `WHATSAPP_ACCESS_TOKEN` | Meta Business token | ✓ Already set |
| `WHATSAPP_PHONE_NUMBER_ID` | from Meta dashboard | ✓ Already set |
| `WHATSAPP_API_VERSION` | `v19.0` (optional, defaults) | ⚠ Check |
| `JWT_SECRET` | Random 32+ char string | ❌ **MUST ADD** |
| `APP_URL` | `https://coolcare.zeeshstudios.in` | ⚠ Check — base URL for app pages (dashboard, tracker, emails) |
| `PUBLIC_WEBSITE_BASE_URL` | `https://coolcare.zeeshstudios.in` | ⚠ Check — base URL for hosted shop websites (`/<slug>` links) |
| `META_APP_ID` | from Meta App Dashboard | ❌ **MUST ADD** — Meta app ID (`1591428492345883`) |
| `META_APP_SECRET` | from Meta App Dashboard → App settings → Basic | ❌ **MUST ADD** |
| `META_API_VERSION` | `v25.0` (optional, defaults) | ⚠ Check |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | from Meta App Dashboard → Facebook Login for Business → Configurations | ❌ **MUST ADD** — see WhatsApp Embedded Signup section below |
| `META_WEBHOOK_VERIFY_TOKEN` | your own random string | ❌ **MUST ADD** — must match the verify token in the Meta webhook config |
| `GATEWAY_ENCRYPT_KEY` | 64-char hex (32 bytes) | ❌ **MUST ADD in production** — AES key for encrypting per-shop WhatsApp access tokens |

---

## 📲 WhatsApp Embedded Signup (per-shop WhatsApp) — Meta setup

Each shop connects **its own** WhatsApp Business number through the dashboard. This uses Meta **Embedded Signup v4** (JavaScript SDK flow — the legacy `dialog/embedded_signup` URL flow is deprecated and returns “Not Found”).

### 1. Meta App Dashboard configuration

1. Open your Meta app (App ID `1591428492345883`) at https://developers.facebook.com/apps
2. **Facebook Login for Business → Settings → Client OAuth settings** — set all of these to **Yes**:
   - Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, **use Strict Mode for redirect URIs**, **Login with the JavaScript SDK**
   - Add your app domain to **Allowed domains for JavaScript SDK** — e.g. `coolcare.zeeshstudios.in` (and `localhost` for local dev — note only HTTPS domains are officially supported)
   - Add the same domains to **Valid OAuth redirect URIs** (Embedded Signup returns the code only to windows spawned from a listed domain)
3. **Facebook Login for Business → Configurations → Create from template → “WhatsApp Embedded Signup Configuration With 60 Expiration Token”**
   - Select the **Cloud API** product (adds `whatsapp_business_management` + `whatsapp_business_messaging` with advanced access)
   - Copy the **configuration ID** → set it as `META_EMBEDDED_SIGNUP_CONFIG_ID`
4. **WhatsApp → Configuration** — set the **Callback URL** to `https://coolcare.zeeshstudios.in/api/whatsapp` and **Verify token** to your `META_WEBHOOK_VERIFY_TOKEN`, then click **Verify and save**
5. Ensure your app has advanced access for `whatsapp_business_messaging` / `whatsapp_business_management` (App Review), and that Business Verification is complete

### 2. Required environment variables

| Variable | Value |
|---|---|
| `META_APP_ID` | your Meta app ID |
| `META_APP_SECRET` | Meta app secret (server-side only — never in the browser) |
| `META_API_VERSION` | `v25.0` (or your latest) |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | configuration ID from step 3 above — **no signup flow runs without it** |
| `META_WEBHOOK_VERIFY_TOKEN` | random string, must match the Meta webhook config |
| `GATEWAY_ENCRYPT_KEY` | 64-char hex — encrypts each shop's access token at rest |

### 3. Flow (what happens after a shop clicks “Connect WhatsApp”)

1. Dashboard → `POST /api/whatsapp-connect` (`initiate`) → returns `appId`, `configId`, `apiVersion`
2. Browser loads `connect.facebook.net/en_US/sdk.js` and calls `FB.login(...)` with the config ID
3. Shopkeeper logs into Meta, picks their business / WABA / phone number
4. Meta posts `phone_number_id`, `waba_id`, `business_id` to the dashboard window (`WA_EMBEDDED_SIGNUP` message event) and returns an exchangeable code (30s TTL)
5. Dashboard → `POST /api/whatsapp-connect` (`complete`) with the code + IDs — **server-side only**: the code is exchanged for a business token, the WABA and phone are subscribed to webhooks, the number is registered for Cloud API, and everything is stored against **that shop's** `repair_shop_whatsapp` row (encrypted token)
6. Incoming messages arrive at `/api/whatsapp`, are mapped to the correct shop by `phone_number_id`, and are answered by the shared AI engine using the shop's own credentials

### 4. Test with a real shopkeeper account

1. Create a normal shop account (not demo) → open **Communication Channels** (`/shop-channels.html`)
2. Click **Connect WhatsApp** → the Meta window opens (you must be logged into Meta as the shopkeeper)
3. Complete the flow, choose a business phone number, then return to the dashboard
4. The card should show **Connected**, the business number, WABA ID and webhook status
5. Message the shop's number from another phone — the AI should reply, and the conversation should appear in that shop's dashboard
6. Repeat with a second shop account — each shop must show **its own** number/WABA, never another shop's

### Generate JWT_SECRET:
Run one of these commands locally:

**PowerShell:**
```powershell
-join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object {[char]$_})
```

**Node.js (if installed):**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then add it to Vercel:
1. Go to https://vercel.com/your-project/settings/environment-variables
2. Add `JWT_SECRET` = the generated random string
3. Click Save
4. **Redeploy** (Vercel → Deployments → click "..." on latest → Redeploy)

---

## 🧪 Test the Fix

### Test 1: Repair Shop Signup
1. Go to `/shop-signup.html`
2. Fill out the form
3. Click "Create Account"
4. **Expected:** redirects to `/shop-dashboard.html` with your shop's bookings
5. **If it fails:** check browser console for errors, and Vercel logs for backend errors

### Test 2: Repair Shop Login
1. Go to `/shop-login.html`
2. Log in with the email/mobile + password you just created
3. **Expected:** redirects to `/shop-dashboard.html`

### Test 3: Job Management
1. In the shop dashboard, click any booking
2. Click "Accept Booking"
3. **Expected:** status changes to "Accepted" and customer receives WhatsApp notification

---

## 🐛 If Something Doesn't Work

### Signup fails with "Registration failed"
**Cause:** `JWT_SECRET` env var is not set, or migration wasn't run.

**Fix:**
1. Add `JWT_SECRET` to Vercel env vars
2. Run the migration SQL in Neon
3. Redeploy on Vercel

### Dashboard still shows SQL error
**Cause:** Vercel hasn't redeployed, or cached old code.

**Fix:**
1. Go to Vercel → Deployments tab
2. Find the latest deployment
3. Click "..." → **Redeploy**

### WhatsApp notifications not sending
**Cause:** Missing `WHATSAPP_ACCESS_TOKEN` or `WHATSAPP_PHONE_NUMBER_ID`.

**Fix:**
1. Check Vercel env vars are set correctly
2. Check Vercel function logs for `[notify]` errors
3. Verify Meta Business token is still valid

---

## 📂 New Files Reference

### API Files
- `api/_lib/auth.js` — JWT middleware
- `api/_lib/notify.js` — WhatsApp status notifications
- `api/auth/signup.js` — Shop registration
- `api/auth/login.js` — Shop login
- `api/auth/logout.js` — JWT denylist logout
- `api/shop/dashboard.js` — Protected shop dashboard data
- `api/shop/bookings/update.js` — Job status updates + WhatsApp notify

### HTML Pages
- `shop-signup.html` — Registration form
- `shop-login.html` — Login form
- `shop-dashboard.html` — Shop dashboard
- `shop-booking.html` — Booking detail & job management

### Database
- `migration-combined.sql` — The single merged schema/migration file. Run this in Neon SQL console. All statements are idempotent — safe to re-run.

---

## ✅ Completion Verification

Once everything is deployed:

- [ ] Run `migration-combined.sql` in Neon
- [ ] Add `JWT_SECRET` to Vercel
- [ ] Redeploy on Vercel
- [ ] Test shop signup works
- [ ] Test shop login works
- [ ] Test job status update sends WhatsApp notification
- [ ] Test the repair lifecycle: Pending Assignment → Assigned → On The Way → Arrived → In Progress → Completed (timeline events + customer notifications)
- [ ] Test the Technician Dashboard (`/tech-dashboard.html`) — technician login shows active jobs and status buttons

---

**If you've done all of the above and still see "no change," check:**
1. Are you looking at the correct Vercel project? (check the domain)
2. Did the Vercel deployment succeed? (check Deployments tab for errors)
3. Did you clear your browser cache? (hard refresh with Ctrl+Shift+R)

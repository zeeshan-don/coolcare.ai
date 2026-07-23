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
4. Copy and paste the entire contents of `migration-repair-shop-auth.sql`
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
- `migration-repair-shop-auth.sql` — Run this in Neon SQL console

---

## ✅ Completion Verification

Once everything is deployed:

- [ ] Run `migration-repair-shop-auth.sql` in Neon
- [ ] Add `JWT_SECRET` to Vercel
- [ ] Redeploy on Vercel
- [ ] Test shop signup works
- [ ] Test shop login works
- [ ] Test job status update sends WhatsApp notification

---

**If you've done all of the above and still see "no change," check:**
1. Are you looking at the correct Vercel project? (check the domain)
2. Did the Vercel deployment succeed? (check Deployments tab for errors)
3. Did you clear your browser cache? (hard refresh with Ctrl+Shift+R)

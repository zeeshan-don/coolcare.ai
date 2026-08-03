// api/auth.js
// Unified auth endpoint — login, signup, logout, bootstrap, me, forgot-password, reset-password.
// POST /api/auth  body: { action: "login"|"signup"|"logout"|"bootstrap"|"bootstrap-check"|"me"|"forgot-password"|"reset-password", ... }
// Security: rate-limited, Zod-validated, security headers, error-wrapped.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");
const { signToken, makeJti, requireAuth } = require("./_lib/auth");
const { withErrorHandler, allowMethods } = require("./_lib/errors");
const { validate, loginSchema, signupSchema, bootstrapSchema, forgotPasswordSchema, resetPasswordTokenSchema } = require("./_lib/validate");
const { loginLimiter, signupLimiter, apiLimiter, applyLimit } = require("./_lib/rate-limit");
const { setSecurityHeaders, htmlEscape } = require("./_lib/security");
const { sendEmail } = require("./_lib/notify");
const { createOrder, calculateAmount } = require("./_lib/gateway");
const { detectCountry, getCountryCurrency, getCountryName, CURRENCIES } = require("./_lib/currency");
const { DEMO, ago, isCacheValid, invalidateDemoCache, perfMark, perfReport } = require("./_lib/demo-data");

// ─── Demo password (never exposed to client) ────────────────────────────────
// This is a fixed, hardcoded password used ONLY for the demo account.
// It is never shown in the frontend.
const DEMO_PASSWORD = "DemoCoolCare2024!";

// ─── Helper: check if a shop is the demo shop ───────────────────────────────
async function isDemoShop(sql, shopId) {
  try {
    const rows = await sql`SELECT id, is_demo FROM repair_shops WHERE id = ${shopId} AND is_demo = true LIMIT 1`;
    return rows.length > 0;
  } catch (e) {
    return false;
  }
}

// Generate unique referral code: COOLCARE-XXXX
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return 'COOLCARE-' + code;
}

// Generate a shop's hosted-website URL slug from its name (lowercase, kebab)
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

module.exports = withErrorHandler(async (request, response) => {
  setSecurityHeaders(response);
  if (!allowMethods(request, response, "POST")) return;

  const body = request.body || {};
  const action = body.action;

  if (action === "login") return handleLogin(request, response, body);
  if (action === "signup") return handleSignup(request, response, body);
  if (action === "logout") return handleLogout(request, response);
  if (action === "bootstrap") return handleBootstrap(request, response, body);
  if (action === "bootstrap-check") return handleBootstrapCheck(request, response);
  if (action === "me") return handleMe(request, response);
  if (action === "forgot-password") return handleForgotPassword(request, response, body);
  if (action === "reset-password") return handleResetPassword(request, response, body);
  if (action === "demo-login") return handleDemoLogin(request, response);
  if (action === "demo-preload") return handleDemoPreload(request, response);

  return response.status(400).json({ error: "Invalid action. Use: login, signup, logout, bootstrap, bootstrap-check, me, forgot-password, reset-password, demo-login, demo-preload" });
});

// ─── LOGIN (unified — checks users table first, then repair_shops) ───────────
async function handleLogin(request, response, body) {
  if (!applyLimit(request, response, loginLimiter)) return;

  const data = validate({ ...request, body }, response, loginSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);
  const id = data.identifier.toLowerCase();
  const mobileClean = data.identifier.replace(/\s/g, "");

  const dummyHash = "$2a$12$invalidhashfortimingnormalization000000000000000000000000";

  // 1. Check users table first (platform staff + shop employees)
  let userRows = [];
  try {
    userRows = await sql`
      SELECT id, email, name, password_hash, role, repair_shop_id, is_active
      FROM users WHERE email = ${id} LIMIT 1
    `;
  } catch (e) { /* users table may not exist yet */ }

  if (userRows.length > 0) {
    const user = userRows[0];
    const passwordOk = await bcrypt.compare(data.password, user.password_hash);
    if (!passwordOk) return response.status(401).json({ error: "Invalid credentials" });
    if (!user.is_active) return response.status(403).json({ error: "This account has been disabled." });

    // Update last_login
    sql`UPDATE users SET last_login = now() WHERE id = ${user.id}`.catch(() => {});

    const jti = makeJti();
    const token = signToken({
      sub: user.id,
      role: user.role,
      user_type: "user",
      repair_shop_id: user.repair_shop_id || null,
    }, jti);

    console.log("[auth/login] user:", user.email, "role:", user.role);
    return response.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        userType: "user",
        repairShopId: user.repair_shop_id || null,
      },
    });
  }

  // Timing normalization: if no user found, still do a bcrypt compare
  // so attackers can't distinguish "email exists" from "email doesn't exist"
  if (userRows.length === 0) {
    await bcrypt.compare(data.password, dummyHash);
  }

  // 2. Check repair_shops table (shop owners, backward compat)
  const shopRows = await sql`
    SELECT id, shop_name, owner_name, email, mobile, password_hash, is_active, role, suspended_at
    FROM repair_shops
    WHERE email = ${id} OR mobile = ${mobileClean}
    LIMIT 1
  `;

  const shop = shopRows[0] || null;
  const hashToCheck = shop ? shop.password_hash : dummyHash;
  const passwordOk = await bcrypt.compare(data.password, hashToCheck);

  if (!shop || !passwordOk) {
    return response.status(401).json({ error: "Invalid credentials" });
  }
  if (!shop.is_active) {
    return response.status(403).json({ error: "This account has been deactivated." });
  }
  if (shop.suspended_at) {
    return response.status(403).json({ error: "This account has been suspended." });
  }

  const jti = makeJti();
  const token = signToken({
    sub: shop.id,
    role: shop.role || "owner",
    user_type: "shop",
    repair_shop_id: shop.id,
  }, jti);

  console.log("[auth/login] shop:", shop.email, "role:", shop.role || "owner");
  return response.status(200).json({
    token,
    user: {
      id: shop.id,
      name: shop.owner_name,
      shopName: shop.shop_name,
      email: shop.email,
      mobile: shop.mobile,
      role: shop.role || "owner",
      userType: "shop",
      repairShopId: shop.id,
    },
  });
}

// ─── SIGNUP (shop registration — creates repair_shop with role='owner') ──────
// Paid plans ONLY: every signup creates a Razorpay order.
// No free trial is ever activated. Accounts remain 'inactive' until payment + admin approval.
async function handleSignup(request, response, body) {
  if (!applyLimit(request, response, signupLimiter)) return;

  const data = validate({ ...request, body }, response, signupSchema);
  if (!data) return;

  console.log("[auth/signup] Received plan data:", {
    planName: data.planName,
    billingCycle: data.billingCycle,
    currency: data.currency,
  });

  const sql = neon(process.env.DATABASE_URL);
  const existing = await sql`
    SELECT id FROM repair_shops
    WHERE email = ${data.email} OR mobile = ${data.mobile}
    LIMIT 1
  `;
  if (existing.length > 0) {
    return response.status(409).json({ error: "An account with this email or mobile already exists" });
  }

  // Also check users table
  try {
    const existingUser = await sql`SELECT id FROM users WHERE email = ${data.email} LIMIT 1`;
    if (existingUser.length > 0) {
      return response.status(409).json({ error: "An account with this email already exists" });
    }
  } catch (e) { /* table may not exist */ }

  const passwordHash = await bcrypt.hash(data.password, 12);
  const safeServiceAreas = Array.isArray(data.serviceAreas) ? data.serviceAreas : [];
  const safeServicesOffered = Array.isArray(data.servicesOffered) ? data.servicesOffered : [];

  // Generate unique referral code
  let referralCode = generateReferralCode();
  try {
    const existing = await sql`SELECT id FROM repair_shops WHERE referral_code = ${referralCode} LIMIT 1`;
    if (existing.length > 0) referralCode = generateReferralCode(); // retry once
  } catch (e) { /* column may not exist yet */ }

  // ── Website slug (hosted website URL path) — unique per shop ────────────
  let slug = slugify(data.shopName) || "shop";
  try {
    let slugBase = slug;
    let i = 2;
    while ((await sql`SELECT 1 FROM repair_shops WHERE slug = ${slug} LIMIT 1`).length > 0) {
      slug = slugBase + "-" + i++;
    }
  } catch (e) { /* column may not exist yet */ }

  // Check for referral code in signup data
  let referredBy = null;
  if (body.referralCode) {
    try {
      const referrer = await sql`SELECT id FROM repair_shops WHERE referral_code = ${body.referralCode.toUpperCase()} LIMIT 1`;
      if (referrer.length > 0) referredBy = body.referralCode.toUpperCase();
    } catch (e) { /* ok */ }
  }

  // ── Detect country and determine currency ────────────────────────────────
  // From request: check selectedCountry from frontend, otherwise detect from IP
  let selectedCountry = data.selectedCountry || null;
  if (!selectedCountry) {
    selectedCountry = detectCountry(request);
  }
  const planName = data.planName || 'pro';
  const billingCycle = data.billingCycle || 'monthly';
  const currency = selectedCountry
    ? getCountryCurrency(selectedCountry)
    : (data.currency || 'USD').toUpperCase();

  console.log("[auth/signup] Decision path:", {
    planName,
    billingCycle,
    currency,
    selectedCountry,
    reason: 'PAID_PLAN_ONLY — creating payment order (no free trial)',
  });

  const rows = await sql`
    INSERT INTO repair_shops
      (shop_name, owner_name, email, mobile, password_hash,
       address, city, service_areas, services_offered, role,
       subscription_status, referral_code, referred_by,
       selected_country, selected_currency, slug, website_enabled)
    VALUES
      (${data.shopName}, ${data.ownerName}, ${data.email}, ${data.mobile}, ${passwordHash},
       ${data.address || null}, ${data.city}, ${safeServiceAreas}, ${safeServicesOffered}, 'owner',
       'inactive', ${referralCode}, ${referredBy},
       ${selectedCountry}, ${currency}, ${slug}, false)
    RETURNING id, shop_name, owner_name, email, mobile, city, created_at
  `;
  const shop = rows[0];
  console.log("[auth/signup] Shop created:", { id: shop.id, email: shop.email, subscriptionStatus: 'inactive' });

  // Create referral record if referred
  if (referredBy) {
    try {
      const referrer = await sql`SELECT id FROM repair_shops WHERE referral_code = ${referredBy} LIMIT 1`;
      if (referrer.length > 0) {
        await sql`
          INSERT INTO referrals (referrer_shop_id, referred_shop_id, referral_code, status)
          VALUES (${referrer[0].id}, ${shop.id}, ${referredBy}, 'pending')
        `;
      }
    } catch (e) { console.warn("[auth/signup] Referral record creation failed:", e.message); }
  }

  // ── Check for promo code (support token, discount, free trial, lifetime) ─
  const promoCode = body.promoCode || data.promoCode || null;
  let appliedPromo = null;
  
  if (promoCode) {
    const codeHash = crypto.createHash('sha256').update(promoCode.toUpperCase()).digest('hex');
    try {
      const promos = await sql`
        SELECT * FROM promotion_codes
        WHERE (code = ${promoCode.toUpperCase()} OR code_hash = ${codeHash})
          AND is_active = true
          AND (valid_until IS NULL OR valid_until >= now())
          AND (max_uses IS NULL OR used_count < max_uses)
        LIMIT 1
      `;
      if (promos.length > 0) {
        appliedPromo = promos[0];
      }
    } catch (e) { /* table may not exist */ }
  }

  // ── SUPPORT TOKEN FLOW: Skip Razorpay, activate immediately ────────────
  if (appliedPromo && appliedPromo.type === 'support_token') {
    try {
      await sql`BEGIN`;
      
      // Update shop to active
      await sql`
        UPDATE repair_shops
        SET subscription_status = 'active', approval_status = 'approved',
            is_active = true, updated_at = now()
        WHERE id = ${shop.id}
      `;
      
      // Create subscription (10 years)
      const planId = 1;
      const subEnd = new Date();
      subEnd.setFullYear(subEnd.getFullYear() + 10);
      
      const sub = await sql`
        INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway,
          amount_paid, currency, is_support_token, promotion_code_id,
          current_period_start, current_period_end, created_at)
        VALUES (${shop.id}, ${planId}, 'active', ${billingCycle || 'yearly'}, 'promo_code',
          0, ${currency}, true, ${appliedPromo.id},
          now(), ${subEnd.toISOString()}, now())
        RETURNING id
      `;
      
      // Increment used count
      await sql`UPDATE promotion_codes SET used_count = used_count + 1, updated_at = now() WHERE id = ${appliedPromo.id}`;
      
      // Record redemption
      await sql`
        INSERT INTO promo_code_redemptions (promotion_code_id, repair_shop_id, email, ip_address, user_agent,
          plan_name, billing_cycle, original_amount, discount_amount, final_amount, currency,
          subscription_id, status)
        VALUES (${appliedPromo.id}, ${shop.id}, ${shop.email},
          ${request.headers['x-forwarded-for']?.split(',')[0] || request.headers['x-real-ip'] || null},
          ${request.headers['user-agent'] || null},
          ${planName}, ${billingCycle}, 0, 0, 0, ${currency},
          ${sub[0].id}, 'active')
      `;
      
      await sql`COMMIT`;
      
      // Issue JWT token (user can log in immediately)
      const jti = makeJti();
      const token = signToken({
        sub: shop.id,
        role: 'owner',
        user_type: 'shop',
        repair_shop_id: shop.id,
      }, jti);
      
      console.log('[auth/signup] Support token activated for shop #' + shop.id);
      return response.status(201).json({
        token,
        user: {
          id: shop.id, name: shop.owner_name, shopName: shop.shop_name,
          email: shop.email, mobile: shop.mobile,
          role: 'owner', userType: 'shop', repairShopId: shop.id,
        },
        activationType: 'support_token',
        message: 'Support token activated! Your subscription is active.',
        subscriptionRequired: false,
      });
    } catch (err) {
      await sql`ROLLBACK`.catch(() => {});
      console.error('[auth/signup] Support token activation failed:', err.message);
      return response.status(201).json({
        shopId: shop.id,
        checkoutRequired: false,
        checkoutError: 'Support token activation failed: ' + err.message,
      });
    }
  }

  // ── FREE TRIAL FLOW ────────────────────────────────────────────────────
  if (appliedPromo && appliedPromo.type === 'free_trial') {
    try {
      await sql`BEGIN`;
      
      const trialDays = appliedPromo.free_trial_days || 14;
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + trialDays);
      const planId = 1;
      
      await sql`
        UPDATE repair_shops
        SET subscription_status = 'trial', updated_at = now()
        WHERE id = ${shop.id}
      `;
      
      const sub = await sql`
        INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway,
          amount_paid, currency, promotion_code_id,
          current_period_start, current_period_end, trial_end, created_at)
        VALUES (${shop.id}, ${planId}, 'trial', ${billingCycle || 'monthly'}, 'promo_code',
          0, ${currency}, ${appliedPromo.id},
          now(), ${trialEnd.toISOString()}, ${trialEnd.toISOString()}, now())
        RETURNING id
      `;
      
      await sql`UPDATE promotion_codes SET used_count = used_count + 1 WHERE id = ${appliedPromo.id}`;
      await sql`
        INSERT INTO promo_code_redemptions (promotion_code_id, repair_shop_id, email, ip_address, user_agent,
          plan_name, billing_cycle, original_amount, discount_amount, final_amount, currency,
          subscription_id, status)
        VALUES (${appliedPromo.id}, ${shop.id}, ${shop.email},
          ${request.headers['x-forwarded-for']?.split(',')[0] || request.headers['x-real-ip'] || null},
          ${request.headers['user-agent'] || null},
          ${planName}, ${billingCycle}, 0, 0, 0, ${currency},
          ${sub[0].id}, 'active')
      `;
      
      await sql`COMMIT`;
      
      const jti = makeJti();
      const token = signToken({
        sub: shop.id, role: 'owner', user_type: 'shop', repair_shop_id: shop.id,
      }, jti);
      
      console.log('[auth/signup] Free trial activated for shop #' + shop.id);
      return response.status(201).json({
        token,
        user: {
          id: shop.id, name: shop.owner_name, shopName: shop.shop_name,
          email: shop.email, mobile: shop.mobile,
          role: 'owner', userType: 'shop', repairShopId: shop.id,
        },
        activationType: 'free_trial',
        freeTrialDays: trialDays,
        message: 'Free trial activated! You have ' + trialDays + ' days to try CoolCare Pro.',
        subscriptionRequired: false,
      });
    } catch (err) {
      await sql`ROLLBACK`.catch(() => {});
      console.error('[auth/signup] Free trial activation failed:', err.message);
    }
  }

  // ── LIFETIME ACCESS FLOW ───────────────────────────────────────────────
  if (appliedPromo && appliedPromo.type === 'lifetime_access') {
    try {
      await sql`BEGIN`;
      
      const planId = 1;
      const farFuture = new Date('2099-12-31');
      
      await sql`
        UPDATE repair_shops
        SET subscription_status = 'active', approval_status = 'approved',
            is_active = true, updated_at = now()
        WHERE id = ${shop.id}
      `;
      
      const sub = await sql`
        INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway,
          amount_paid, currency, is_lifetime, promotion_code_id,
          current_period_start, current_period_end, created_at)
        VALUES (${shop.id}, ${planId}, 'active', 'lifetime', 'promo_code',
          0, ${currency}, true, ${appliedPromo.id},
          now(), ${farFuture.toISOString()}, now())
        RETURNING id
      `;
      
      await sql`UPDATE promotion_codes SET used_count = used_count + 1 WHERE id = ${appliedPromo.id}`;
      await sql`
        INSERT INTO promo_code_redemptions (promotion_code_id, repair_shop_id, email, ip_address, user_agent,
          plan_name, billing_cycle, original_amount, discount_amount, final_amount, currency,
          subscription_id, status)
        VALUES (${appliedPromo.id}, ${shop.id}, ${shop.email},
          ${request.headers['x-forwarded-for']?.split(',')[0] || request.headers['x-real-ip'] || null},
          ${request.headers['user-agent'] || null},
          ${planName}, 'lifetime', 0, 0, 0, ${currency},
          ${sub[0].id}, 'active')
      `;
      
      await sql`COMMIT`;
      
      const jti = makeJti();
      const token = signToken({
        sub: shop.id, role: 'owner', user_type: 'shop', repair_shop_id: shop.id,
      }, jti);
      
      console.log('[auth/signup] Lifetime access activated for shop #' + shop.id);
      return response.status(201).json({
        token,
        user: {
          id: shop.id, name: shop.owner_name, shopName: shop.shop_name,
          email: shop.email, mobile: shop.mobile,
          role: 'owner', userType: 'shop', repairShopId: shop.id,
        },
        activationType: 'lifetime',
        message: 'Lifetime access activated! Your subscription will never expire.',
        subscriptionRequired: false,
      });
    } catch (err) {
      await sql`ROLLBACK`.catch(() => {});
      console.error('[auth/signup] Lifetime access activation failed:', err.message);
    }
  }

  // ── Create Razorpay order (paid plan / discount codes) ─────────────────
  // IMPORTANT: No JWT token is generated here. For paid plans, the user must
  // complete payment AND get admin approval before receiving an authenticated session.
  // EXCEPTION: If discount results in $0 amount, activate immediately (no payment needed).
  console.log("[auth/signup] Creating payment order for shop #" + shop.id);

  try {
    // Calculate the amount from DB (authoritative source, don't trust frontend)
    const planId = 1; // 'pro' plan
    let { amount } = await calculateAmount(sql, currency, billingCycle, planId);
    let fullAmount = amount;
    
    // Apply discount from promo code
    let discountAmount = 0;
    if (appliedPromo) {
      if (appliedPromo.type === 'percentage_discount' && appliedPromo.discount_percent !== null) {
        discountAmount = Math.round((amount * appliedPromo.discount_percent / 100) * 100) / 100;
      } else if (appliedPromo.type === 'fixed_discount' && appliedPromo.discount_amount !== null) {
        discountAmount = appliedPromo.discount_amount;
      }
      if (appliedPromo.max_discount_amount !== null && discountAmount > appliedPromo.max_discount_amount) {
        discountAmount = appliedPromo.max_discount_amount;
      }
      amount = Math.max(0, Math.round((amount - discountAmount) * 100) / 100);
    }
    
    console.log("[auth/signup] Amount calculated from DB:", { amount, currency, billingCycle, planId, discountAmount });

    // ── ZERO AMOUNT (100% Discount): Skip Razorpay, activate immediately ──
    if (amount === 0 && appliedPromo && (appliedPromo.type === 'percentage_discount' || appliedPromo.type === 'fixed_discount')) {
      try {
        await sql`BEGIN`;
        
        await sql`
          UPDATE repair_shops
          SET subscription_status = 'active', approval_status = 'approved',
              is_active = true, updated_at = now()
          WHERE id = ${shop.id}
        `;
        
        const subEnd = new Date();
        subEnd.setFullYear(subEnd.getFullYear() + 10);
        
        const sub = await sql`
          INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway,
            amount_paid, currency, promotion_code_id,
            current_period_start, current_period_end, created_at)
          VALUES (${shop.id}, ${planId}, 'active', ${billingCycle}, 'promo_code',
            0, ${currency}, ${appliedPromo.id},
            now(), ${subEnd.toISOString()}, now())
          RETURNING id
        `;
        
        await sql`UPDATE promotion_codes SET used_count = used_count + 1, updated_at = now() WHERE id = ${appliedPromo.id}`;
        await sql`
          INSERT INTO promo_code_redemptions (promotion_code_id, repair_shop_id, email, ip_address, user_agent,
            plan_name, billing_cycle, original_amount, discount_amount, final_amount, currency,
            subscription_id, status)
          VALUES (${appliedPromo.id}, ${shop.id}, ${shop.email},
            ${request.headers['x-forwarded-for']?.split(',')[0] || request.headers['x-real-ip'] || null},
            ${request.headers['user-agent'] || null},
            ${planName}, ${billingCycle}, ${fullAmount}, ${discountAmount}, 0, ${currency},
            ${sub[0].id}, 'active')
        `;
        
        await sql`COMMIT`;
        
        const jti = makeJti();
        const token = signToken({
          sub: shop.id, role: 'owner', user_type: 'shop', repair_shop_id: shop.id,
        }, jti);
        
        console.log('[auth/signup] 100% discount activated for shop #' + shop.id);
        return response.status(201).json({
          token,
          user: {
            id: shop.id, name: shop.owner_name, shopName: shop.shop_name,
            email: shop.email, mobile: shop.mobile,
            role: 'owner', userType: 'shop', repairShopId: shop.id,
          },
          activationType: 'promo_discount',
          message: 'Your promo code has been applied! Subscription activated with 100% discount.',
          subscriptionRequired: false,
        });
      } catch (err) {
        await sql`ROLLBACK`.catch(() => {});
        console.error('[auth/signup] Zero-amount activation failed:', err.message);
        return response.status(201).json({
          shopId: shop.id,
          checkoutRequired: false,
          checkoutError: 'Discount activation failed: ' + err.message,
        });
      }
    }

    const invoiceNumber = `INV-${Date.now()}-${shop.id}`;

    // Create payment record
    const payment = await sql`
      INSERT INTO payments (repair_shop_id, gateway, currency, amount, status, invoice_number, description, metadata)
      VALUES (${shop.id}, 'pending', ${currency}, ${amount}, 'pending', ${invoiceNumber},
              ${`CoolCare Pro — ${billingCycle}`},
              ${JSON.stringify({ billingCycle, planName, source: 'signup', discountAmount, promoCodeId: appliedPromo?.id || null })}::jsonb)
      RETURNING id
    `;

    const paymentDbId = payment[0].id;
    console.log("[auth/signup] Payment record created:", { paymentDbId, amount, invoiceNumber });

    // Create order via gateway
    const originUrl = request.headers["origin"] || "https://coolcare.ai";
    const orderResult = await createOrder({
      shopId: shop.id,
      billingCycle,
      currency,
      amount,
      invoiceNumber,
      paymentDbId,
      originUrl,
    });

    console.log("[auth/signup] Gateway order result:", orderResult);

    if (orderResult.error) {
      console.error("[auth/signup] Gateway order failed:", orderResult.error);

      // Log failure
      try {
        await sql`
          INSERT INTO payment_logs (payment_id, repair_shop_id, gateway, event_type, severity, message, error_message)
          VALUES (${paymentDbId}, ${shop.id}, ${orderResult.gateway || 'razorpay'}, 'order_failed', 'error',
                  'Signup order creation failed', ${orderResult.error})
        `;
      } catch (e) { /* ok */ }

      // Order creation failed — return error, no token issued
      return response.status(201).json({
        shopId: shop.id,
        checkoutRequired: false,
        checkoutError: orderResult.error,
      });
    }

    // Update payment record with gateway info
    if (orderResult.gateway && orderResult.gateway !== "none") {
      const gatewayId = orderResult.orderId || orderResult.sessionId || null;
      await sql`UPDATE payments SET gateway = ${orderResult.gateway}, payment_id = ${gatewayId} WHERE id = ${paymentDbId}`;
    }

    console.log("[auth/signup] Returning checkout payload for shop #" + shop.id);

    return response.status(201).json({
      shopId: shop.id,
      checkoutRequired: true,
      gateway: orderResult.gateway || 'razorpay',
      orderId: orderResult.orderId || null,
      keyId: orderResult.keyId || null,
      amount: orderResult.amount || amount,
      currency: orderResult.currency || currency,
      invoiceNumber: orderResult.invoiceNumber || invoiceNumber,
      billingCycle,
      subscriptionStatus: "inactive",
      subscriptionRequired: true,
      isTestMode: orderResult.isTestMode || false,
    });
  } catch (err) {
    console.error("[auth/signup] Payment order creation error:", err.message);

    // If payment setup fails, still create the account but indicate no checkout
    return response.status(201).json({
      shopId: shop.id,
      checkoutRequired: false,
      checkoutError: err.message,
    });
  }
}

// ─── LOGOUT ──────────────────────────────────────────────────────────────────
async function handleLogout(request, response) {
  const authHeader = request.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) return response.status(200).json({ loggedOut: true });

  const decoded = jwt.decode(token);
  if (decoded?.jti && decoded?.exp) {
    const sql = neon(process.env.DATABASE_URL);
    const expiresAt = new Date(decoded.exp * 1000).toISOString();
    await sql`
      INSERT INTO jwt_denylist (jti, expires_at)
      VALUES (${decoded.jti}, ${expiresAt})
      ON CONFLICT (jti) DO NOTHING
    `;
    sql`DELETE FROM jwt_denylist WHERE expires_at < now()`.catch(() => {});
    console.log("[auth/logout] Token denylisted:", decoded.jti);
  }

  return response.status(200).json({ loggedOut: true });
}

// ─── BOOTSTRAP (create first super admin) ────────────────────────────────────
async function handleBootstrap(request, response, body) {
  if (!applyLimit(request, response, signupLimiter)) return;

  const data = validate({ ...request, body }, response, bootstrapSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);

  // Check if any super_admin already exists in users table.
  // If we cannot verify (DB error), default to BLOCKING bootstrap
  // rather than risking a duplicate super admin.
  let superAdminCheckOk = false;
  let superAdminCount = 0;
  try {
    const count = await sql`SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin'`;
    superAdminCount = parseInt(count[0]?.cnt || "0", 10);
    superAdminCheckOk = true;
  } catch (e) {
    console.error("[auth/bootstrap] Failed to check users table:", e.message);
  }

  if (!superAdminCheckOk) {
    return response.status(503).json({
      error: "Unable to verify Super Admin status. Please try again later.",
    });
  }

  if (superAdminCount > 0) {
    return response.status(403).json({ error: "A Super Admin already exists. Bootstrap is disabled." });
  }

  // Also check repair_shops for any super_admin
  try {
    const count2 = await sql`SELECT COUNT(*) as cnt FROM repair_shops WHERE role = 'super_admin'`;
    if (parseInt(count2[0]?.cnt || "0", 10) > 0) {
      return response.status(403).json({ error: "A Super Admin already exists. Bootstrap is disabled." });
    }
  } catch (e) {
    console.warn("[auth/bootstrap] Could not check repair_shops table:", e.message);
  }

  // Check email uniqueness
  try {
    const existing = await sql`SELECT id FROM users WHERE email = ${data.email} LIMIT 1`;
    if (existing.length > 0) {
      return response.status(409).json({ error: "Email already in use" });
    }
  } catch (e) { /* ok */ }

  const passwordHash = await bcrypt.hash(data.password, 12);

  const rows = await sql`
    INSERT INTO users (email, password_hash, name, role, is_active)
    VALUES (${data.email}, ${passwordHash}, ${data.name}, 'super_admin', true)
    RETURNING id, email, name, role
  `;
  const user = rows[0];

  const jti = makeJti();
  const token = signToken({
    sub: user.id,
    role: "super_admin",
    user_type: "user",
  }, jti);

  console.log("[auth/bootstrap] First super admin created:", user.email);
  return response.status(201).json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: "super_admin",
      userType: "user",
      repairShopId: null,
    },
  });
}

// ─── BOOTSTRAP CHECK (check if admin exists — no auth required) ────────
// Determines whether the login page shows the Setup form (no admin exists) vs Login form (admin exists).
async function handleBootstrapCheck(request, response) {
  if (!applyLimit(request, response, apiLimiter)) return;

  const sql = neon(process.env.DATABASE_URL);
  // Default: assume an admin exists (safe default — show normal login page).
  // Only set to true when we explicitly verify zero platform admins exist.
  let needsBootstrap = false;

  try {
    // Check for ANY platform admin role (super_admin, admin, support), not just super_admin.
    // Admins may be created via the admin panel with role='admin'.
    const count = await sql`SELECT COUNT(*) as cnt FROM users WHERE role IN ('super_admin', 'admin', 'support')`;
    const userCount = parseInt(count[0]?.cnt || "0", 10);
    console.log("[auth/bootstrap-check] users with admin role:", userCount);

    if (userCount === 0) {
      // No platform admins found in users table — check repair_shops as fallback
      try {
        const count2 = await sql`SELECT COUNT(*) as cnt FROM repair_shops WHERE role IN ('super_admin', 'admin', 'support')`;
        const shopCount = parseInt(count2[0]?.cnt || "0", 10);
        console.log("[auth/bootstrap-check] repair_shops with admin role:", shopCount);
        needsBootstrap = shopCount === 0;
      } catch (e2) {
        // repair_shops check failed — trust the users result (no admins found)
        console.warn("[auth/bootstrap-check] Failed to query repair_shops table:", e2.message);
        needsBootstrap = true;
      }
    }
    // If userCount > 0, needsBootstrap stays false (correct — admin exists)
  } catch (e) {
    // Database error — cannot verify. Default to safe: show login page.
    console.error("[auth/bootstrap-check] Failed to query users table:", e.message);
    needsBootstrap = false;
  }

  console.log("[auth/bootstrap-check] result:", { needsBootstrap });
  return response.status(200).json({ needsBootstrap });
}

// ─── ME (get current user info) ──────────────────────────────────────────────
async function handleMe(request, response) {
  if (!applyLimit(request, response, apiLimiter)) return;

  const auth = await requireAuth(request, response);
  if (!auth) return;

  const sql = neon(process.env.DATABASE_URL);
  const userId = parseInt(auth.sub, 10);
  const userType = auth.user_type || "shop";

  if (userType === "user") {
    try {
      const rows = await sql`
        SELECT id, email, name, role, repair_shop_id, is_active, last_login, created_at
        FROM users WHERE id = ${userId} LIMIT 1
      `;
      if (rows.length === 0) return response.status(404).json({ error: "User not found" });
      const u = rows[0];
      return response.status(200).json({
        user: {
          id: u.id, name: u.name, email: u.email, role: u.role,
          userType: "user", repairShopId: u.repair_shop_id,
          isActive: u.is_active, lastLogin: u.last_login,
        },
      });
    } catch (e) {
      return response.status(500).json({ error: "Failed to fetch user info" });
    }
  } else {
    const rows = await sql`
      SELECT id, shop_name, owner_name, email, mobile, city, role, is_active, created_at
      FROM repair_shops WHERE id = ${userId} LIMIT 1
    `;
    if (rows.length === 0) return response.status(404).json({ error: "Shop not found" });
    const s = rows[0];
    return response.status(200).json({
      user: {
        id: s.id, name: s.owner_name, shopName: s.shop_name,
        email: s.email, mobile: s.mobile, city: s.city,
        role: s.role || "owner", userType: "shop", repairShopId: s.id,
        isActive: s.is_active,
      },
    });
  }
}

// ─── FORGOT PASSWORD (generate reset token, send email) ─────────────────────
async function handleForgotPassword(request, response, body) {
  if (!applyLimit(request, response, signupLimiter)) return;

  const data = validate({ ...request, body }, response, forgotPasswordSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);

  // Generic message — never reveal if email exists
  const genericMsg = "If an account with that email exists, a password reset link has been sent.";

  // Look up user in both tables
  let userId = null;
  let userType = null;
  let userName = "";

  // Check users table first
  try {
    const rows = await sql`SELECT id, name FROM users WHERE email = ${data.email} LIMIT 1`;
    if (rows.length > 0) {
      userId = rows[0].id;
      userType = "user";
      userName = rows[0].name;
    }
  } catch (e) { /* table may not exist */ }

  // Check repair_shops table
  if (!userId) {
    try {
      const rows = await sql`SELECT id, owner_name FROM repair_shops WHERE email = ${data.email} LIMIT 1`;
      if (rows.length > 0) {
        userId = rows[0].id;
        userType = "shop";
        userName = rows[0].owner_name;
      }
    } catch (e) { /* ok */ }
  }

  if (!userId) {
    console.log("[auth/forgot-password] No account found for:", data.email);
    return response.status(200).json({ message: genericMsg });
  }

  // Rate limit: max 3 reset requests per hour per user
  try {
    const recent = await sql`
      SELECT COUNT(*) as cnt FROM password_reset_tokens
      WHERE user_id = ${userId} AND user_type = ${userType}
      AND created_at >= now() - INTERVAL '1 hour'
    `;
    if (parseInt(recent[0]?.cnt || "0", 10) >= 3) {
      return response.status(429).json({ error: "Too many reset requests. Please try again later." });
    }
  } catch (e) { /* table may not exist — allow */ }

  // Generate secure token
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

  // Store hashed token
  try {
    await sql`
      INSERT INTO password_reset_tokens (user_id, user_type, token_hash, expires_at)
      VALUES (${userId}, ${userType}, ${tokenHash}, ${expiresAt.toISOString()})
    `;
  } catch (e) {
    console.error("[auth/forgot-password] Failed to store token:", e.message);
    return response.status(200).json({ message: genericMsg });
  }

  // Build reset URL
  const baseUrl = process.env.APP_URL || "https://coolcare.ai";
  const resetUrl = `${baseUrl}/reset-password.html?token=${rawToken}`;

  // Send email
  const htmlBody = buildResetEmail(userName, resetUrl);
  const fromEmail = process.env.FROM_EMAIL || "noreply@coolcare.ai";

  const emailResult = await sendEmail(data.email, "Reset your CoolCare AI Password", htmlBody);

  if (!emailResult.ok) {
    console.error("[auth/forgot-password] Email send failed:", emailResult.error);
  }

  console.log("[auth/forgot-password] Reset requested for:", data.email, "type:", userType);
  return response.status(200).json({ message: genericMsg });
}

// ─── RESET PASSWORD (validate token, set new password) ─────────────────────
async function handleResetPassword(request, response, body) {
  if (!applyLimit(request, response, signupLimiter)) return;

  const data = validate({ ...request, body }, response, resetPasswordTokenSchema);
  if (!data) return;

  const sql = neon(process.env.DATABASE_URL);
  const tokenHash = crypto.createHash("sha256").update(data.token).digest("hex");

  // Find valid token
  let tokenRow = null;
  try {
    const rows = await sql`
      SELECT id, user_id, user_type, expires_at, used_at
      FROM password_reset_tokens
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `;
    tokenRow = rows[0] || null;
  } catch (e) {
    return response.status(500).json({ error: "Reset system unavailable. Please try again later." });
  }

  if (!tokenRow) {
    return response.status(400).json({ error: "Invalid or expired reset link." });
  }
  if (tokenRow.used_at) {
    return response.status(400).json({ error: "This reset link has already been used." });
  }
  if (new Date(tokenRow.expires_at) < new Date()) {
    return response.status(400).json({ error: "This reset link has expired." });
  }

  // Hash new password
  const passwordHash = await bcrypt.hash(data.password, 12);

  // Update password
  if (tokenRow.user_type === "user") {
    await sql`UPDATE users SET password_hash = ${passwordHash}, updated_at = now() WHERE id = ${tokenRow.user_id}`;
  } else {
    await sql`UPDATE repair_shops SET password_hash = ${passwordHash}, updated_at = now() WHERE id = ${tokenRow.user_id}`;
  }

  // Mark token as used
  await sql`UPDATE password_reset_tokens SET used_at = now() WHERE id = ${tokenRow.id}`;

  // Invalidate all other tokens for this user
  await sql`
    UPDATE password_reset_tokens SET used_at = now()
    WHERE user_id = ${tokenRow.user_id} AND user_type = ${tokenRow.user_type} AND used_at IS NULL
  `;

  console.log("[auth/reset-password] Password reset for user:", tokenRow.user_id, "type:", tokenRow.user_type);
  return response.status(200).json({ message: "Password has been reset successfully. You can now log in." });
}

// ─── DEMO PRELOAD (background pre-auth, lightweight) ───────────────────────
// Called silently from the homepage after 3s idle.
// Checks if demo data exists, creates it if needed, then issues a token.
// The token is cached on the frontend for instant launch.
async function handleDemoPreload(request, response) {
  if (!applyLimit(request, response, apiLimiter)) return;
  perfMark('demo-preload start');

  console.log("[auth/demo-preload] Background preloading demo environment...");

  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── Quick check: Does demo shop already exist with data? ───────────────
    const existing = await sql`SELECT id FROM repair_shops WHERE email = ${DEMO.shop.email} LIMIT 1`;
    perfMark('preload: checked existing shop');

    let demoShopId;
    let needsFullSetup = false;

    if (existing.length > 0) {
      demoShopId = existing[0].id;
      // Check if data already exists (fast path — skip regeneration)
      const bookingCheck = await sql`SELECT COUNT(*) as cnt FROM bookings WHERE repair_shop_id = ${demoShopId}`;
      needsFullSetup = parseInt(bookingCheck[0]?.cnt || "0", 10) === 0;
      
      // Always ensure the shop is active
      await sql`UPDATE repair_shops SET is_demo = true, is_active = true, subscription_status = 'active',
        approval_status = 'approved', updated_at = now() WHERE id = ${demoShopId}`;
    } else {
      // First visit ever — create shop and data
      needsFullSetup = true;
      const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
      const shopRows = await sql`
        INSERT INTO repair_shops
          (shop_name, owner_name, email, mobile, password_hash,
           address, city, state, pincode, service_areas, services_offered, role,
           subscription_status, is_demo, is_active, referral_code,
           approval_status, gst_number, business_hours, language, timezone,
           selected_country, selected_currency, slug, website_enabled)
        VALUES
          (${DEMO.shop.shop_name}, ${DEMO.shop.owner_name}, ${DEMO.shop.email}, ${DEMO.shop.mobile},
           ${passwordHash}, ${DEMO.shop.address}, ${DEMO.shop.city},
           ${DEMO.shop.state || 'Karnataka'}, ${DEMO.shop.pincode || '560038'},
           ${DEMO.shop.service_areas}, ${DEMO.shop.services_offered}, 'owner',
           'active', true, true, 'DEMO-0001',
           'approved', ${DEMO.shop.gst_number || '29ABCDE1234F1Z5'},
           ${JSON.stringify(DEMO.shop.business_hours)}::jsonb, 'en', 'Asia/Kolkata',
           'IN', 'INR', 'coolcare-demo', true)
        RETURNING id
      `;
      demoShopId = shopRows[0].id;
    }

    perfMark('preload: shop ready, needsSetup=' + needsFullSetup);

    // ── Only regenerate data if needed (first time or data was wiped) ──────
    if (needsFullSetup) {
      // All demo data operations are wrapped in a transaction for atomicity.
      // This prevents partial inserts if a concurrent request or error occurs.
      await sql`BEGIN`;
      try {
        // Delete old data
        await sql`DELETE FROM booking_timeline WHERE booking_id IN (SELECT id FROM bookings WHERE repair_shop_id = ${demoShopId})`;
        await sql`DELETE FROM whatsapp_conversations WHERE repair_shop_id = ${demoShopId}`;
        await sql`DELETE FROM conversation_state WHERE repair_shop_id = ${demoShopId}`;
        await sql`DELETE FROM shop_notifications WHERE repair_shop_id = ${demoShopId}`;
        await sql`DELETE FROM bookings WHERE repair_shop_id = ${demoShopId}`;
        await sql`DELETE FROM technicians WHERE repair_shop_id = ${demoShopId}`;
        await sql`DELETE FROM ai_settings WHERE repair_shop_id = ${demoShopId}`;
        await sql`DELETE FROM subscriptions WHERE repair_shop_id = ${demoShopId}`;
        await sql`DELETE FROM payments WHERE repair_shop_id = ${demoShopId}`;

        // Insert AI settings — UPSERT to prevent duplicate key errors on UNIQUE(repair_shop_id)
        // Using ON CONFLICT DO UPDATE guarantees idempotency even under concurrent requests
        await sql`
          INSERT INTO ai_settings (repair_shop_id, greeting_message, business_hours, working_days,
            supported_services, knowledge_base, fallback_response, transfer_to_human, updated_at, created_at)
          VALUES (${demoShopId}, ${DEMO.ai_settings.greeting_message},
            ${JSON.stringify(DEMO.shop.business_hours)}::jsonb,
            ${DEMO.ai_settings.working_days},
            ${DEMO.ai_settings.supported_services},
            ${DEMO.ai_settings.knowledge_base},
            ${DEMO.ai_settings.fallback_response},
            ${DEMO.ai_settings.transfer_to_human}, now(), now())
          ON CONFLICT (repair_shop_id) DO UPDATE SET
            greeting_message = EXCLUDED.greeting_message,
            business_hours = EXCLUDED.business_hours,
            working_days = EXCLUDED.working_days,
            supported_services = EXCLUDED.supported_services,
            knowledge_base = EXCLUDED.knowledge_base,
            fallback_response = EXCLUDED.fallback_response,
            transfer_to_human = EXCLUDED.transfer_to_human,
            updated_at = now()
        `;

        // Insert technicians (8)
        for (const tech of DEMO.technicians) {
          await sql`
            INSERT INTO technicians (repair_shop_id, name, phone, email, services, specialization, active)
            VALUES (${demoShopId}, ${tech.name}, ${tech.phone}, ${tech.email},
              ${tech.services || tech.specialization}, ${tech.specialization}, ${tech.active})
          `;
        }

        // Fetch technician IDs
        const techRows = await sql`SELECT id, name FROM technicians WHERE repair_shop_id = ${demoShopId} ORDER BY id ASC`;
        const techMap = {};
        techRows.forEach((t, i) => { techMap[i] = t.id; });

        // Insert bookings (200+)
        for (let i = 0; i < DEMO.bookings.length; i++) {
          const b = DEMO.bookings[i];
          const cust = DEMO.customers[b.customerIdx];
          const techId = b.techIdx != null ? techMap[b.techIdx] || null : null;
          const techName = b.techIdx != null && DEMO.technicians[b.techIdx] ? DEMO.technicians[b.techIdx].name : null;
          let priority = 'normal';
          if (b.urgency === 'urgent') priority = 'urgent';
          else if (b.urgency === 'today') priority = 'high';
          await sql`
            INSERT INTO bookings (repair_shop_id, customer_number, customer_name, service_type,
              area, address, urgency, status, technician_id, technician_name, estimated_cost, final_cost,
              priority, invoice_number, created_at, customer_notes)
            VALUES (${demoShopId}, ${cust.phone}, ${cust.name},
              ${b.service}, ${b.area}, ${cust.address || b.area}, ${b.urgency}, ${b.status},
              ${techId}, ${techName}, ${b.cost ? b.cost * 0.7 : null}, ${b.final_cost || null},
              ${priority},
              ${b.status === 'completed' ? `INV-DEMO-${String(i + 1).padStart(4, '0')}` : null},
              ${ago(b.created_days_ago)}, ${'Customer reported ' + b.service.toLowerCase()})
          `;
        }

        // Insert subscription
        const planRows = await sql`SELECT id FROM subscription_plans WHERE name = 'pro' LIMIT 1`;
        if (planRows.length > 0) {
          const subEnd = new Date(); subEnd.setFullYear(subEnd.getFullYear() + 1);
          await sql`INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway,
            gateway_sub_id, amount_paid, currency, current_period_start, current_period_end, created_at)
            VALUES (${demoShopId}, ${planRows[0].id}, 'active', 'yearly', 'demo',
              'demo-sub-001', 12470, 'INR', now(), ${subEnd.toISOString()}, now())`;
        }

        // Insert payment
        await sql`INSERT INTO payments (repair_shop_id, gateway, currency, amount, status,
          invoice_number, description, created_at)
          VALUES (${demoShopId}, 'demo', 'INR', 12470, 'completed',
            'INV-DEMO-0000', 'CoolCare Pro — Yearly Subscription (Demo)', now())`;

        // Insert conversations (batched for speed)
        for (const conv of DEMO.conversations) {
          const cust = DEMO.customers[conv.customerIdx];
          for (const msg of conv.messages) {
            await sql`INSERT INTO whatsapp_conversations (repair_shop_id, customer_number, customer_name, direction, message_text, created_at)
              VALUES (${demoShopId}, ${cust.phone}, ${cust.name},
                ${msg.role === 'customer' ? 'inbound' : 'outbound'}, ${msg.text}, now())`;
          }
        }

        // Insert timeline
        const insertedBookings = await sql`SELECT id FROM bookings WHERE repair_shop_id = ${demoShopId} ORDER BY id ASC`;
        for (let i = 0; i < Math.min(DEMO.timeline.length, 50); i++) {
          const t = DEMO.timeline[i];
          if (t.bookingId < 1 || t.bookingId > insertedBookings.length) continue;
          const actualBookingId = insertedBookings[t.bookingId - 1]?.id;
          if (!actualBookingId) continue;
          await sql`INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, notes, created_at)
            VALUES (${actualBookingId}, ${t.action}, ${t.oldValue}, ${t.newValue},
              ${t.actorType}, ${t.notes || null}, now())`;
        }

        // Insert notifications
        for (let i = 0; i < DEMO.notifications.length; i++) {
          const n = DEMO.notifications[i];
          await sql`INSERT INTO shop_notifications (repair_shop_id, type, title, message, is_read, metadata, created_at)
            VALUES (${demoShopId}, ${n.type}, ${n.title}, ${n.message}, ${n.is_read},
              ${JSON.stringify(n.metadata || {})}::jsonb, now())`;
        }

        await sql`COMMIT`;

        // Invalidate cache since we regenerated data
        invalidateDemoCache();
        
        console.log("[auth/demo-preload] Full demo data generated for shop #" + demoShopId);
      } catch (txErr) {
        // Silent rollback: database may have already rolled back on constraint violation
        try { await sql`ROLLBACK`; } catch (_) { /* ignore */ }
        console.error("[auth/demo-preload] Transaction failed, rolled back:", txErr.message);
        throw txErr;
      }
    } else {
      console.log("[auth/demo-preload] Demo data already exists, reusing for shop #" + demoShopId);
    }

    perfMark('preload: data ready');

    // ── Issue demo token (30-min expiry) ───────────────────────────────────
    const jti = makeJti();
    const token = signToken({
      sub: demoShopId,
      role: "owner",
      user_type: "shop",
      repair_shop_id: demoShopId,
      isDemo: true,
    }, jti);

    perfMark('preload: token issued');
    perfReport('handleDemoPreload');

    return response.status(200).json({
      token,
      isDemo: true,
      user: {
        id: demoShopId,
        name: DEMO.shop.owner_name,
        shopName: DEMO.shop.shop_name,
        email: DEMO.shop.email,
        mobile: DEMO.shop.mobile,
        role: "owner",
        userType: "shop",
        repairShopId: demoShopId,
      },
      expiresIn: "30m",
      preloaded: true,
      timing: { label: 'preloaded' },
    });
  } catch (err) {
    console.error("[auth/demo-preload] Failed:", err.message);
    return response.status(500).json({ error: "Failed to preload demo session." });
  }
}

// ─── DEMO LOGIN (optimized — reuses existing data when possible) ───────────
// Creates the demo shop if it doesn't exist, reuses data if it does.
// Issues a 30-min demo token.
async function handleDemoLogin(request, response) {
  if (!applyLimit(request, response, apiLimiter)) return;
  perfMark('demo-login start');

  console.log("[auth/demo-login] Creating/resetting demo environment...");

  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── 1. Find existing demo shop or create new one ───────────────────────
    let demoShopId = null;
    let needsSetup = true;
    const existing = await sql`SELECT id FROM repair_shops WHERE email = ${DEMO.shop.email} LIMIT 1`;
    perfMark('demo-login: shop check done');

    if (existing.length > 0) {
      demoShopId = existing[0].id;
      // Fast path: check if bookings already exist
      const countResult = await sql`SELECT COUNT(*) as cnt FROM bookings WHERE repair_shop_id = ${demoShopId}`;
      const hasData = parseInt(countResult[0]?.cnt || "0", 10) > 0;
      if (hasData) {
        needsSetup = false;
        console.log("[auth/demo-login] Reusing existing demo data for shop #" + demoShopId);
      }
      
      // Ensure shop is active
      await sql`UPDATE repair_shops SET is_demo = true, is_active = true, subscription_status = 'active',
        approval_status = 'approved', updated_at = now() WHERE id = ${demoShopId}`;
    }
    
    if (needsSetup) {
      // All demo data operations are wrapped in a transaction for atomicity.
      // This prevents partial inserts if a concurrent request or error occurs.
      await sql`BEGIN`;
      try {
        if (existing.length > 0) {
          // Delete old data
          await sql`DELETE FROM booking_timeline WHERE booking_id IN (SELECT id FROM bookings WHERE repair_shop_id = ${demoShopId})`;
          await sql`DELETE FROM whatsapp_conversations WHERE repair_shop_id = ${demoShopId}`;
          await sql`DELETE FROM conversation_state WHERE repair_shop_id = ${demoShopId}`;
          await sql`DELETE FROM shop_notifications WHERE repair_shop_id = ${demoShopId}`;
          await sql`DELETE FROM bookings WHERE repair_shop_id = ${demoShopId}`;
          await sql`DELETE FROM technicians WHERE repair_shop_id = ${demoShopId}`;
          await sql`DELETE FROM ai_settings WHERE repair_shop_id = ${demoShopId}`;
          await sql`DELETE FROM subscriptions WHERE repair_shop_id = ${demoShopId}`;
          await sql`DELETE FROM payments WHERE repair_shop_id = ${demoShopId}`;
        } else {
          // Create new demo shop
          const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
          const shopRows = await sql`
            INSERT INTO repair_shops
              (shop_name, owner_name, email, mobile, password_hash,
               address, city, state, pincode, service_areas, services_offered, role,
               subscription_status, is_demo, is_active, referral_code,
               approval_status, gst_number, business_hours, language, timezone,
               selected_country, selected_currency, slug, website_enabled)
            VALUES
              (${DEMO.shop.shop_name}, ${DEMO.shop.owner_name}, ${DEMO.shop.email}, ${DEMO.shop.mobile},
               ${passwordHash}, ${DEMO.shop.address}, ${DEMO.shop.city},
               ${DEMO.shop.state || 'Karnataka'}, ${DEMO.shop.pincode || '560038'},
               ${DEMO.shop.service_areas}, ${DEMO.shop.services_offered}, 'owner',
               'active', true, true, 'DEMO-0001',
               'approved', ${DEMO.shop.gst_number || '29ABCDE1234F1Z5'},
               ${JSON.stringify(DEMO.shop.business_hours)}::jsonb, 'en', 'Asia/Kolkata',
               'IN', 'INR', 'coolcare-demo', true)
            RETURNING id
          `;
          demoShopId = shopRows[0].id;
        }

        // Insert AI settings — UPSERT to prevent duplicate key errors on UNIQUE(repair_shop_id)
        await sql`INSERT INTO ai_settings (repair_shop_id, greeting_message, business_hours, working_days,
          supported_services, knowledge_base, fallback_response, transfer_to_human, updated_at, created_at)
          VALUES (${demoShopId}, ${DEMO.ai_settings.greeting_message},
            ${JSON.stringify(DEMO.shop.business_hours)}::jsonb,
            ${DEMO.ai_settings.working_days}, ${DEMO.ai_settings.supported_services},
            ${DEMO.ai_settings.knowledge_base}, ${DEMO.ai_settings.fallback_response},
            ${DEMO.ai_settings.transfer_to_human}, now(), now())
          ON CONFLICT (repair_shop_id) DO UPDATE SET
            greeting_message = EXCLUDED.greeting_message,
            business_hours = EXCLUDED.business_hours,
            working_days = EXCLUDED.working_days,
            supported_services = EXCLUDED.supported_services,
            knowledge_base = EXCLUDED.knowledge_base,
            fallback_response = EXCLUDED.fallback_response,
            transfer_to_human = EXCLUDED.transfer_to_human,
            updated_at = now()`;

        // Insert technicians
        for (const tech of DEMO.technicians) {
          await sql`INSERT INTO technicians (repair_shop_id, name, phone, email, services, specialization, active)
            VALUES (${demoShopId}, ${tech.name}, ${tech.phone}, ${tech.email}, ${tech.services || tech.specialization}, ${tech.specialization}, ${tech.active})`;
        }

        // Fetch technician IDs
        const techRows = await sql`SELECT id, name FROM technicians WHERE repair_shop_id = ${demoShopId} ORDER BY id ASC`;
        const techMap = {};
        techRows.forEach((t, i) => { techMap[i] = t.id; });

        // Insert bookings (batched)
        for (let i = 0; i < DEMO.bookings.length; i++) {
          const b = DEMO.bookings[i];
          const cust = DEMO.customers[b.customerIdx];
          const techId = b.techIdx != null ? techMap[b.techIdx] || null : null;
          const techName = b.techIdx != null && DEMO.technicians[b.techIdx] ? DEMO.technicians[b.techIdx].name : null;
          let priority = 'normal';
          if (b.urgency === 'urgent') priority = 'urgent';
          else if (b.urgency === 'today') priority = 'high';
          await sql`INSERT INTO bookings (repair_shop_id, customer_number, customer_name, service_type,
            area, address, urgency, status, technician_id, technician_name, estimated_cost, final_cost,
            priority, invoice_number, created_at, customer_notes)
            VALUES (${demoShopId}, ${cust.phone}, ${cust.name},
              ${b.service}, ${b.area}, ${cust.address || b.area}, ${b.urgency}, ${b.status},
              ${techId}, ${techName}, ${b.cost ? b.cost * 0.7 : null}, ${b.final_cost || null},
              ${priority},
              ${b.status === 'completed' ? `INV-DEMO-${String(i + 1).padStart(4, '0')}` : null},
              ${ago(b.created_days_ago)}, ${'Customer reported ' + b.service.toLowerCase()})`;
        }

        // Insert subscription
        const planRows = await sql`SELECT id FROM subscription_plans WHERE name = 'pro' LIMIT 1`;
        if (planRows.length > 0) {
          const subEnd = new Date(); subEnd.setFullYear(subEnd.getFullYear() + 1);
          await sql`INSERT INTO subscriptions (repair_shop_id, plan_id, status, billing_cycle, gateway,
            gateway_sub_id, amount_paid, currency, current_period_start, current_period_end, created_at)
            VALUES (${demoShopId}, ${planRows[0].id}, 'active', 'yearly', 'demo',
              'demo-sub-001', 12470, 'INR', now(), ${subEnd.toISOString()}, now())`;
        }

        // Insert payment
        await sql`INSERT INTO payments (repair_shop_id, gateway, currency, amount, status,
          invoice_number, description, created_at)
          VALUES (${demoShopId}, 'demo', 'INR', 12470, 'completed',
            'INV-DEMO-0000', 'CoolCare Pro — Yearly Subscription (Demo)', now())`;

        // Insert conversations
        for (const conv of DEMO.conversations) {
          const cust = DEMO.customers[conv.customerIdx];
          for (const msg of conv.messages) {
            await sql`INSERT INTO whatsapp_conversations (repair_shop_id, customer_number, customer_name, direction, message_text, created_at)
              VALUES (${demoShopId}, ${cust.phone}, ${cust.name},
                ${msg.role === 'customer' ? 'inbound' : 'outbound'}, ${msg.text}, now())`;
          }
        }

        // Insert timeline
        const insertedBookings = await sql`SELECT id FROM bookings WHERE repair_shop_id = ${demoShopId} ORDER BY id ASC`;
        for (let i = 0; i < Math.min(DEMO.timeline.length, 50); i++) {
          const t = DEMO.timeline[i];
          if (t.bookingId < 1 || t.bookingId > insertedBookings.length) continue;
          const actualBookingId = insertedBookings[t.bookingId - 1]?.id;
          if (!actualBookingId) continue;
          await sql`INSERT INTO booking_timeline (booking_id, action, old_value, new_value, actor_type, notes, created_at)
            VALUES (${actualBookingId}, ${t.action}, ${t.oldValue}, ${t.newValue},
              ${t.actorType}, ${t.notes || null}, now())`;
        }

        // Insert notifications
        for (let i = 0; i < DEMO.notifications.length; i++) {
          const n = DEMO.notifications[i];
          await sql`INSERT INTO shop_notifications (repair_shop_id, type, title, message, is_read, metadata, created_at)
            VALUES (${demoShopId}, ${n.type}, ${n.title}, ${n.message}, ${n.is_read},
              ${JSON.stringify(n.metadata || {})}::jsonb, now())`;
        }

        await sql`COMMIT`;

        // Invalidate cache since we regenerated
        invalidateDemoCache();
        
        console.log("[auth/demo-login] Demo environment ready for shop #" + demoShopId);
      } catch (txErr) {
        // Silent rollback: database may have already rolled back on constraint violation
        try { await sql`ROLLBACK`; } catch (_) { /* ignore */ }
        console.error("[auth/demo-login] Transaction failed, rolled back:", txErr.message);
        throw txErr;
      }
    }

    perfMark('demo-login: data ready');

    // ── Issue demo token (30-min expiry) ───────────────────────────────────
    const jti = makeJti();
    const token = signToken({
      sub: demoShopId,
      role: "owner",
      user_type: "shop",
      repair_shop_id: demoShopId,
      isDemo: true,
    }, jti);

    perfMark('demo-login: token issued');
    perfReport('handleDemoLogin');

    return response.status(200).json({
      token,
      isDemo: true,
      user: {
        id: demoShopId,
        name: DEMO.shop.owner_name,
        shopName: DEMO.shop.shop_name,
        email: DEMO.shop.email,
        mobile: DEMO.shop.mobile,
        role: "owner",
        userType: "shop",
        repairShopId: demoShopId,
      },
      expiresIn: "30m",
      reusedData: !needsSetup,
    });
  } catch (err) {
    console.error("[auth/demo-login] Failed:", err.message);
    return response.status(500).json({ error: "Failed to create demo session. Please try again." });
  }
}

// ─── BUILD RESET EMAIL HTML ──────────────────────────────────────────────────
function buildResetEmail(userName, resetUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#111111;border:1px solid #222;border-radius:12px;padding:40px;">
<tr><td style="text-align:center;padding-bottom:24px;">
  <h1 style="font-size:22px;font-weight:700;color:#fff;margin:0;letter-spacing:-0.3px;">coolcare</h1>
</td></tr>
<tr><td style="padding:0 8px;">    <p style="color:#a3a3a3;font-size:14px;margin:0 0 16px;">Hi ${htmlEscape(userName) || "there"},</p>
  <p style="color:#e5e5e5;font-size:15px;line-height:1.6;margin:0 0 24px;">
    We received a request to reset your CoolCare AI password. Click the button below to set a new password.
  </p>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
  <tr><td align="center">
    <a href="${resetUrl}" style="display:inline-block;background:#fff;color:#000;font-weight:600;font-size:14px;padding:12px 32px;border-radius:8px;text-decoration:none;letter-spacing:0.2px;">
      Reset Password
    </a>
  </td></tr>
  </table>
  <p style="color:#737373;font-size:12px;line-height:1.5;margin:0 0 8px;">
    Or copy this link into your browser:<br>
    <span style="color:#a3a3a3;word-break:break-all;">${resetUrl}</span>
  </p>
  <p style="color:#525252;font-size:12px;line-height:1.5;margin:0 0 16px;">
    This link expires in 30 minutes. If you didn't request this, you can safely ignore this email.
  </p>
</td></tr>
<tr><td style="text-align:center;padding-top:24px;border-top:1px solid #222;">
  <p style="color:#525252;font-size:11px;margin:0;">CoolCare AI &mdash; Better service, one conversation at a time.</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

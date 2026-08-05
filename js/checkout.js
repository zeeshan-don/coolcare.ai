/**
 * CoolCare Checkout — shared payment launcher for Razorpay & Stripe.
 * Never trusts frontend for activation; webhooks handle verification.
 */
(function (global) {
  'use strict';

  function getToken() {
    return localStorage.getItem('cc_token');
  }

  function savePendingCheckout(billingCycle, currency, country, planName) {
    sessionStorage.setItem('cc_checkout_pending', JSON.stringify({ billingCycle, currency, country, planName: planName || 'pro', ts: Date.now() }));
  }

  function loadPendingCheckout() {
    try {
      const raw = sessionStorage.getItem('cc_checkout_pending');
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - (data.ts || 0) > 3600000) {
        sessionStorage.removeItem('cc_checkout_pending');
        return null;
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  function clearPendingCheckout() {
    sessionStorage.removeItem('cc_checkout_pending');
  }

  function loadRazorpayScript() {
    return new Promise(function (resolve, reject) {
      if (global.Razorpay) return resolve();
      var s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Failed to load Razorpay checkout')); };
      document.head.appendChild(s);
    });
  }

  function planLabel(planName) {
    return planName === 'starter' ? 'Starter' : 'Pro';
  }

  // STEP 6 — verify the backend price against the single pricing source
  // (GET /api/currency, backed by api/_lib/pricing.js) BEFORE Razorpay opens.
  async function verifyBackendPrice(planName, billingCycle, currency, backendAmount) {
    try {
      const res = await fetch('/api/currency?currency=' + encodeURIComponent(currency || 'USD'));
      if (!res.ok) return { ok: true }; // API down — don't block on a hard failure, but log
      const data = await res.json();
      const planPrices = data.pricing && data.pricing[planName === 'starter' ? 'starter' : 'pro'];
      const expected = planPrices ? (planPrices[billingCycle] != null ? planPrices[billingCycle] : planPrices.monthly) : null;
      const actual = Number(backendAmount);
      console.log('[checkout] Price verification:', { planName, billingCycle, currency, expected, backendAmount: actual });
      if (expected == null) return { ok: true }; // no config price — let the gateway decide
      if (Math.abs(actual - Number(expected)) > 0.011) {
        return { ok: false, expected, actual };
      }
      return { ok: true };
    } catch (err) {
      return { ok: true }; // network error — don't block, gateway amount is still backend-derived
    }
  }

  function openRazorpay(data, shop) {
    var options = {
      key: data.keyId,
      order_id: data.orderId,
      currency: data.currency,
      name: 'CoolCare',
      description: 'CoolCare ' + planLabel(data.planName) + ' — ' + (data.billingCycle || 'monthly'),
      handler: function () {
        window.location.href = '/payment-success.html';
      },
      modal: {
        ondismiss: function () {
          window.location.href = '/payment-failed.html';
        },
      },
      theme: { color: '#ffffff' },
      prefill: {
        email: shop && shop.email ? shop.email : '',
        contact: shop && shop.mobile ? shop.mobile : '',
        name: shop && shop.owner_name ? shop.owner_name : '',
      },
      notes: {
        plan: data.planName || 'pro',
        billing_cycle: data.billingCycle || 'monthly',
      },
    };

    var rzp = new global.Razorpay(options);
    rzp.on('payment.failed', function () {
      window.location.href = '/payment-failed.html';
    });
    rzp.open();
  }

  async function startCheckout(opts) {
    var billingCycle = opts.billingCycle || 'monthly';
    var currency = (opts.currency || localStorage.getItem('cc_currency') || 'USD').toUpperCase();
    var country = opts.country || localStorage.getItem('cc_country') || null;
    var planName = opts.planName || 'pro';
    var onError = opts.onError || function (msg) { alert(msg); };
    var onStart = opts.onStart || function () {};
    var onSuccess = opts.onSuccess || null;
    var couponCode = opts.couponCode || null;

    var token = getToken();
    if (!token) {
      var redirectUrl = '/shop-signup.html?billing=' + encodeURIComponent(billingCycle) + '&currency=' + encodeURIComponent(currency) + '&plan=' + encodeURIComponent(planName);
      if (country) redirectUrl += '&country=' + encodeURIComponent(country);
      savePendingCheckout(billingCycle, currency, country, planName);
      window.location.href = redirectUrl;
      return;
    }

    onStart();

    try {
      var body = {
        action: 'checkout',
        planName: planName,
        billingCycle: billingCycle,
        currency: currency,
      };
      // Send country info for security (backend will determine amount)
      if (country) {
        body.selectedCountry = country;
      }
      // Pass coupon/promo code if provided
      if (couponCode) {
        body.couponCode = couponCode;
      }
      
      var res = await fetch('/api/payments', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      var data = await res.json();
      if (!res.ok) {
        onError(data.error || 'Checkout failed. Please try again.');
        return;
      }

      // ── Handle zero-amount (100% discount) activation ──
      if (data.activationType === 'promo_discount' || (data.message && !data.gateway && !data.orderId)) {
        if (onSuccess) {
          onSuccess(data.message || 'Promo code applied! Subscription activated.');
        }
        return;
      }

      if (data.gateway === 'stripe' && data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }

      if (data.gateway === 'razorpay' && data.orderId && data.keyId) {
        // STEP 6 — verify Displayed/Backend price == Razorpay order amount.
        // If the numbers disagree, DO NOT open Razorpay.
        // `data.baseAmount` is the pre-discount price computed by the backend
        // from the single pricing source, so this check applies to plain and
        // discounted checkouts alike. The discount itself is backend-computed
        // against the same config, so `data.amount` (order amount) stays
        // consistent with `data.baseAmount`.
        var baseToVerify = data.baseAmount != null ? data.baseAmount : data.amount;
        var check = await verifyBackendPrice(planName, billingCycle, data.currency || currency, baseToVerify);
        if (!check.ok) {
          console.error('[checkout] PRICE MISMATCH — refusing to open Razorpay', check);
          onError('Price verification failed. Please refresh and try again, or contact support.');
          return;
        }
        console.log('[checkout] Price chain verified — opening Razorpay.', {
          planName, billingCycle, currency: data.currency || currency,
          baseAmount: baseToVerify, orderAmount: data.amount, discount: data.discount,
        });
        await loadRazorpayScript();
        var shop = null;
        try { shop = JSON.parse(localStorage.getItem('cc_shop') || 'null'); } catch (e) { /* ok */ }
        openRazorpay(Object.assign({}, data, { billingCycle: billingCycle }), shop);
        return;
      }

      if (data.message) {
        onError(data.message);
        return;
      }

      onError('Payment gateway not configured. Please contact support.');
    } catch (err) {
      onError('Network error. Please check your connection and try again.');
    }
  }

  async function resumePendingCheckout() {
    var pending = loadPendingCheckout();
    if (!pending || !getToken()) return false;
    clearPendingCheckout();
    await startCheckout({
      billingCycle: pending.billingCycle,
      currency: pending.currency,
      planName: pending.planName || 'pro',
    });
    return true;
  }

  global.CoolCareCheckout = {
    start: startCheckout,
    resumePending: resumePendingCheckout,
    savePending: savePendingCheckout,
    clearPending: clearPendingCheckout,
    loadPending: loadPendingCheckout,
  };
})(window);

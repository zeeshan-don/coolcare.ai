/**
 * CoolCare Checkout — shared payment launcher for Razorpay & Stripe.
 * Never trusts frontend for activation; webhooks handle verification.
 */
(function (global) {
  'use strict';

  function getToken() {
    return localStorage.getItem('cc_token');
  }

  function savePendingCheckout(billingCycle, currency, country) {
    sessionStorage.setItem('cc_checkout_pending', JSON.stringify({ billingCycle, currency, country, ts: Date.now() }));
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

  function openRazorpay(data, shop) {
    var options = {
      key: data.keyId,
      order_id: data.orderId,
      currency: data.currency,
      name: 'CoolCare',
      description: 'CoolCare Pro — ' + (data.billingCycle || 'monthly'),
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
        plan: 'pro',
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
    var onError = opts.onError || function (msg) { alert(msg); };
    var onStart = opts.onStart || function () {};
    var onSuccess = opts.onSuccess || null;
    var couponCode = opts.couponCode || null;

    var token = getToken();
    if (!token) {
      var redirectUrl = '/shop-signup.html?billing=' + encodeURIComponent(billingCycle) + '&currency=' + encodeURIComponent(currency);
      if (country) redirectUrl += '&country=' + encodeURIComponent(country);
      savePendingCheckout(billingCycle, currency, country);
      window.location.href = redirectUrl;
      return;
    }

    onStart();

    try {
      var body = {
        action: 'checkout',
        planName: 'pro',
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

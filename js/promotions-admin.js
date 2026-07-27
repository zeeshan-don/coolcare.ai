/**
 * CoolCare Admin — Promotion Codes Management
 * Requires: TOKEN, api(), toast(), esc(), fmtMoney(), closeModal(), P global
 */

/* ── PROMO CODE STATE ── */
if (typeof P === 'undefined') { window.P = {}; }
P.promo = P.promo || 1;
P.redemption = P.redemption || 1;

/* ── TYPE-SPECIFIC SECTION TOGGLE ── */
function onPromoTypeChange(type) {
  document.querySelectorAll('.promo-type-section').forEach(s => s.style.display = 'none');
  const map = {
    percentage_discount: 'pc_percent_section',
    fixed_discount: 'pc_fixed_section',
    free_trial: 'pc_trial_section',
    support_token: 'pc_token_section',
    lifetime_access: 'pc_token_section',
  };
  const sec = document.getElementById(map[type]);
  if (sec) sec.style.display = 'block';
}

function toggleAdvanced() {
  const sec = document.getElementById('advancedSection');
  const text = document.getElementById('advancedToggleText');
  const isOpen = sec.style.display !== 'none';
  sec.style.display = isOpen ? 'none' : 'block';
  text.textContent = isOpen ? '▶ Advanced Options' : '▼ Advanced Options';
}

/* ── LOAD PROMO STATS ── */
async function loadPromoStats() {
  const res = await api('/api/promotions', {
    method: 'POST',
    body: JSON.stringify({ action: 'stats' })
  });
  if (!res) return;
  const data = await res.json();
  const s = data.stats || {};
  document.getElementById('ps_total').textContent = fmtMoney(s.totalCodes);
  document.getElementById('ps_active').textContent = fmtMoney(s.activeCodes);
  document.getElementById('ps_expired').textContent = fmtMoney(s.expiredCodes);
  document.getElementById('ps_used').textContent = fmtMoney(s.usedCodes);
  document.getElementById('ps_redemptions').textContent = fmtMoney(s.totalRedemptions);
  document.getElementById('ps_discountAmount').textContent = fmtMoney(s.totalDiscountAmount);
  document.getElementById('ps_conversion').textContent = s.conversionRate + '%';
}

/* ── LOAD PROMO CODES ── */
async function loadPromoCodes(page) {
  P.promo = Math.max(1, page || 1);
  
  const body = {
    action: 'list',
    page: P.promo,
    limit: 20,
    search: (document.getElementById('promoSearch')?.value || ''),
    type: (document.getElementById('promoTypeFilter')?.value || ''),
    status: (document.getElementById('promoStatusFilter')?.value || ''),
  };

  const res = await api('/api/promotions', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  if (!res) return;

  const data = await res.json();
  const tbody = document.getElementById('promoBody');
  
  if (!data.codes?.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No promotion codes found</td></tr>';
    updatePagerPromo(data.pagination);
    return;
  }

  tbody.innerHTML = data.codes.map(c => {
    const now = new Date();
    const validFrom = new Date(c.valid_from);
    const validUntil = c.valid_until ? new Date(c.valid_until) : null;
    let status = 'active';
    let badgeCls = 'badge-active';
    if (!c.is_active) { status = 'inactive'; badgeCls = 'badge-inactive'; }
    else if (validUntil && validUntil < now) { status = 'expired'; badgeCls = 'badge-suspended'; }
    else if (validFrom > now) { status = 'scheduled'; badgeCls = 'badge-blue'; }
    
    let discountLabel = '—';
    if (c.type === 'percentage_discount') discountLabel = c.discount_percent + '%';
    else if (c.type === 'fixed_discount') discountLabel = (c.discount_currency || '₹') + ' ' + fmtMoney(c.discount_amount);
    else if (c.type === 'free_trial') discountLabel = c.free_trial_days + ' days';
    else if (c.type === 'support_token') discountLabel = '🔑 Token';
    else if (c.type === 'lifetime_access') discountLabel = '♾️ Lifetime';

    return `<tr>
      <td><strong>${esc(c.name)}</strong><br><small style="color:var(--muted2)">${esc(c.description || '')}</small></td>
      <td><code style="background:var(--bg4);padding:2px 6px;border-radius:4px;font-size:12px">${esc(c.code)}</code></td>
      <td><span class="badge badge-blue">${esc(c.type.replace(/_/g, ' '))}</span></td>
      <td style="font-weight:600;color:#fff">${discountLabel}</td>
      <td>${c.used_count || 0}${c.max_uses ? '/' + c.max_uses : '/∞'}</td>
      <td>${validUntil ? validUntil.toLocaleDateString() : '—'}</td>
      <td><span class="badge ${badgeCls}">${status}</span></td>
      <td style="color:var(--green);font-weight:600">${c.redemption_count || 0}</td>
      <td style="white-space:nowrap">
        <button class="act" onclick="editPromoCode(${c.id})">Edit</button>
        <button class="act" onclick="togglePromoCode(${c.id})">${c.is_active ? 'Deactivate' : 'Activate'}</button>
        <button class="act" onclick="duplicatePromoCode(${c.id})">Duplicate</button>
        <button class="act danger" onclick="deletePromoCode(${c.id})">Delete</button>
      </td>
    </tr>`;
  }).join('');

  updatePagerPromo(data.pagination);
  loadPromoStats();
  loadRedemptions(1);
}

function updatePagerPromo(pagination) {
  const pg = pagination?.page || P.promo || 1;
  const total = pagination?.total || 0;
  const limit = pagination?.limit || 20;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const info = document.getElementById('promoPageInfo');
  const prev = document.getElementById('promoPrev');
  const next = document.getElementById('promoNext');
  if (info) info.textContent = `Page ${pg} of ${totalPages}`;
  if (prev) prev.disabled = pg <= 1;
  if (next) next.disabled = pg >= totalPages;
}

/* ── LOAD REDEMPTIONS ── */
async function loadRedemptions(page) {
  P.redemption = Math.max(1, page || 1);
  
  const res = await api('/api/promotions', {
    method: 'POST',
    body: JSON.stringify({ action: 'redemptions', page: P.redemption, limit: 20 })
  });
  if (!res) return;

  const data = await res.json();
  const tbody = document.getElementById('promoRedemptionsBody');
  
  if (!data.redemptions?.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No redemption history yet</td></tr>';
    updatePagerRedemption(data.pagination);
    return;
  }

  tbody.innerHTML = data.redemptions.map(r => {
    const bc = r.status === 'active' ? 'badge-active' : (r.status === 'failed' ? 'badge-suspended' : 'badge-inactive');
    return `<tr>
      <td><code style="background:var(--bg4);padding:1px 5px;border-radius:4px;font-size:11px">${esc(r.promo_code || r.code_name || '—')}</code></td>
      <td>${esc(r.repair_shop_name || '—')}</td>
      <td>${esc(r.email || '—')}</td>
      <td>${esc(r.plan_name || '—')}</td>
      <td>${r.currency || ''} ${fmtMoney(r.original_amount)}</td>
      <td style="color:var(--red)">-${r.currency || ''} ${fmtMoney(r.discount_amount)}</td>
      <td style="color:var(--green);font-weight:600">${r.currency || ''} ${fmtMoney(r.final_amount)}</td>
      <td style="font-size:11px;color:var(--muted2)">${esc(r.ip_address || '—')}</td>
      <td>${new Date(r.created_at).toLocaleDateString()}</td>
      <td><span class="badge ${bc}">${r.status}</span></td>
    </tr>`;
  }).join('');

  updatePagerRedemption(data.pagination);
}

function updatePagerRedemption(pagination) {
  const pg = pagination?.page || P.redemption || 1;
  const total = pagination?.total || 0;
  const limit = pagination?.limit || 20;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const info = document.getElementById('redemptionPageInfo');
  const prev = document.getElementById('redemptionPrev');
  const next = document.getElementById('redemptionNext');
  if (info) info.textContent = `Page ${pg} of ${totalPages}`;
  if (prev) prev.disabled = pg <= 1;
  if (next) next.disabled = pg >= totalPages;
}

/* ── OPEN PROMO CODE MODAL ── */
function openPromoCodeModal(codeData) {
  const modal = document.getElementById('promoModal');
  const title = document.getElementById('promoModalTitle');
  const editId = document.getElementById('editPromoId');
  
  // Reset form
  document.getElementById('pc_name').value = '';
  document.getElementById('pc_code').value = '';
  document.getElementById('pc_desc').value = '';
  document.getElementById('pc_type').value = 'percentage_discount';
  document.getElementById('pc_percent').value = '';
  document.getElementById('pc_fixed_amount').value = '';
  document.getElementById('pc_trial_days').value = '';
  document.getElementById('pc_max_uses').value = '';
  document.getElementById('pc_per_user').value = '1';
  document.getElementById('pc_valid_until').value = '';
  document.getElementById('pc_valid_from').value = '';
  document.getElementById('pc_valid_until2').value = '';
  document.getElementById('pc_min_purchase').value = '0';
  document.getElementById('pc_max_discount').value = '';
  document.getElementById('pc_stackable').value = 'false';
  document.getElementById('pc_auto_apply').value = 'false';
  document.getElementById('pc_is_active').value = 'true';
  document.getElementById('pc_notes').value = '';
  document.querySelectorAll('#advancedSection input[type=checkbox]').forEach(cb => cb.checked = true);
  
  // Load plans
  loadPlansIntoSelect('pc_plan_id');
  
  if (codeData) {
    // Edit mode
    editId.value = codeData.id;
    title.textContent = 'Edit Promotion Code';
    document.getElementById('pc_name').value = codeData.name;
    document.getElementById('pc_code').value = codeData.code;
    document.getElementById('pc_desc').value = codeData.description || '';
    document.getElementById('pc_type').value = codeData.type;
    document.getElementById('pc_percent').value = codeData.discount_percent || '';
    document.getElementById('pc_fixed_amount').value = codeData.discount_amount || '';
    document.getElementById('pc_fixed_currency').value = codeData.discount_currency || 'INR';
    document.getElementById('pc_trial_days').value = codeData.free_trial_days || '';
    document.getElementById('pc_max_uses').value = codeData.max_uses || '';
    document.getElementById('pc_per_user').value = codeData.per_user_limit || '1';
    document.getElementById('pc_min_purchase').value = codeData.min_purchase_amount || '0';
    document.getElementById('pc_max_discount').value = codeData.max_discount_amount || '';
    document.getElementById('pc_stackable').value = codeData.stackable ? 'true' : 'false';
    document.getElementById('pc_auto_apply').value = codeData.auto_apply ? 'true' : 'false';
    document.getElementById('pc_is_active').value = codeData.is_active ? 'true' : 'false';
    document.getElementById('pc_notes').value = codeData.internal_notes || '';
    
    if (codeData.valid_from) {
      const d = new Date(codeData.valid_from);
      document.getElementById('pc_valid_from').value = d.toISOString().slice(0, 16);
      document.getElementById('pc_valid_until').value = d.toISOString().slice(0, 16);
    }
    if (codeData.valid_until) {
      const d = new Date(codeData.valid_until);
      document.getElementById('pc_valid_until2').value = d.toISOString().slice(0, 16);
    }
    
    if (codeData.billing_cycles) {
      document.querySelectorAll('#advancedSection input[type=checkbox]').forEach(cb => {
        cb.checked = codeData.billing_cycles.includes(cb.value);
      });
    }
    
    if (codeData.plan_id) {
      document.getElementById('pc_plan_id').value = codeData.plan_id;
    }
  } else {
    editId.value = '';
    title.textContent = 'Create Promotion Code';
  }
  
  onPromoTypeChange(document.getElementById('pc_type').value);
  modal.classList.add('open');
}

/* ── SAVE PROMO CODE ── */
async function savePromoCode() {
  const editId = document.getElementById('editPromoId').value;
  const billingCycles = [];
  document.querySelectorAll('#advancedSection input[type=checkbox]:checked').forEach(cb => billingCycles.push(cb.value));
  
  const body = {
    name: document.getElementById('pc_name').value.trim(),
    code: document.getElementById('pc_code').value.trim(),
    description: document.getElementById('pc_desc').value.trim(),
    type: document.getElementById('pc_type').value,
    discountPercent: parseFloat(document.getElementById('pc_percent').value) || undefined,
    discountAmount: parseFloat(document.getElementById('pc_fixed_amount').value) || undefined,
    discountCurrency: document.getElementById('pc_fixed_currency')?.value || 'INR',
    freeTrialDays: parseInt(document.getElementById('pc_trial_days').value) || undefined,
    planId: parseInt(document.getElementById('pc_plan_id').value) || null,
    billingCycles: billingCycles,
    maxUses: parseInt(document.getElementById('pc_max_uses').value) || null,
    perUserLimit: parseInt(document.getElementById('pc_per_user').value) || null,
    minPurchaseAmount: parseFloat(document.getElementById('pc_min_purchase').value) || 0,
    maxDiscountAmount: parseFloat(document.getElementById('pc_max_discount').value) || null,
    validFrom: document.getElementById('pc_valid_from').value || undefined,
    validUntil: document.getElementById('pc_valid_until2').value || null,
    isActive: document.getElementById('pc_is_active').value === 'true',
    stackable: document.getElementById('pc_stackable').value === 'true',
    autoApply: document.getElementById('pc_auto_apply').value === 'true',
    internalNotes: document.getElementById('pc_notes').value.trim(),
  };
  
  if (!body.name) { toast('Name is required'); return; }
  if (!body.code) { toast('Code is required'); return; }
  
  if (editId) {
    body.action = 'update';
    body.id = parseInt(editId);
  } else {
    body.action = 'create';
  }
  
  const res = await api('/api/promotions', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  
  if (!res) return;
  const data = await res.json();
  
  if (!res.ok) {
    toast(data.error || 'Failed to save promo code');
    return;
  }
  
  toast(editId ? 'Promotion code updated' : 'Promotion code created');
  closeModal('promoModal');
  loadPromoCodes(P.promo);
}

/* ── EDIT, TOGGLE, DUPLICATE, DELETE ── */
async function editPromoCode(id) {
  const res = await api('/api/promotions', {
    method: 'POST',
    body: JSON.stringify({ action: 'list', page: 1, limit: 100 })
  });
  if (!res) return;
  const data = await res.json();
  const code = data.codes?.find(c => c.id === id);
  if (code) openPromoCodeModal(code);
}

async function togglePromoCode(id) {
  const res = await api('/api/promotions', {
    method: 'POST',
    body: JSON.stringify({ action: 'toggle', id })
  });
  if (!res) return;
  const data = await res.json();
  toast(data.message || 'Toggled');
  loadPromoCodes(P.promo);
}

async function duplicatePromoCode(id) {
  const res = await api('/api/promotions', {
    method: 'POST',
    body: JSON.stringify({ action: 'duplicate', id })
  });
  if (!res) return;
  const data = await res.json();
  if (res.ok) {
    toast('Duplicated! The new code is inactive by default.');
    loadPromoCodes(P.promo);
  } else {
    toast(data.error || 'Failed to duplicate');
  }
}

async function deletePromoCode(id) {
  if (!confirm('Delete this promo code permanently? This cannot be undone.')) return;
  const res = await api('/api/promotions', {
    method: 'POST',
    body: JSON.stringify({ action: 'delete', id })
  });
  if (!res) return;
  toast('Promotion code deleted');
  loadPromoCodes(P.promo);
}

/* ── HELPERS ── */
async function loadPlansIntoSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">All Plans</option>';
  try {
    const res = await api('/api/shop?action=admin-plans');
    if (!res) return;
    const data = await res.json();
    (data.plans || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.display_name || p.name;
      sel.appendChild(opt);
    });
  } catch(e) { /* ok */ }
}

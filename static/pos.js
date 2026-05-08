// pos.js — Supervisor POS
'use strict';

// GPS unavailable on plain HTTP (browser security policy)
const _gpsUnavailable = !('geolocation' in navigator)
  || (location.protocol === 'http:' && location.hostname !== 'localhost');

const state = {
  staff: null,
  customer: null,
  cart: [],
  products: [],
  drivers: [],
  paymentMethods: [],
  fees: [],
  tareRate: 5,
  allCustomers: [],
  view: 'map',          // 'map' | 'list'
  pollingTimer: null,
  assignTarget: null,
  cancelTarget: null,
  pinBuffer: '',
  map: null,
  mapPins: [],
  kanbanData: {},
  activeBrand: 'ทั้งหมด',
  locateDot: null,
};

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Set date chip to today
  const chipDate = document.getElementById('chip-date');
  if (chipDate) {
    const now = new Date();
    chipDate.value = now.toISOString().slice(0, 10);
  }
  await loadStaffList();
  await checkSession();
  startClock();
});

async function loadStaffList() {
  try {
    const res  = await fetch('/api/auth/staff?role=supervisor,admin', { credentials: 'same-origin' });
    const data = await res.json();
    const sel  = document.getElementById('staff-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- เลือกชื่อ --</option>'
      + (data.staff || []).map(s =>
          '<option value="' + s.id + '">' + s.name + ' (' + s.role + ')</option>'
        ).join('');
  } catch (e) { console.warn('loadStaffList', e); }
}

async function checkSession() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      if (data.staff && ['supervisor','admin'].includes(data.staff.role)) {
        state.staff = data.staff;
        await initApp();
      }
    }
  } catch (e) { /* not logged in */ }
}

// ── PIN Login ────────────────────────────────────────────────

function pinPress(digit) {
  if (state.pinBuffer.length >= 4) return;
  state.pinBuffer += digit;
  renderPinBoxes();
  if (state.pinBuffer.length === 4) setTimeout(pinSubmit, 180);
}

function pinBack() {
  if (!state.pinBuffer.length) return;
  state.pinBuffer = state.pinBuffer.slice(0, -1);
  renderPinBoxes();
  document.getElementById('login-error').textContent = '';
}

function renderPinBoxes() {
  for (let i = 0; i < 4; i++) {
    const box = document.getElementById('pin-box-' + i);
    if (!box) continue;
    box.textContent = i < state.pinBuffer.length ? '●' : '';
    box.classList.toggle('filled', i < state.pinBuffer.length);
    box.classList.toggle('focused', i === state.pinBuffer.length);
  }
  const btn = document.getElementById('btn-login');
  if (btn) btn.disabled = state.pinBuffer.length < 4;
}

async function pinSubmit() {
  if (!state.pinBuffer) return;
  const staffSel = document.getElementById('staff-select');
  const staffId  = staffSel ? staffSel.value : '';
  const errEl    = document.getElementById('login-error');

  if (!staffId) {
    errEl.textContent = 'กรุณาเลือกชื่อก่อน';
    state.pinBuffer = ''; renderPinBoxes(); return;
  }

  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ staff_id: staffId, pin: state.pinBuffer }),
    });
    const data = await res.json();

    if (res.status === 423) {
      const mins = Math.ceil((data.locked_seconds || 900) / 60);
      errEl.textContent = 'ล็อคอีก ' + mins + ' นาที';
      state.pinBuffer = ''; renderPinBoxes(); return;
    }
    if (res.ok && data.staff) {
      state.staff     = data.staff;
      state.pinBuffer = '';
      renderPinBoxes();
      await initApp();
    } else {
      errEl.textContent = data.error || 'PIN ไม่ถูกต้อง';
      state.pinBuffer = ''; renderPinBoxes();
    }
  } catch (e) {
    errEl.textContent = 'เชื่อมต่อไม่ได้';
    state.pinBuffer = ''; renderPinBoxes();
  }
}

// ── App Init ─────────────────────────────────────────────────

async function initApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  const avatar = document.getElementById('topbar-avatar');
  if (avatar && state.staff) {
    avatar.textContent = (state.staff.name || 'S').substring(0, 2).toUpperCase();
    avatar.title = state.staff.name + ' — คลิกเพื่อออก';
  }

  await Promise.all([
    loadProducts(),
    loadDrivers(),
    loadPaymentMethods(),
    loadFees(),
    loadTareRate(),
    loadPhoneBook(),
  ]);
  await loadKanban();
  initMap();
  setView('map');
  state.pollingTimer = setInterval(loadKanban, 5000);

  // keyboard shortcuts
  document.addEventListener('keydown', handleKey);
}

async function loadTareRate() {
  try {
    const res = await fetch('/api/supervisor/tare-rate', { credentials: 'same-origin' });
    if (res.ok) { const d = await res.json(); state.tareRate = d.rate_per_kg || 5; }
  } catch (e) { /* use default */ }
}

async function logout() {
  clearInterval(state.pollingTimer);
  // Clear all secondary polling timers (cash screen, etc.)
  if (state._csRefreshTimer) { clearInterval(state._csRefreshTimer); state._csRefreshTimer = null; }
  // Close any open overlays so they don't keep polling/showing after logout
  if (typeof closeAllOverlays === 'function') closeAllOverlays();
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (e) { /* ignore */ }
  state.staff    = null;
  state.customer = null;
  state.cart     = [];
  state.pinBuffer = '';
  renderPinBoxes();
  document.getElementById('app').style.display           = 'none';
  document.getElementById('login-screen').style.display  = 'flex';
  document.getElementById('login-error').textContent     = '';
  document.getElementById('cust-phone').value            = '';
  document.getElementById('customer-card').style.display = 'none';
  document.getElementById('phone-empty').style.display   = '';
  document.removeEventListener('keydown', handleKey);
}

// ── Clock ─────────────────────────────────────────────────────

function startClock() {
  updateClock();
  setInterval(updateClock, 30000);
}

function updateClock() {
  const el = document.getElementById('status-clock');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) +
    ' · ' + now.toLocaleDateString('th-TH', { month: 'short', day: 'numeric' });
}

// ── View Toggle ───────────────────────────────────────────────

function setView(v) {
  state.view = v;
  const mapPane    = document.getElementById('map-pane');
  const kanbanPane = document.getElementById('kanban-pane');
  const pillMap    = document.getElementById('pill-map');
  const pillList   = document.getElementById('pill-list');

  if (v === 'map') {
    mapPane.style.display    = '';
    kanbanPane.style.display = 'none';
    pillMap.classList.add('active');
    pillList.classList.remove('active');
    if (state.map) setTimeout(() => state.map.invalidateSize(), 50);
  } else {
    mapPane.style.display    = 'none';
    kanbanPane.style.display = '';
    pillMap.classList.remove('active');
    pillList.classList.add('active');
    renderAllKanbanCols();
  }
}

// ── Map ───────────────────────────────────────────────────────

function initMap() {
  if (state.map) return;
  const container = document.getElementById('map-container');
  if (!container || typeof L === 'undefined') return;

  // Fix default icon paths for local Leaflet
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl:      '/static/images/marker-icon.png',
    iconRetinaUrl:'/static/images/marker-icon-2x.png',
    shadowUrl:    '/static/images/marker-shadow.png',
  });

  state.map = L.map('map-container', { zoomControl: false }).setView([16.42, 101.15], 13);
  L.control.zoom({ position: 'bottomright' }).addTo(state.map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
  }).addTo(state.map);

  state.map.on('click', closePopover);

  // Auto-fly to current location on open (like Google Maps)
  if (!_gpsUnavailable) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        state.map.flyTo([lat, lng], 14, { duration: 1.5 });
        if (state.locateDot) state.locateDot.remove();
        state.locateDot = L.circleMarker([lat, lng], {
          radius: 8, color: '#2563eb', fillColor: '#2563eb',
          fillOpacity: 0.9, weight: 2,
        }).addTo(state.map);
      },
      () => {},  // silent on auto-locate failure — user can press locate button manually
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }
}

function renderMapPins() {
  if (!state.map) return;
  state.mapPins.forEach(m => m.remove());
  state.mapPins = [];

  const showPending    = document.getElementById('fp-show-pending')?.checked !== false;
  const showDelivering = document.getElementById('fp-show-delivering')?.checked !== false;
  const showCompleted  = document.getElementById('fp-show-completed')?.checked;
  const showCancelled  = document.getElementById('fp-show-cancelled')?.checked;
  const driverFilter   = document.getElementById('fp-driver')?.value || '';

  const statusFilter = [];
  if (showPending)    statusFilter.push('pending', 'preparing');
  if (showDelivering) statusFilter.push('delivering');
  if (showCompleted)  statusFilter.push('completed');
  if (showCancelled)  statusFilter.push('cancelled');

  const allOrders = [
    ...(state.kanbanData.pending    || []),
    ...(state.kanbanData.preparing  || []),
    ...(state.kanbanData.delivering || []),
    ...(state.kanbanData.completed  || []),
    ...(state.kanbanData.cancelled  || []),
  ];

  let cntP = 0, cntD = 0, cntC = 0, cntX = 0;
  allOrders.forEach(o => {
    if (o.status === 'pending' || o.status === 'preparing') cntP++;
    else if (o.status === 'delivering') cntD++;
    else if (o.status === 'completed') cntC++;
    else if (o.status === 'cancelled') cntX++;
  });
  const fpP = document.getElementById('fp-cnt-pending');
  const fpD = document.getElementById('fp-cnt-delivering');
  const fpC = document.getElementById('fp-cnt-completed');
  const fpX = document.getElementById('fp-cnt-cancelled');
  if (fpP) fpP.textContent = '(' + cntP + ')';
  if (fpD) fpD.textContent = '(' + cntD + ')';
  if (fpC) fpC.textContent = '(' + cntC + ')';
  if (fpX) fpX.textContent = '(' + cntX + ')';

  allOrders.forEach(o => {
    if (!statusFilter.includes(o.status)) return;
    if (driverFilter && o.driver_id !== driverFilter) return;
    if (!o.lat || !o.lng) return;

    const pinClass = o.status === 'completed' ? 'pin-completed'
      : o.status === 'delivering' ? 'pin-delivering'
      : o.status === 'cancelled' ? 'pin-cancelled' : 'pin-pending';
    const icon = L.divIcon({
      className: '',
      html: '<div class="map-pin ' + pinClass + '"><div class="map-pin-inner">' +
            (o.order_num || '').slice(-3) + '</div></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 30],
    });

    const marker = L.marker([o.lat, o.lng], { icon }).addTo(state.map);
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      showPopover(o, e.containerPoint);
    });
    state.mapPins.push(marker);
  });
}

function showPopover(order, point) {
  const pop = document.getElementById('pin-popover');
  if (!pop) return;

  document.getElementById('pop-num').textContent  = order.order_num || '';
  document.getElementById('pop-cust').textContent = order.cust_name || 'ลูกค้า';

  const dot = document.getElementById('pop-status-dot');
  if (dot) {
    dot.className = 'sdot ' + (order.status === 'delivering' ? 'sdot-green'
      : order.status === 'completed' ? 'sdot-blue'
      : order.status === 'cancelled' ? 'sdot-red' : 'sdot-amber');
  }

  const items = Array.isArray(order.items_json)
    ? order.items_json.map(i => i.name + ' ×' + i.qty).join(', ')
    : order.items_summary || '';
  document.getElementById('pop-items').textContent = items;
  document.getElementById('pop-amount').textContent = '฿' + (order.total || 0).toLocaleString();
  document.getElementById('pop-pay').textContent    = order.payment_method || '';

  // Driver line
  const driverEl = document.getElementById('pop-driver');
  if (driverEl) {
    driverEl.textContent = order.driver_name ? '🚚 ' + order.driver_name : '';
    driverEl.style.display = order.driver_name ? '' : 'none';
  }

  // Timing lines
  const timingEl = document.getElementById('pop-timing');
  if (timingEl) {
    const fmtTime = (ts) => ts ? ts.slice(11, 16) : null;
    const parts = [];
    if (order.created_at)   parts.push('สั่ง ' + fmtTime(order.created_at));
    if (order.started_at)   parts.push('เริ่มส่ง ' + fmtTime(order.started_at));
    if (order.delivered_at) parts.push('ส่งแล้ว ' + fmtTime(order.delivered_at));
    timingEl.textContent = parts.join(' · ');
    timingEl.style.display = parts.length ? '' : 'none';
  }

  // Complete button (delivering only — supervisor override)
  const completeBtn = document.getElementById('pop-complete');
  if (completeBtn) {
    if (order.status === 'delivering') {
      completeBtn.style.display = '';
      completeBtn.onclick = () => completeOrder(order.order_num);
    } else {
      completeBtn.style.display = 'none';
    }
  }

  // Dispatch button (pending / preparing)
  const dispatchBtn = document.getElementById('pop-dispatch');
  if (dispatchBtn) {
    if (order.status === 'pending' || order.status === 'preparing') {
      dispatchBtn.style.display = '';
      dispatchBtn.onclick = () => { closePopover(); openAssignModal(order.order_num); };
      dispatchBtn.textContent = 'จัดส่ง →';
    } else {
      dispatchBtn.style.display = 'none';
    }
  }

  const mapContainer = document.getElementById('map-container');
  const rect = mapContainer.getBoundingClientRect();
  let left = point.x - 120;
  let top  = point.y - pop.offsetHeight - 16;
  if (left < 4) left = 4;
  if (left + 260 > rect.width) left = rect.width - 264;
  if (top < 4) top = point.y + 12;

  pop.style.left    = left + 'px';
  pop.style.top     = top + 'px';
  pop.style.display = 'block';
}

function closePopover() {
  const pop = document.getElementById('pin-popover');
  if (pop) pop.style.display = 'none';
}

function centerMap() {
  if (!state.map) return;
  const allOrders = [
    ...(state.kanbanData.pending    || []),
    ...(state.kanbanData.delivering || []),
  ].filter(o => o.lat && o.lng);
  if (allOrders.length) {
    const bounds = allOrders.map(o => [o.lat, o.lng]);
    state.map.fitBounds(bounds, { padding: [40, 40] });
  }
}

function mapLocate() {
  if (!state.map) return;
  const btn = document.getElementById('map-locate-btn');
  if (_gpsUnavailable) {
    showToast('GPS ต้องการ HTTPS — ลากแผนที่เพื่อดูตำแหน่ง', 'error');
    return;
  }
  if (!navigator.geolocation) { showToast('เบราว์เซอร์ไม่รองรับ GPS', 'error'); return; }
  if (btn) btn.classList.add('map-ctrl-locating');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      state.map.flyTo([lat, lng], 15, { duration: 1.2 });
      if (btn) btn.classList.remove('map-ctrl-locating');
      // Show a temporary blue dot for current position
      if (state.locateDot) state.locateDot.remove();
      state.locateDot = L.circleMarker([lat, lng], {
        radius: 8, color: '#2563eb', fillColor: '#2563eb',
        fillOpacity: 0.9, weight: 2,
      }).addTo(state.map).bindPopup('ตำแหน่งของคุณ').openPopup();
    },
    (err) => {
      if (btn) btn.classList.remove('map-ctrl-locating');
      showToast('ระบุตำแหน่งไม่ได้: ' + err.message, 'error');
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function toggleFilterPanel() {
  const body = document.getElementById('fp-body');
  if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
}

// ── Products ─────────────────────────────────────────────────

async function loadProducts() {
  try {
    const res = await fetch('/api/customer/products', { credentials: 'same-origin' });
    state.products = await res.json();
  } catch (e) { showToast('โหลดสินค้าไม่ได้', 'error'); }
}

function renderBrandTabs() {
  const brands = ['ทั้งหมด', ...new Set(state.products.map(p => p.brand).filter(Boolean))];
  const container = document.getElementById('brand-tabs');
  if (!container) return;
  container.innerHTML = brands.map((b, i) =>
    '<button class="brand-tab' + (b === (state.activeBrand || 'ทั้งหมด') ? ' active' : '') + '" ' +
    'onclick="selectBrand(\'' + b + '\',this)">' + b + '</button>'
  ).join('');
}

function selectBrand(brand, el) {
  document.querySelectorAll('.brand-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  state.activeBrand = brand;
  renderProducts();
}

function filterProducts() { renderProducts(); }

function renderProducts() {
  const q     = (document.getElementById('product-search')?.value || '').toLowerCase();
  const brand = state.activeBrand || 'ทั้งหมด';
  let list    = state.products;
  if (brand !== 'ทั้งหมด') list = list.filter(p => p.brand === brand);
  if (q) list = list.filter(p => p.name.toLowerCase().includes(q) ||
    (p.brand || '').toLowerCase().includes(q));

  const container = document.getElementById('product-list');
  if (!container) return;
  if (!list.length) {
    container.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-disabled);padding:20px;font-size:0.85rem">ไม่พบสินค้า</div>';
    return;
  }
  container.innerHTML = list.map(p => {
    const stock = p.full_qty || 0;
    const isOut = stock === 0;
    return '<div class="product-card' + (isOut ? ' out' : '') + '" ' +
      'onclick="' + (isOut ? '' : 'addToCart(\'' + p.id + '\')') + '">' +
      '<div class="prod-icon">' + (p.ico || '🔵') + '</div>' +
      '<div class="prod-name">' + p.name + '</div>' +
      '<div class="prod-price">฿' + p.price.toLocaleString() + '</div>' +
      '<div class="prod-stock">เต็ม: ' + stock + '</div>' +
      '</div>';
  }).join('');
}

// ── Cart ─────────────────────────────────────────────────────

function addToCart(productId) {
  const prod = state.products.find(p => p.id === productId);
  if (!prod) return;
  if ((prod.full_qty || 0) === 0) { showToast('สินค้าหมด', 'error'); return; }
  const existing = state.cart.find(i => i.product_id === productId);
  if (existing) {
    existing.qty++;
    existing.line_total = existing.unit_price * existing.qty;
  } else {
    state.cart.push({
      product_id: productId, name: prod.name, brand: prod.brand || '',
      size_kg: prod.size_kg, qty: 1,
      unit_price: prod.price, line_total: prod.price,
    });
  }
  renderCart();
}

function changeQty(productId, delta) {
  const item = state.cart.find(i => i.product_id === productId);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) state.cart = state.cart.filter(i => i.product_id !== productId);
  else item.line_total = item.unit_price * item.qty;
  renderCart();
}

function removeFromCart(productId) {
  state.cart = state.cart.filter(i => i.product_id !== productId);
  renderCart();
}

function clearCart() {
  state.cart     = [];
  state.customer = null;
  const phoneEl = document.getElementById('cust-phone');
  if (phoneEl) phoneEl.value = '';
  document.getElementById('customer-card').style.display = 'none';
  document.getElementById('phone-empty').style.display   = 'none';
  renderPhoneBook('');
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cart-items');
  if (!container) return;
  if (!state.cart.length) {
    container.innerHTML = '<div style="color:var(--text-disabled);font-size:0.82rem;padding:8px 0">เลือกสินค้าจากซ้าย</div>';
    const ct = document.getElementById('cart-totals');
    if (ct) ct.innerHTML = '';
    const bc = document.getElementById('btn-charge');
    if (bc) bc.disabled = true;
    return;
  }
  const bc2 = document.getElementById('btn-charge');
  if (bc2) bc2.disabled = false;
  container.innerHTML = state.cart.map(item =>
    '<div class="cart-item">' +
    '<span class="cart-item-name">' + item.name + '</span>' +
    '<div class="cart-item-qty">' +
    '<button class="cart-qty-btn" onclick="changeQty(\'' + item.product_id + '\',-1)">−</button>' +
    '<span style="min-width:20px;text-align:center">' + item.qty + '</span>' +
    '<button class="cart-qty-btn" onclick="changeQty(\'' + item.product_id + '\',1)">+</button>' +
    '</div>' +
    '<span class="cart-item-price">฿' + item.line_total.toLocaleString() + '</span>' +
    '</div>'
  ).join('');
  renderTotals();
}

function renderTotals() {
  const subtotal  = state.cart.reduce((s, i) => s + i.line_total, 0);
  const orderType = document.getElementById('order-type')?.value || 'walkin';
  let feesTotal   = 0, feesHtml = '';
  if (orderType === 'delivery') {
    for (const fee of state.fees) {
      let amt = fee.amount;
      if (fee.type === 'percent') amt = Math.round(subtotal * fee.amount / 100);
      if (fee.condition_type === 'floor') {
        try { if (subtotal >= parseFloat(fee.condition_value)) continue; } catch (e) {}
      }
      feesTotal += amt;
      feesHtml  += '<div class="total-row"><span>' + fee.name + '</span>' +
        '<span>+฿' + amt.toLocaleString() + '</span></div>';
    }
  }
  const total = subtotal + feesTotal;
  const vat   = Math.round(total * 7 / 107);
  const base  = total - vat;
  const ct = document.getElementById('cart-totals');
  if (ct) ct.innerHTML =
    '<div class="total-row"><span>รวมสินค้า</span><span>฿' + subtotal.toLocaleString() + '</span></div>' +
    feesHtml +
    '<div class="total-row grand"><span>รวมทั้งหมด</span><span>฿' + total.toLocaleString() + '</span></div>' +
    '<div style="font-size:0.72rem;color:var(--text-disabled);padding-top:4px">' +
    'ก่อนภาษี ฿' + base.toLocaleString() + ' + VAT ฿' + vat.toLocaleString() + '</div>';
  state._lastTotal     = total;
  state._lastSubtotal  = subtotal;
  state._lastFeesTotal = feesTotal;
}

// ── New Order Modal ───────────────────────────────────────────

function openNewOrderModal() { openOrderScreen(); }

// ── Customer Lookup ───────────────────────────────────────────

function onPhoneInput() {
  const raw = document.getElementById('cust-phone').value;
  document.getElementById('name-search-results').style.display = 'none';

  if (raw === '') {
    // Field cleared → restore phone book, hide customer card
    document.getElementById('customer-card').style.display = 'none';
    state.customer = null;
    renderPhoneBook('');
    return;
  }

  if (/^\d+$/.test(raw)) {
    // Digits only → hide phone book, trigger phone lookup at 10 digits
    const pbl = document.getElementById('phone-book-list');
    if (pbl) pbl.style.display = 'none';
    document.getElementById('phone-empty').style.display = 'none';
    if (raw.length === 10) lookupCustomer();
  } else {
    // Text → filter phone book client-side + debounced server search
    renderPhoneBook(raw.trim());
    if (raw.trim().length >= 2) {
      clearTimeout(_nameSearchTimer);
      _nameSearchTimer = setTimeout(() => doNameSearch(raw.trim()), 280);
    }
  }
}

function onCustSearchKey(e) {
  const results = document.getElementById('name-search-results');
  if (results && results.style.display !== 'none') {
    const items = results.querySelectorAll('.ns-item');
    const active = results.querySelector('.ns-item.ns-active');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? (active.nextElementSibling || items[0]) : items[0];
      if (active) active.classList.remove('ns-active');
      if (next) next.classList.add('ns-active');
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active ? (active.previousElementSibling || items[items.length - 1]) : items[items.length - 1];
      if (active) active.classList.remove('ns-active');
      if (prev) prev.classList.add('ns-active');
      return;
    }
    if (e.key === 'Enter' && active) { e.preventDefault(); active.click(); return; }
    if (e.key === 'Escape') { results.style.display = 'none'; return; }
  }
  if (e.key === 'Enter') lookupCustomer();
}

async function lookupCustomer() {
  const phone = document.getElementById('cust-phone').value.trim();
  if (!phone) return;
  try {
    const res  = await fetch('/api/supervisor/customers/search?q=' + encodeURIComponent(phone),
      { credentials: 'same-origin' });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();

    document.getElementById('customer-card').style.display = '';
    document.getElementById('phone-empty').style.display   = 'none';
    const _pbl = document.getElementById('phone-book-list');
    if (_pbl) _pbl.style.display = 'none';

    if (data.length > 0) {
      const c = data[0];
      state.customer = c;
      document.getElementById('cust-name-display').textContent  = c.name;
      document.getElementById('cust-phone-disp').textContent    = phone;
      document.getElementById('cust-tier-display').textContent  = c.tier || 'retail';

      // credit bar
      const creditBar = document.getElementById('cust-credit-bar');
      if (c.credit_limit > 0) {
        creditBar.style.display = '';
        document.getElementById('cust-credit-val').textContent = '฿' + (c.credit_bal || 0).toLocaleString() + ' / ฿' + c.credit_limit.toLocaleString();
        const pct = Math.min(100, Math.round((c.credit_bal || 0) / c.credit_limit * 100));
        document.getElementById('cust-credit-fill').style.width = pct + '%';
      } else {
        creditBar.style.display = 'none';
      }

      // last order
      const lastSec = document.getElementById('last-order-section');
      if (c.last_order_items && c.last_order_items.length) {
        lastSec.style.display = '';
        document.getElementById('last-order-items').textContent =
          c.last_order_items.map(i => i.name + ' x' + i.qty).join(', ');
        document.getElementById('btn-repeat').style.display = '';
      } else {
        lastSec.style.display = 'none';
        document.getElementById('btn-repeat').style.display = 'none';
      }
    } else {
      state.customer = { phone, name: 'ลูกค้าใหม่' };
      document.getElementById('cust-name-display').textContent  = 'ลูกค้าใหม่';
      document.getElementById('cust-phone-disp').textContent    = phone;
      document.getElementById('cust-tier-display').textContent  = 'retail';
      document.getElementById('cust-credit-bar').style.display  = 'none';
      document.getElementById('last-order-section').style.display = 'none';
      document.getElementById('btn-repeat').style.display         = 'none';
    }
  } catch (e) {
    showToast('ค้นหาลูกค้าไม่ได้', 'error');
  }
}

// ── Phone Book ───────────────────────────────────────────────

async function loadPhoneBook() {
  try {
    const res  = await fetch('/api/supervisor/customers/search?q=', { credentials: 'same-origin' });
    if (!res.ok) return;
    state.allCustomers = await res.json();
    renderPhoneBook('');
  } catch (e) { console.warn('loadPhoneBook', e); }
}

function renderPhoneBook(filter) {
  const listEl  = document.getElementById('phone-book-list');
  const emptyEl = document.getElementById('phone-empty');
  if (!listEl) return;
  const f = (filter || '').toLowerCase();
  const customers = f
    ? state.allCustomers.filter(c =>
        (c.name || '').toLowerCase().includes(f) || (c.phone || '').includes(f))
    : state.allCustomers;
  if (!customers.length) {
    listEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  listEl.style.display = '';
  listEl.innerHTML = customers.map(c => {
    const idx  = state.allCustomers.findIndex(x => x.id === c.id);
    const init = (c.name || '?').slice(0, 2);
    return '<div class="pb-item" onclick="phoneBookSelectIdx(' + idx + ')">' +
      '<div class="pb-avatar">' + init + '</div>' +
      '<div><div class="pb-name">' + (c.name || '') + '</div>' +
      '<div class="pb-phone">' + (c.phone || '') + '</div></div>' +
      '</div>';
  }).join('');
}

function phoneBookSelectIdx(idx) {
  const c = state.allCustomers[idx];
  if (!c) return;
  document.getElementById('cust-phone').value = c.phone || '';
  applyCustomerData(c);
}

function togglePhonePane() {
  const pane = document.getElementById('phone-pane');
  if (pane) pane.classList.toggle('pane-open');
}

// ── Customer Name Search ─────────────────────────────────────

let _nameSearchTimer   = null;
let _nameSearchResults = [];

function onNameSearchInput() {
  clearTimeout(_nameSearchTimer);
  const q = document.getElementById('cust-phone').value.trim();
  if (q.length < 2) {
    document.getElementById('name-search-results').style.display = 'none';
    return;
  }
  _nameSearchTimer = setTimeout(() => doNameSearch(q), 280);
}

function onNameSearchKey(e) {
  const results = document.getElementById('name-search-results');
  const items = results.querySelectorAll('.ns-item');
  if (!items.length) return;
  const active = results.querySelector('.ns-item.ns-active');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = active ? (active.nextElementSibling || items[0]) : items[0];
    if (active) active.classList.remove('ns-active');
    next.classList.add('ns-active');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = active ? (active.previousElementSibling || items[items.length - 1]) : items[items.length - 1];
    if (active) active.classList.remove('ns-active');
    prev.classList.add('ns-active');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (active) active.click();
  } else if (e.key === 'Escape') {
    results.style.display = 'none';
  }
}

async function doNameSearch(q) {
  try {
    const res  = await fetch('/api/supervisor/customers/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' });
    const data = await res.json();
    showNameResults(data);
  } catch (e) {}
}

function showNameResults(customers) {
  _nameSearchResults = customers;
  const box = document.getElementById('name-search-results');
  if (!customers.length) { box.style.display = 'none'; return; }
  box.innerHTML = customers.map((c, i) =>
    '<div class="ns-item" onclick="selectNameResultIdx(' + i + ')">' +
    '<span class="ns-name">' + (c.name || '') + '</span>' +
    '<span class="ns-phone">' + (c.phone || '') + '</span>' +
    '</div>'
  ).join('');
  box.style.display = '';
}

function selectNameResultIdx(i) {
  const c = _nameSearchResults[i];
  if (!c) return;
  document.getElementById('name-search-results').style.display = 'none';
  document.getElementById('cust-phone').value = c.phone || '';
  applyCustomerData(c);
}

function applyCustomerData(c) {
  state.customer = c;
  document.getElementById('customer-card').style.display = '';
  document.getElementById('phone-empty').style.display   = 'none';
  const _pbl2 = document.getElementById('phone-book-list');
  if (_pbl2) _pbl2.style.display = 'none';
  document.getElementById('cust-name-display').textContent = c.name || 'ลูกค้า';
  document.getElementById('cust-phone-disp').textContent   = c.phone || '';
  document.getElementById('cust-tier-display').textContent = c.tier || 'retail';
  const creditBar = document.getElementById('cust-credit-bar');
  if (c.credit_limit > 0) {
    creditBar.style.display = '';
    document.getElementById('cust-credit-val').textContent = '฿' + (c.credit_bal || 0).toLocaleString() + ' / ฿' + c.credit_limit.toLocaleString();
    const pct = Math.min(100, Math.round((c.credit_bal || 0) / c.credit_limit * 100));
    document.getElementById('cust-credit-fill').style.width = pct + '%';
  } else { creditBar.style.display = 'none'; }
  const lastSec = document.getElementById('last-order-section');
  if (c.last_order_items && c.last_order_items.length) {
    lastSec.style.display = '';
    document.getElementById('last-order-items').textContent =
      c.last_order_items.map(i => i.name + ' x' + i.qty).join(', ');
    document.getElementById('btn-repeat').style.display = '';
  } else {
    lastSec.style.display = 'none';
    document.getElementById('btn-repeat').style.display = 'none';
  }
}

function quickRepeatOrder() {
  if (!state.customer?.last_order_items?.length) return;
  state.cart = [];
  for (const item of state.customer.last_order_items) {
    const prod = state.products.find(p => p.id === item.product_id);
    if (prod) {
      state.cart.push({
        product_id: item.product_id,
        name: item.name || prod.name,
        brand: item.brand || prod.brand || '',
        size_kg: item.size_kg || prod.size_kg,
        qty: item.qty || 1,
        unit_price: item.unit_price || prod.price,
        line_total: (item.unit_price || prod.price) * (item.qty || 1),
      });
    }
  }
  // Pre-fill last delivery address so supervisor doesn't have to re-pin
  if (state.customer.lat && state.customer.lng) {
    state.deliveryLat     = state.customer.lat;
    state.deliveryLng     = state.customer.lng;
    state.deliveryAddress = state.customer.address || '';
  }
  openNewOrderModal();
  showToast('โหลดรายการเดิม ' + state.cart.length + ' รายการ', 'success');
}

// ── Payment Methods ───────────────────────────────────────────

async function loadPaymentMethods() {
  try {
    const res  = await fetch('/api/customer/payment-methods', { credentials: 'same-origin' });
    const data = await res.json();
    state.paymentMethods = data.methods || [];
  } catch (e) {}
}

function renderPaymentSelect() {
  const sel = document.getElementById('payment-method');
  if (!sel) return;
  sel.innerHTML = state.paymentMethods.length
    ? state.paymentMethods.map(pm => '<option value="' + pm.name + '">' + pm.name + '</option>').join('')
    : '<option value="เงินสด">เงินสด</option>';
}

async function loadFees() {
  try {
    const res  = await fetch('/api/customer/fees', { credentials: 'same-origin' });
    const data = await res.json();
    state.fees = data.fees || [];
  } catch (e) {}
}

// ── Charge Order ──────────────────────────────────────────────

function openChargeModal() {
  if (!state.cart.length) return;
  renderTotals();
  const total   = state._lastTotal || 0;
  const pmName  = document.getElementById('payment-method')?.value || 'เงินสด';
  const summary = state.cart.map(i => '• ' + i.name + ' x' + i.qty + ' = ฿' + i.line_total.toLocaleString()).join('<br>');
  document.getElementById('charge-summary').innerHTML =
    summary + '<br><br><strong style="color:var(--accent);font-size:1.1rem">รวม ฿' +
    total.toLocaleString() + '</strong> | ชำระ: ' + pmName;
  document.getElementById('charge-note').value         = '';
  document.getElementById('need-invoice').checked       = false;
  document.getElementById('invoice-fields').style.display = 'none';
  closeModal('new-order-modal');
  document.getElementById('charge-modal').style.display = 'flex';
}

function toggleInvoiceFields() {
  const show = document.getElementById('need-invoice').checked;
  document.getElementById('invoice-fields').style.display = show ? 'block' : 'none';
}

async function submitOrder() {
  if (!state.cart.length) return;
  const phone     = document.getElementById('cust-phone')?.value.trim() || '';
  const custName  = state.customer?.name || (phone || 'หน้าร้าน');
  const payMethod = document.getElementById('payment-method')?.value || 'เงินสด';
  const orderType = document.getElementById('order-type')?.value || 'walkin';
  const svcType   = document.getElementById('service-type')?.value || 'exchange';
  const note      = document.getElementById('charge-note')?.value || '';
  const needInv   = document.getElementById('need-invoice')?.checked;

  const payload = {
    phone, cust_name: custName,
    items: state.cart.map(i => ({ product_id: i.product_id, qty: i.qty })),
    order_type: orderType, service_type: svcType,
    payment_method: payMethod, note, invoice: needInv ? 1 : 0,
    inv_name: needInv ? (document.getElementById('inv-name')?.value || '') : '',
    inv_tax:  needInv ? (document.getElementById('inv-tax')?.value  || '') : '',
    source: 'pos',
  };
  try {
    const res  = await fetch('/api/supervisor/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(payload),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (!res.ok) { showToast('สร้างออเดอร์ไม่ได้: ' + (data.error || ''), 'error'); return; }
    closeModal('charge-modal');
    showToast('ออเดอร์ ' + data.order_num + ' สร้างแล้ว ฿' + data.total.toLocaleString(), 'success');
    printReceipt(data, custName, phone, payMethod, svcType);
    clearCart();
    loadKanban();
    loadProducts();
  } catch (e) {
    showToast('สร้างออเดอร์ไม่ได้', 'error');
  }
}

// ── Kanban ────────────────────────────────────────────────────

function filterByDriver() {
  if (state.view === 'list') renderAllKanbanCols();
  else renderMapPins();
}

async function loadKanban() {
  try {
    const driverFilter = document.getElementById('chip-driver')?.value || '';
    const dateEl = document.getElementById('chip-date');
    const dateFilter = dateEl?.value || '';
    const params = new URLSearchParams();
    if (driverFilter) params.set('driver_id', driverFilter);
    if (dateFilter)   params.set('date', dateFilter);
    let url = '/api/supervisor/kanban';
    if (params.toString()) url += '?' + params.toString();
    const res  = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    state.kanbanData = data;

    // populate driver filter
    const dsel = document.getElementById('chip-driver');
    if (dsel && state.drivers.length && dsel.options.length <= 1) {
      dsel.innerHTML = '<option value="">ทุก Driver</option>' +
        state.drivers.map(d => '<option value="' + d.id + '">' + d.name + '</option>').join('');
    }

    updateStatCards(data.stats || {});
    if (state.view === 'list') renderAllKanbanCols();
    if (state.view === 'map')  renderMapPins();
    updateConnStatus(true);
  } catch (e) {
    updateConnStatus(false);
  }
}

function updateConnStatus(online) {
  const dot = document.getElementById('conn-dot');
  if (!dot) return;
  const now = new Date();
  const hhmm = now.getHours().toString().padStart(2, '0') + ':' +
               now.getMinutes().toString().padStart(2, '0') + ':' +
               now.getSeconds().toString().padStart(2, '0');
  if (online) {
    dot.className = 'conn-dot conn-ok';
    dot.title = 'อัปเดตล่าสุด: ' + hhmm;
  } else {
    dot.className = 'conn-dot conn-err';
    dot.title = 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ (' + hhmm + ')';
  }
}

function updateStatCards(stats) {
  const el = (id) => document.getElementById(id);
  if (el('stat-total'))      el('stat-total').textContent      = stats.total_orders || 0;
  if (el('stat-pending'))    el('stat-pending').textContent    = stats.pending || 0;
  if (el('stat-delivering')) el('stat-delivering').textContent = stats.delivering || 0;
  if (el('stat-cash'))       el('stat-cash').textContent       = '฿' + (stats.uncleared_cash || 0).toLocaleString();
}

function renderAllKanbanCols() {
  renderKanbanCol('pending',    (state.kanbanData.pending    || []).concat(state.kanbanData.preparing || []));
  renderKanbanCol('delivering', state.kanbanData.delivering  || []);
  renderKanbanCol('completed',  state.kanbanData.completed   || []);
}

function renderKanbanCol(colId, orders) {
  const col = document.getElementById('col-' + colId);
  const cnt = document.getElementById('cnt-' + colId);
  if (!col) return;
  if (cnt) cnt.textContent = orders.length;
  if (!orders.length) {
    col.innerHTML = '<div style="text-align:center;color:var(--text-disabled);padding:24px;font-size:0.8rem">ไม่มีออเดอร์</div>';
    return;
  }
  col.innerHTML = orders.map(o => {
    const items = Array.isArray(o.items_json)
      ? o.items_json.map(i => i.name + ' x' + i.qty).join(', ')
      : (o.items_summary || '');
    const typeIco = o.order_type === 'walkin' ? '🏪' : '🚚';
    let actions = '';
    if (colId === 'pending') {
      if (o.status === 'pending') {
        actions =
          '<button class="btn-xs primary" onclick="confirmOrder(\'' + o.order_num + '\')" title="ยืนยัน">✓</button>' +
          '<button class="btn-xs secondary" onclick="openAssignModal(\'' + o.order_num + '\')" title="มอบหมาย Driver">👤</button>' +
          '<button class="btn-xs danger" onclick="openCancelModal(\'' + o.order_num + '\')" title="ยกเลิก">✕</button>' +
          '<button class="btn-xs secondary" onclick="reprintOrder(\'' + o.order_num + '\')" title="พิมพ์">🖨</button>';
      } else {
        // preparing — already confirmed, waiting for dispatch
        actions =
          '<button class="btn-xs secondary" onclick="openAssignModal(\'' + o.order_num + '\')" title="มอบหมาย Driver">👤</button>' +
          '<button class="btn-xs danger" onclick="openCancelModal(\'' + o.order_num + '\')" title="ยกเลิก">✕</button>' +
          '<button class="btn-xs secondary" onclick="reprintOrder(\'' + o.order_num + '\')" title="พิมพ์">🖨</button>';
      }
    } else if (colId === 'delivering') {
      actions =
        '<button class="btn-xs success" onclick="completeOrder(\'' + o.order_num + '\')" title="จบงาน">✓ จบ</button>' +
        '<button class="btn-xs secondary" onclick="openAssignModal(\'' + o.order_num + '\')" title="เปลี่ยน Driver">👤</button>' +
        '<button class="btn-xs danger" onclick="openCancelModal(\'' + o.order_num + '\')" title="ยกเลิก">✕</button>' +
        '<button class="btn-xs secondary" onclick="reprintOrder(\'' + o.order_num + '\')" title="พิมพ์">🖨</button>';
    } else {
      actions = '<button class="btn-xs secondary" onclick="reprintOrder(\'' + o.order_num + '\')" title="พิมพ์">🖨</button>';
    }
    const statusBadge = o.status === 'preparing'
      ? '<span class="order-status-badge">กำลังเตรียม</span>'
      : '';
    const timeStr = o.created_at ? o.created_at.slice(11, 16) : '';
    const addrStr = o.address ? '<span class="order-addr" title="' + o.address + '">📍 ' + o.address.slice(0, 30) + (o.address.length > 30 ? '…' : '') + '</span>' : '';
    return '<div class="order-card status-' + o.status + '">' +
      '<div class="order-num">' + typeIco + ' ' + o.order_num + statusBadge +
      (timeStr ? '<span class="order-time-chip">' + timeStr + '</span>' : '') + '</div>' +
      '<div class="order-cust">' + (o.cust_name || 'ลูกค้า') +
      (o.driver_name ? ' <span style="color:var(--text-disabled)">→ ' + o.driver_name + '</span>' : '') + '</div>' +
      '<div class="order-items">' + items + '</div>' +
      (addrStr ? '<div class="order-addr-row">' + addrStr + '</div>' : '') +
      '<div class="order-footer">' +
      '<span class="order-amount">฿' + (o.total || 0).toLocaleString() + '</span>' +
      '<div style="display:flex;gap:4px">' + actions + '</div>' +
      '</div></div>';
  }).join('');
}

async function confirmOrder(orderNum) {
  try {
    const res = await fetch('/api/supervisor/orders/' + orderNum + '/confirm', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    });
    if (res.ok) { showToast('ยืนยันออเดอร์ ' + orderNum, 'success'); loadKanban(); }
    else { const d = await res.json(); showToast(d.error || 'ยืนยันไม่ได้', 'error'); }
  } catch (e) { showToast('ยืนยันไม่ได้', 'error'); }
}

async function completeOrder(orderNum) {
  try {
    const res = await fetch('/api/supervisor/orders/' + orderNum + '/complete', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    });
    if (res.ok) {
      closePopover();
      showToast('จบงาน ' + orderNum + ' แล้ว', 'success');
      loadKanban();
    } else {
      const d = await res.json();
      showToast(d.error || 'จบงานไม่ได้', 'error');
    }
  } catch (e) { showToast('จบงานไม่ได้', 'error'); }
}

// ── Assign Driver ─────────────────────────────────────────────

async function loadDrivers() {
  try {
    const res  = await fetch('/api/supervisor/drivers', { credentials: 'same-origin' });
    const data = await res.json();
    state.drivers = data.drivers || data || [];
    const fpDriverOpts = '<option value="">ทั้งหมด</option>' +
      state.drivers.map(d => '<option value="' + d.id + '">' + d.name + '</option>').join('');
    const fpDrv = document.getElementById('fp-driver');
    if (fpDrv) fpDrv.innerHTML = fpDriverOpts;
  } catch (e) {}
}

function openAssignModal(orderNum) {
  // Find order data for the dispatch modal
  const allOrders = [
    ...(state.kanbanData.pending    || []),
    ...(state.kanbanData.preparing  || []),
    ...(state.kanbanData.delivering || []),
  ];
  const order = allOrders.find(o => o.order_num === orderNum);
  openDispatchModal(orderNum, order);
}

async function confirmAssign() {
  await confirmDispatch();
}

// ── Cancel Order ──────────────────────────────────────────────

function openCancelModal(orderNum) {
  state.cancelTarget = orderNum;
  document.getElementById('cancel-order-display').textContent = 'ออเดอร์ ' + orderNum;
  document.getElementById('cancel-reason').value = '';
  document.getElementById('cancel-modal').style.display = 'flex';
}

async function confirmCancel() {
  const reason = document.getElementById('cancel-reason').value.trim();
  if (!reason) { showToast('ระบุเหตุผลก่อน', 'error'); return; }
  try {
    const res  = await fetch('/api/supervisor/orders/' + state.cancelTarget + '/cancel', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ reason }),
    });
    const data = await res.json();
    closeModal('cancel-modal');
    if (res.ok) { showToast('ยกเลิกออเดอร์ ' + state.cancelTarget, 'success'); loadKanban(); loadProducts(); }
    else showToast(data.error || 'ยกเลิกไม่ได้', 'error');
  } catch (e) { showToast('ยกเลิกไม่ได้', 'error'); }
}

// ── Stock Modal ───────────────────────────────────────────────

async function openStockModal() {
  closeAllOverlays();
  // Extra: force-destroy any addr-picker map that might still be rendering
  if (typeof apState !== 'undefined' && apState && apState.map) {
    try { apState.map.remove(); } catch (e) {}
    apState.map = null;
  }
  try {
    const res  = await fetch('/api/supervisor/stock', { credentials: 'same-origin' });
    const data = await res.json();
    const rows = data.map(s =>
      '<tr>' +
      '<td style="padding:6px 8px">' + (s.ico || '🔵') + ' ' + s.name + '</td>' +
      '<td style="text-align:center;color:var(--success)">' + s.full_qty + '</td>' +
      '<td style="text-align:center;color:var(--text-disabled)">' + s.empty_qty + '</td>' +
      '<td style="text-align:center">' + s.customer_qty + '</td>' +
      '<td style="text-align:center;color:' + (s.full_qty <= s.reorder_point ? 'var(--warning)' : 'var(--text-disabled)') + '">' +
      s.reorder_point + '</td></tr>'
    ).join('');
    document.getElementById('stock-table').innerHTML =
      '<table style="width:100%;border-collapse:collapse;font-size:0.82rem">' +
      '<thead><tr style="color:var(--text-disabled);border-bottom:1px solid var(--border-hairline)">' +
      '<th style="text-align:left;padding:6px 8px">สินค้า</th>' +
      '<th>เต็ม</th><th>เปล่า</th><th>ลูกค้า</th><th>Reorder</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
    document.getElementById('stock-modal').style.display = 'flex';
  } catch (e) { showToast('โหลดสต็อกไม่ได้', 'error'); }
}

// ── Cash Modal ────────────────────────────────────────────────

async function openCashModal() {
  closeAllOverlays();
  const sel = document.getElementById('cash-driver-select');
  sel.innerHTML = state.drivers.map(d => '<option value="' + d.id + '">' + d.name + '</option>').join('');
  document.getElementById('cash-summary').textContent = 'เลือกคนส่งแล้วกดเคลียร์';
  document.getElementById('cash-modal').style.display = 'flex';
}

async function clearCash() {
  const driverId = document.getElementById('cash-driver-select').value;
  if (!driverId) return;
  try {
    const res  = await fetch('/api/supervisor/cash/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ driver_id: driverId }),
    });
    const data = await res.json();
    closeModal('cash-modal');
    if (res.ok) showToast('เคลียร์ ' + (data.cleared_orders || 0) + ' ออเดอร์ รวม ฿' + (data.total || 0).toLocaleString(), 'success');
    else showToast(data.error || 'เคลียร์ไม่ได้', 'error');
  } catch (e) { showToast('เคลียร์ไม่ได้', 'error'); }
}

// ── Restock Modal (multi-product, single invoice) ─────────────

let _rsLines = [];  // [{product_id, qty, price_per_unit}]

function openRestockModal() {
  closeAllOverlays();
  const staffSel = document.getElementById('restock-pickup-staff');
  staffSel.innerHTML = '<option value="">-- ไม่ระบุ --</option>'
    + state.drivers.map(d => '<option value="' + d.id + '">' + d.name + '</option>').join('');

  const supSel = document.getElementById('restock-supplier-id');
  if (supSel) {
    supSel.innerHTML = '<option value="">-- ไม่ระบุ --</option>';
    fetch('/api/supervisor/suppliers', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(list => {
        list.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name + (s.brand ? ' (' + s.brand + ')' : '');
          supSel.appendChild(opt);
        });
      }).catch(() => {});
  }

  document.getElementById('restock-tare-kg').value = '0';
  _rsLines = [{ product_id: state.products[0]?.id || '', qty: 1, price: 0 }];
  rsRenderLines();
  calcRestockTotal();
  document.getElementById('restock-modal').style.display = 'flex';
}

function rsProductOptions(selected) {
  return state.products.map(p =>
    '<option value="' + p.id + '"' + (p.id === selected ? ' selected' : '') + '>'
    + p.name + ' (เต็ม: ' + (p.full_qty || 0) + ')</option>'
  ).join('');
}

function rsRenderLines() {
  const cont = document.getElementById('rs-lines');
  if (!cont) return;
  cont.innerHTML = _rsLines.map((line, i) =>
    '<div class="rs-line" id="rs-line-' + i + '">' +
    '<select class="form-select rs-sel" onchange="rsUpdate(' + i + ',\'product_id\',this.value)">' +
    rsProductOptions(line.product_id) + '</select>' +
    '<input type="number" class="form-input rs-num" min="1" value="' + line.qty + '" placeholder="ถัง"' +
    ' oninput="rsUpdate(' + i + ',\'qty\',this.value)">' +
    '<input type="number" class="form-input rs-num" min="0" value="' + line.price + '" placeholder="฿ (ไม่รวม VAT)"' +
    ' oninput="rsUpdate(' + i + ',\'price\',this.value)">' +
    '<span class="rs-line-total">฿' + (line.qty * line.price).toLocaleString() + '</span>' +
    (_rsLines.length > 1
      ? '<button class="btn-xs danger" onclick="rsRemoveLine(' + i + ')">✕</button>'
      : '<button class="btn-xs secondary" disabled>✕</button>') +
    '</div>'
  ).join('');
}

function rsAddLine() {
  _rsLines.push({ product_id: state.products[0]?.id || '', qty: 1, price: 0 });
  rsRenderLines();
  calcRestockTotal();
}

function rsRemoveLine(i) {
  _rsLines.splice(i, 1);
  rsRenderLines();
  calcRestockTotal();
}

function rsUpdate(i, field, val) {
  if (field === 'qty' || field === 'price') _rsLines[i][field] = parseFloat(val) || 0;
  else _rsLines[i][field] = val;
  // update line total display
  const lineEl = document.getElementById('rs-line-' + i);
  if (lineEl) {
    const tot = lineEl.querySelector('.rs-line-total');
    if (tot) tot.textContent = '฿' + (_rsLines[i].qty * _rsLines[i].price).toLocaleString();
  }
  calcRestockTotal();
}

function calcRestockTotal() {
  const subtotal = _rsLines.reduce((s, l) => s + (l.qty || 0) * (l.price || 0), 0);
  const vat      = Math.round(subtotal * 0.07);
  const grand    = subtotal + vat;
  const tare_kg  = parseFloat(document.getElementById('restock-tare-kg')?.value) || 0;
  const tareDis  = Math.round(tare_kg * (state.tareRate || 5) * 100) / 100;
  const net      = Math.max(0, grand - tareDis);

  const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  set('restock-subtotal', '฿' + subtotal.toLocaleString());
  set('restock-vat',      '฿' + vat.toLocaleString());
  set('restock-gross',    '฿' + grand.toLocaleString());
  set('restock-tare-dis', tareDis > 0 ? '−฿' + tareDis.toLocaleString() : '฿0');
  set('restock-net',      '฿' + net.toLocaleString());

  const infoEl = document.getElementById('restock-tare-info');
  if (infoEl) {
    if (tare_kg > 0) {
      infoEl.style.display = 'block';
      document.getElementById('restock-tare-discount').textContent = '฿' + tareDis.toLocaleString();
      document.getElementById('restock-tare-bonus').textContent    = '฿' + tareDis.toLocaleString();
    } else {
      infoEl.style.display = 'none';
    }
  }
}

async function submitRestock() {
  const lines = _rsLines.filter(l => l.product_id && l.qty > 0);
  if (!lines.length) { showToast('เพิ่มรายการสินค้าก่อน', 'error'); return; }
  const tare_weight_kg    = parseFloat(document.getElementById('restock-tare-kg').value) || 0;
  const pickup_staff_id   = document.getElementById('restock-pickup-staff').value;
  const pickup_staff_name = state.drivers.find(d => d.id === pickup_staff_id)?.name || '';
  const supplier_id       = document.getElementById('restock-supplier-id')?.value || '';
  const subtotal          = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const vat_amount        = Math.round(subtotal * 0.07);

  try {
    const res = await fetch('/api/supervisor/restock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        items: lines.map(l => ({ product_id: l.product_id, qty: l.qty, cost_per_unit: l.price })),
        vat_amount, tare_weight_kg, pickup_staff_id, pickup_staff_name, supplier_id,
      }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'บันทึกไม่ได้', 'error'); return; }
    const totalQty = lines.reduce((s, l) => s + l.qty, 0);
    const netTotal = data.net_total || data.gross_total || 0;
    closeModal('restock-modal');
    showToast('รับสินค้า ' + (data.batch_id || '') + ' · ' + totalQty + ' ถัง · ฿' + Math.round(netTotal).toLocaleString(), 'success');
    loadProducts(); loadKanban();
  } catch (e) { showToast('เชื่อมต่อไม่ได้', 'error'); }
}

// ── Receipt Printing ──────────────────────────────────────────

function printReceipt(order, custName, phone, payMethod, serviceType) {
  const now      = new Date().toLocaleString('th-TH');
  const warranty = new Date(Date.now() + 7 * 86400000).toLocaleDateString('th-TH');
  const items    = (order.items || []).map(i =>
    '<div style="display:flex;justify-content:space-between">' +
    '<span>' + i.name + ' x' + i.qty + '</span>' +
    '<span>฿' + (i.line_total || 0).toLocaleString() + '</span></div>'
  ).join('');
  const vat  = Math.round((order.total || 0) * 7 / 107);
  const base = (order.total || 0) - vat;
  document.getElementById('receipt-template').innerHTML =
    '<div style="font-family:monospace;font-size:12px;max-width:300px;margin:0 auto;padding:16px">' +
    '<div style="text-align:center;font-weight:bold;font-size:14px">ร้านชัยเพ็ญ 1988</div>' +
    '<div style="text-align:center;font-size:10px">' + order.order_num + ' · ' + now + '</div>' +
    '<hr>' +
    '<div>ลูกค้า: ' + custName + (phone ? ' ' + phone : '') + '</div>' +
    '<div>ประเภท: ' + (serviceType === 'exchange' ? 'สลับถัง' : 'ซื้อใหม่') + '</div>' +
    '<hr>' + items + '<hr>' +
    '<div style="display:flex;justify-content:space-between;font-weight:bold">' +
    '<span>รวมทั้งหมด</span><span>฿' + (order.total || 0).toLocaleString() + '</span></div>' +
    '<div style="font-size:10px;color:#666">ก่อนภาษี ฿' + base.toLocaleString() + ' + VAT ฿' + vat.toLocaleString() + '</div>' +
    '<div>ชำระ: ' + payMethod + '</div>' +
    '<hr><div>รับประกัน 7 วัน ถึง ' + warranty + '</div>' +
    '<div style="text-align:center;margin-top:8px">ขอบคุณที่ใช้บริการ</div></div>';
  window.print();
}

async function reprintOrder(orderNum) {
  try {
    const o = await api('GET', '/api/supervisor/orders/' + orderNum);
    printReceipt(
      { order_num: o.order_num, total: o.total, items: o.items_json, fees: o.fees_json },
      o.cust_name, o.cust_phone, o.payment_method, o.service_type
    );
  } catch (e) { showToast('พิมพ์ซ้ำไม่ได้', 'error'); }
}

// ── Utils ─────────────────────────────────────────────────────

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
  if (state.map) setTimeout(() => state.map.invalidateSize(), 80);
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent  = msg;
  t.className    = 'toast ' + (type || '');
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3000);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(path, opts);
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── Keyboard shortcuts ────────────────────────────────────────

function handleKey(e) {
  const orderScreen = document.getElementById('order-screen');
  const inOrderScreen = orderScreen && orderScreen.style.display !== 'none';

  if (e.key === 'Escape') {
    if (inOrderScreen) { closeOrderScreen(); return; }
    if (document.getElementById('dispatch-modal')?.style.display !== 'none') { closeDispatchModal(); return; }
    ['charge-modal','stock-modal','cash-modal','cancel-modal','restock-modal']
      .forEach(id => closeModal(id));
    closePopover();
  }
  if (e.key === 'Enter' && inOrderScreen) { e.preventDefault(); submitOrderFromScreen(); return; }
  if (e.key === 'p' && e.ctrlKey && inOrderScreen) { e.preventDefault(); submitOrderFromScreen(); return; }
  if (e.key === 'F5') { e.preventDefault(); if (!inOrderScreen) loadKanban(); }
  if (e.key === 'n' || e.key === 'N') {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
    if (!inOrderScreen) openNewOrderModal();
  }
  if (e.key === '/') {
    const phoneInput = document.getElementById('cust-phone');
    if (phoneInput && !inOrderScreen) { e.preventDefault(); phoneInput.focus(); }
  }
  if (e.key === 'F1') { e.preventDefault(); quickRepeatOrder(); }
}

// ── S4: Order Entry Screen ────────────────────────────────────

function openOrderScreen() {
  document.getElementById('app').style.display = 'none';
  const scr = document.getElementById('order-screen');
  scr.style.display = 'flex';
  // Pause map polling while in order screen to avoid background refreshes
  clearInterval(state.pollingTimer);
  osRenderCustomer();
  osRenderItems();
  osRenderFees();
  osRenderPaymentMethods();
  osUpdateSummary();
  osCheckDocsSection();
}

function closeOrderScreen() {
  document.getElementById('order-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  osHideProductPicker();
  // Resume polling and fix map size
  state.pollingTimer = setInterval(loadKanban, 5000);
  if (state.map) setTimeout(() => state.map.invalidateSize(), 100);
}

// Close all full-screen overlays + modals before opening new feature
// Prevents stuck overlays when user clicks topbar button while overlay is open
function closeAllOverlays() {
  // Full-screen overlays — set inline display:none (overrides CSS rule via inline specificity)
  ['order-screen', 'addr-picker', 'cash-screen', 'dayend-screen'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.removeAttribute('style');           // clear any sticky cssText from prior calls
      el.style.display = 'none';              // standard inline override
    }
  });
  // Centered modals (.modal-overlay class)
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.removeAttribute('style');
    m.style.display = 'none';
  });
  // Restore main app visibility
  const app = document.getElementById('app');
  if (app && state.staff) {
    app.removeAttribute('style');
    app.style.display = 'flex';
  }
  // Clean up stale map state — addr-picker map can become orphan
  if (typeof apState !== 'undefined' && apState && apState.map) {
    try { apState.map.remove(); } catch (e) {}
    apState.map = null;
    apState.marker = null;
  }
  // Stop cash refresh timer if running
  if (state._csRefreshTimer) {
    clearInterval(state._csRefreshTimer);
    state._csRefreshTimer = null;
  }
}

function osRenderCustomer() {
  const nameEl = document.getElementById('os-cust-name');
  const subEl  = document.getElementById('os-cust-sub');
  if (state.customer && state.customer.name && state.customer.name !== 'ลูกค้าใหม่') {
    nameEl.textContent = state.customer.name;
    nameEl.className   = 'os-cust-name filled';
    subEl.textContent  = [
      state.customer.phone,
      state.customer.tier ? state.customer.tier.toUpperCase() : '',
    ].filter(Boolean).join(' · ');
    const addrEl = document.getElementById('os-address-text');
    if (addrEl) {
      const addrText = state.deliveryAddress || state.customer.address || '';
      if (addrText) addrEl.textContent = addrText;
    }
  } else {
    nameEl.textContent = state.customer?.phone ? ('โทร ' + state.customer.phone) : '-- เลือกลูกค้า --';
    nameEl.className   = 'os-cust-name';
    subEl.textContent  = '';
  }
}

function osPickCustomer() {
  const phone = document.getElementById('cust-phone')?.value.trim();
  if (phone) {
    showToast('ใช้ลูกค้าจากช่องค้นหา: ' + phone, 'success');
  } else {
    closeOrderScreen();
    const inp = document.getElementById('cust-phone');
    if (inp) inp.focus();
    showToast('ค้นหาลูกค้าก่อนสั่ง', 'success');
  }
}

function osRenderItems() {
  const container = document.getElementById('os-items');
  if (!container) return;
  if (!state.cart.length) {
    container.innerHTML = '';
    osUpdateSummary();
    return;
  }
  container.innerHTML = state.cart.map(item => {
    const prod = state.products.find(p => p.id === item.product_id);
    const ico  = prod?.ico || '🔵';
    const svcType = item.service_type || 'exchange';
    return '<div class="os-item-card" id="oscard-' + item.product_id + '">' +
      '<div class="os-item-thumb">' + ico + '</div>' +
      '<div class="os-item-info">' +
        '<div class="os-item-name">' + item.name + '</div>' +
        '<div class="os-item-types">' +
          '<button class="os-type-pill' + (svcType === 'exchange' ? ' active' : '') + '" ' +
          'onclick="osSetServiceType(\'' + item.product_id + '\',\'exchange\')">สลับ</button>' +
          '<button class="os-type-pill' + (svcType === 'new_purchase' ? ' active' : '') + '" ' +
          'onclick="osSetServiceType(\'' + item.product_id + '\',\'new_purchase\')">ซื้อใหม่</button>' +
        '</div>' +
        '<div class="os-item-unit">฿' + item.unit_price.toLocaleString() + '/ถัง</div>' +
      '</div>' +
      '<div class="os-item-right">' +
        '<div class="os-stepper">' +
          '<button class="os-step-btn" onclick="osChangeQty(\'' + item.product_id + '\',-1)">−</button>' +
          '<span class="os-step-num">' + item.qty + '</span>' +
          '<button class="os-step-btn" onclick="osChangeQty(\'' + item.product_id + '\',1)">+</button>' +
        '</div>' +
        '<div class="os-item-subtotal">฿' + item.line_total.toLocaleString() + '</div>' +
      '</div>' +
      '<button class="os-item-del" onclick="osRemoveItem(\'' + item.product_id + '\')" title="ลบ">✕</button>' +
    '</div>';
  }).join('');
  osUpdateSummary();
}

function osChangeQty(productId, delta) {
  changeQty(productId, delta);
  osRenderItems();
}

function osRemoveItem(productId) {
  removeFromCart(productId);
  osRenderItems();
}

function osSetServiceType(productId, type) {
  const item = state.cart.find(i => i.product_id === productId);
  if (item) { item.service_type = type; osRenderItems(); }
}

function osRenderFees() {
  const container = document.getElementById('os-fees');
  if (!container) return;
  const appFees = state.fees.filter(f => {
    if (document.querySelector('[name="os-order-type"]:checked')?.value !== 'delivery') return false;
    return true;
  });
  container.innerHTML = appFees.map(fee => {
    const amt = fee.type === 'percent'
      ? Math.round(state.cart.reduce((s, i) => s + i.line_total, 0) * fee.amount / 100)
      : fee.amount;
    return '<div class="os-fee-card">' +
      '<span class="os-fee-name">' + fee.name + '</span>' +
      '<div class="os-fee-right">' +
      '<span class="os-fee-amt">+฿' + amt.toLocaleString() + '</span>' +
      '</div></div>';
  }).join('');
}

function osAddFee() {
  showToast('เพิ่มค่าบริการ — ฟีเจอร์เร็วๆ นี้', 'success');
}

function osOrderTypeChange() {
  const type = document.querySelector('[name="os-order-type"]:checked')?.value;
  document.getElementById('os-address-row').style.display = type === 'delivery' ? '' : 'none';
  if (type === 'delivery') {
    const addrEl = document.getElementById('os-address-text');
    const current = state.deliveryAddress || state.customer?.address || '';
    if (addrEl) addrEl.textContent = current || '-- แตะเพื่อปักหมุดที่อยู่ --';
  }
  osRenderFees();
  osUpdateSummary();
}

function osChangeAddress() {
  openAddrPicker();
}

function osRenderPaymentMethods() {
  const container = document.getElementById('os-pm-row');
  if (!container) return;
  const isB2B = state.customer?.tier === 'b2b' && state.customer?.credit_approved;
  const methods = state.paymentMethods.length ? state.paymentMethods :
    [{ name: 'เงินสด' }, { name: 'โอน' }];
  const filtered = isB2B ? methods : methods.filter(m => m.name !== 'เครดิต');
  container.innerHTML = filtered.map((pm, i) =>
    '<label class="os-pm-card">' +
    '<input type="radio" name="os-payment" value="' + pm.name + '"' + (i === 0 ? ' checked' : '') + '>' +
    '<span>' + pm.name + '</span></label>'
  ).join('');
}

function osCheckDocsSection() {
  const isB2B = state.customer?.tier === 'b2b' || state.customer?.has_business_profile;
  document.getElementById('os-docs-section').style.display = isB2B ? '' : 'none';
}

function osToggleDN(cb) {
  // DN number auto-generated on submit; just show placeholder
}

function osToggleInv(cb) {
  document.getElementById('os-inv-fields').style.display = cb.checked ? '' : 'none';
}

function osShowProductPicker() {
  const container = document.getElementById('ops-list');
  if (!container) return;
  container.innerHTML = state.products.map(p => {
    const stock = p.full_qty || 0;
    const isOut = stock === 0;
    return '<div class="ops-card' + (isOut ? ' out' : '') + '" ' +
      (isOut ? '' : 'onclick="osPickProduct(\'' + p.id + '\')"') + '>' +
      '<div style="font-size:1.6rem;margin-bottom:4px">' + (p.ico || '🔵') + '</div>' +
      '<div style="font-family:var(--font-heading);font-size:0.82rem;font-weight:500;color:var(--text-primary)">' + p.name + '</div>' +
      '<div style="font-family:var(--font-heading);font-size:0.82rem;color:var(--accent)">฿' + p.price.toLocaleString() + '</div>' +
      '<div style="font-size:0.68rem;color:var(--text-disabled)">เต็ม: ' + stock + '</div>' +
    '</div>';
  }).join('');
  document.getElementById('os-product-sheet').style.display = '';
}

function osHideProductPicker() {
  const s = document.getElementById('os-product-sheet');
  if (s) s.style.display = 'none';
}

function osPickProduct(productId) {
  addToCart(productId);
  osHideProductPicker();
  osRenderItems();
}

function osUpdateSummary() {
  const container = document.getElementById('os-summary-card');
  if (!container) return;
  const subtotal  = state.cart.reduce((s, i) => s + i.line_total, 0);
  const orderType = document.querySelector('[name="os-order-type"]:checked')?.value || 'walkin';
  let feesTotal   = 0, feesRows = '';
  if (orderType === 'delivery') {
    for (const fee of state.fees) {
      let amt = fee.type === 'percent' ? Math.round(subtotal * fee.amount / 100) : fee.amount;
      if (fee.condition_type === 'floor') {
        try { if (subtotal >= parseFloat(fee.condition_value)) continue; } catch (e) {}
      }
      feesTotal += amt;
      feesRows  += '<div class="os-sum-row"><span>' + fee.name + '</span><span>+฿' + amt.toLocaleString() + '</span></div>';
    }
  }
  const total     = subtotal + feesTotal;
  const itemRows  = state.cart.map(i =>
    '<div class="os-sum-row"><span>' + i.name + ' × ' + i.qty + '</span><span>฿' + i.line_total.toLocaleString() + '</span></div>'
  ).join('');
  container.innerHTML =
    itemRows + feesRows +
    '<hr class="os-sum-divider">' +
    '<div class="os-sum-total">' +
    '<span class="os-sum-total-label">รวมทั้งสิ้น</span>' +
    '<span class="os-sum-total-val">฿' + total.toLocaleString() + '</span>' +
    '</div>';
  state._lastTotal = total;

  const submitBtn = document.getElementById('os-submit-btn');
  if (submitBtn) submitBtn.disabled = state.cart.length === 0;
}

async function submitOrderFromScreen() {
  if (!state.cart.length) { showToast('เลือกสินค้าก่อน', 'error'); return; }
  const phone    = document.getElementById('cust-phone')?.value.trim() || '';
  const custName = state.customer?.name || (phone || 'หน้าร้าน');
  const orderType = document.querySelector('[name="os-order-type"]:checked')?.value || 'walkin';
  const payMethod = document.querySelector('[name="os-payment"]:checked')?.value || 'เงินสด';
  const note      = document.getElementById('os-note')?.value || '';
  const wantDN    = document.getElementById('os-want-dn')?.checked;
  const wantInv   = document.getElementById('os-want-inv')?.checked;
  const invName   = document.getElementById('os-inv-name')?.value || '';
  const invTax    = document.getElementById('os-inv-tax')?.value  || '';

  const payload = {
    phone, cust_name: custName,
    items: state.cart.map(i => ({ product_id: i.product_id, qty: i.qty, service_type: i.service_type || 'exchange' })),
    order_type: orderType, payment_method: payMethod, note,
    want_dn: wantDN ? 1 : 0, want_inv: wantInv ? 1 : 0,
    inv_name: invName, inv_tax: invTax, source: 'pos',
    address: state.deliveryAddress || state.customer?.address || '',
    lat: state.deliveryLat || state.customer?.lat || null,
    lng: state.deliveryLng || state.customer?.lng || null,
  };
  try {
    const res  = await fetch('/api/supervisor/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(payload),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (!res.ok) { showToast('สร้างออเดอร์ไม่ได้: ' + (data.error || ''), 'error'); return; }
    closeOrderScreen();
    showToast('ออเดอร์ ' + data.order_num + ' สร้างแล้ว', 'success');
    printReceipt(data, custName, phone, payMethod, 'exchange');
    clearCart();
    state.deliveryAddress = '';
    state.deliveryLat = null;
    state.deliveryLng = null;
    loadKanban();
    loadProducts();
  } catch (e) { showToast('สร้างออเดอร์ไม่ได้', 'error'); }
}

// ── S5: Dispatch Modal ────────────────────────────────────────

const dispatchState = { orderNum: null, driverId: null, map: null, marker: null };

function openDispatchModal(orderNum, orderData) {
  dispatchState.orderNum = orderNum;
  dispatchState.driverId = null;

  document.getElementById('dm-order-num').textContent = orderNum || '';
  const custSummary = orderData
    ? [orderData.cust_name, orderData.cust_phone,
       Array.isArray(orderData.items_json) ? orderData.items_json.map(i => i.name + ' × ' + i.qty).join(' + ') : ''].filter(Boolean).join(' · ')
    : '';
  document.getElementById('dm-cust-summary').textContent = custSummary;

  // Driver cards
  renderDispatchDrivers();

  // Reset confirm button
  document.getElementById('dm-confirm-btn').disabled = true;
  document.getElementById('dm-footer-driver').textContent = 'เลือก Driver';
  document.getElementById('dm-footer-dist').textContent   = '';
  document.getElementById('dm-note').value = '';

  document.getElementById('dispatch-modal').style.display = 'flex';

  // Init map after display
  setTimeout(() => {
    initDispatchMap(orderData?.lat, orderData?.lng);
  }, 80);
}

function closeDispatchModal() {
  document.getElementById('dispatch-modal').style.display = 'none';
}

function renderDispatchDrivers() {
  const container = document.getElementById('dm-drivers');
  if (!container) return;
  if (!state.drivers.length) {
    container.innerHTML = '<div style="color:var(--text-disabled);font-size:0.85rem;padding:20px">ไม่มีข้อมูล Driver</div>';
    return;
  }
  container.innerHTML = state.drivers.map(d => {
    const isOff    = d.status === 'off' || d.status === 'inactive';
    const isBusy   = (d.active_orders || 0) > 0;
    const statusClass = isOff ? 'dm-status-off' : isBusy ? 'dm-status-busy' : 'dm-status-free';
    const statusText  = isOff ? 'ไม่อยู่' : isBusy ? 'กำลังส่ง (' + d.active_orders + ')' : 'ว่าง';
    const initials    = (d.name || 'D').substring(0, 2);
    return '<div class="dm-driver-card' + (isOff ? ' dm-off' : '') + '" ' +
      'id="dmc-' + d.id + '" ' +
      (isOff ? '' : 'onclick="selectDispatchDriver(\'' + d.id + '\')"') + '>' +
      '<div class="dm-selected-check">✓</div>' +
      '<div class="dm-avatar">' + initials + '</div>' +
      '<div class="dm-driver-name">' + d.name + '</div>' +
      '<span class="dm-status-pill ' + statusClass + '">' + statusText + '</span>' +
      '<div class="dm-driver-vehicle">' + (d.vehicle || '—') + '</div>' +
      '<div class="dm-driver-load">ออเดอร์วันนี้ ' + (d.active_orders || 0) + '</div>' +
    '</div>';
  }).join('');
}

function selectDispatchDriver(driverId) {
  dispatchState.driverId = driverId;
  document.querySelectorAll('.dm-driver-card').forEach(c => c.classList.remove('dm-selected'));
  const card = document.getElementById('dmc-' + driverId);
  if (card) card.classList.add('dm-selected');
  const driver = state.drivers.find(d => d.id === driverId);
  if (driver) {
    document.getElementById('dm-footer-driver').textContent = 'Driver: ' + driver.name;
  }
  document.getElementById('dm-confirm-btn').disabled = false;
}

function initDispatchMap(custLat, custLng) {
  const container = document.getElementById('dm-map');
  if (!container || typeof L === 'undefined') return;

  // Shop default location (Phetchabun area)
  const shopLat = 16.42, shopLng = 101.15;

  if (dispatchState.map) {
    dispatchState.map.remove();
    dispatchState.map = null;
  }

  const centerLat = custLat || shopLat;
  const centerLng = custLng || shopLng;

  dispatchState.map = L.map('dm-map', { zoomControl: true }).setView([centerLat, centerLng], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }).addTo(dispatchState.map);

  // Shop pin
  const shopIcon = L.divIcon({
    className: '',
    html: '<div style="width:28px;height:28px;background:#1a1a1a;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid #fff"></div>',
    iconSize: [28, 28], iconAnchor: [14, 28],
  });
  L.marker([shopLat, shopLng], { icon: shopIcon }).addTo(dispatchState.map)
    .bindTooltip('ชัยเพ็ญ 1988', { permanent: true, direction: 'top', offset: [0, -8] });

  // Customer pin (if has location)
  if (custLat && custLng) {
    const custIcon = L.divIcon({
      className: '',
      html: '<div style="width:28px;height:28px;background:#ff5625;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid #fff"></div>',
      iconSize: [28, 28], iconAnchor: [14, 28],
    });
    L.marker([custLat, custLng], { icon: custIcon }).addTo(dispatchState.map)
      .bindTooltip('ลูกค้า', { permanent: true, direction: 'top', offset: [0, -8] });

    // Line between shop and customer
    L.polyline([[shopLat, shopLng], [custLat, custLng]], {
      color: '#ff5625', weight: 1.5, opacity: 0.6, dashArray: '6 4',
    }).addTo(dispatchState.map);

    // Distance estimate
    const dist = calcDistance(shopLat, shopLng, custLat, custLng);
    document.getElementById('dm-footer-dist').textContent = 'ระยะทาง ~' + dist + ' กม.';

    const bounds = [[shopLat, shopLng], [custLat, custLng]];
    dispatchState.map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function calcDistance(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dN = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL/2) * Math.sin(dL/2) +
             Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
             Math.sin(dN/2) * Math.sin(dN/2);
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))).toFixed(1);
}

async function confirmDispatch() {
  if (!dispatchState.driverId || !dispatchState.orderNum) return;
  const note = document.getElementById('dm-note')?.value || '';
  try {
    const res  = await fetch('/api/supervisor/orders/' + dispatchState.orderNum + '/dispatch', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ driver_id: dispatchState.driverId, note }),
    });
    const data = await res.json();
    closeDispatchModal();
    if (res.ok) {
      const driverName = state.drivers.find(d => d.id === dispatchState.driverId)?.name || '';
      showToast('จัดส่ง ' + dispatchState.orderNum + ' → ' + driverName, 'success');
      loadKanban();
    } else {
      showToast(data.error || 'จัดส่งไม่ได้', 'error');
    }
  } catch (e) { showToast('จัดส่งไม่ได้', 'error'); }
}

// ── Address Map Picker ────────────────────────────────────────

const apState = { map: null, marker: null, lat: null, lng: null, address: '' };

function openAddrPicker() {
  const el = document.getElementById('addr-picker');
  if (!el) return;
  el.style.display = 'flex';

  // Pre-fill from existing delivery state or customer
  const initLat = state.deliveryLat || state.customer?.lat || 16.42;
  const initLng = state.deliveryLng || state.customer?.lng || 101.15;
  const initAddr = state.deliveryAddress || state.customer?.address || '';

  setTimeout(() => apInitMap(initLat, initLng, initAddr), 80);
}

function closeAddrPicker() {
  document.getElementById('addr-picker').style.display = 'none';
}

function apInitMap(initLat, initLng, initAddr) {
  if (typeof L === 'undefined') {
    showToast('แผนที่ไม่พร้อมใช้งาน', 'error');
    return;
  }
  const container = document.getElementById('ap-map');
  if (!container) return;

  if (apState.map) { apState.map.remove(); apState.map = null; apState.marker = null; }

  apState.map = L.map('ap-map', { zoomControl: true }).setView([initLat, initLng], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }).addTo(apState.map);

  // Place initial marker if we have coords
  if (state.deliveryLat || state.customer?.lat) {
    apPlaceMarker(initLat, initLng, initAddr);
  }

  // Click map → move marker
  apState.map.on('click', e => apPlaceMarker(e.latlng.lat, e.latlng.lng, null));
  // Drag end on map pan → update address (only when user-initiated, not programmatic)
  apState.map.on('moveend', () => {
    if (!apState.marker) return;
    if (apState._programmaticMove) return;  // skip if WE caused the move
    const c = apState.map.getCenter();
    apPlaceMarker(c.lat, c.lng, null);
  });
}

function apPlaceMarker(lat, lng, knownAddress) {
  apState.lat = lat;
  apState.lng = lng;

  if (!apState.marker) {
    apState.marker = L.marker([lat, lng], { draggable: true }).addTo(apState.map);
    apState.marker.on('dragend', e => {
      const p = e.target.getLatLng();
      apPlaceMarker(p.lat, p.lng, null);
    });
  } else {
    apState.marker.setLatLng([lat, lng]);
  }
  // Mark this as programmatic so moveend handler skips
  apState._programmaticMove = true;
  apState.map.setView([lat, lng], apState.map.getZoom());
  // Reset flag after Leaflet's animation completes (~500ms)
  setTimeout(() => { apState._programmaticMove = false; }, 600);

  if (knownAddress) {
    apSetAddress(knownAddress);
  } else {
    apReverseGeocode(lat, lng);
  }

  document.getElementById('ap-confirm-btn').disabled = false;
}

function apSetAddress(addr) {
  apState.address = addr;
  const el = document.getElementById('ap-addr-text');
  if (!el) return;
  el.textContent = addr || 'ตำแหน่งที่เลือก';
  el.className = 'ap-addr-text ap-addr-ready';
}

let _apGeocodeTimer = null;
function apReverseGeocode(lat, lng) {
  const el = document.getElementById('ap-addr-text');
  if (el) { el.textContent = 'กำลังโหลดที่อยู่…'; el.className = 'ap-addr-text'; }
  clearTimeout(_apGeocodeTimer);
  _apGeocodeTimer = setTimeout(async () => {
    try {
      const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + lat + '&lon=' + lng + '&accept-language=th';
      const res  = await fetch(url);
      const data = await res.json();
      const addr = data.display_name || (lat.toFixed(6) + ', ' + lng.toFixed(6));
      apSetAddress(addr);
    } catch {
      apSetAddress(lat.toFixed(6) + ', ' + lng.toFixed(6));
    }
  }, 600);
}

function apGeolocate() {
  if (_gpsUnavailable) {
    showToast('GPS ไม่พร้อม (ต้องการ HTTPS) — ลากหมุดบนแผนที่แทน', 'error');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => apPlaceMarker(pos.coords.latitude, pos.coords.longitude, null),
    ()  => showToast('ไม่สามารถระบุตำแหน่งได้', 'error'),
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function apConfirm() {
  if (!apState.lat) return;
  state.deliveryLat     = apState.lat;
  state.deliveryLng     = apState.lng;
  state.deliveryAddress = apState.address;
  // Update order screen address display
  const addrEl = document.getElementById('os-address-text');
  if (addrEl) addrEl.textContent = apState.address || (apState.lat.toFixed(5) + ', ' + apState.lng.toFixed(5));
  closeAddrPicker();
  showToast('บันทึกตำแหน่งแล้ว', 'success');
}

// ── S8: Cash Handover Screen ──────────────────────────────────

async function openCashScreen() {
  closeAllOverlays();
  document.getElementById('cash-screen').style.display = 'flex';
  csUpdateClock();
  document.getElementById('cs-amount-input').value = '';
  document.getElementById('cs-variance-row').innerHTML = '';
  if (document.getElementById('cs-reason-wrap')) document.getElementById('cs-reason-wrap').style.display = 'none';
  if (document.getElementById('cs-confirm-btn')) document.getElementById('cs-confirm-btn').disabled = true;
  await csRefreshData(true);
  // Auto-refresh every 5s while screen is open
  if (state._csRefreshTimer) clearInterval(state._csRefreshTimer);
  state._csRefreshTimer = setInterval(() => csRefreshData(false), 5000);
}

async function csRefreshData(autoSelect) {
  // Guard: stop if user logged out or screen closed
  if (!state.staff) {
    if (state._csRefreshTimer) { clearInterval(state._csRefreshTimer); state._csRefreshTimer = null; }
    return;
  }
  const csOpen = document.getElementById('cash-screen')?.style.display === 'flex';
  if (!csOpen) {
    if (state._csRefreshTimer) { clearInterval(state._csRefreshTimer); state._csRefreshTimer = null; }
    return;
  }
  try {
    const res  = await fetch('/api/supervisor/cash/summary', { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) {
      // Session lost — stop polling
      if (state._csRefreshTimer) { clearInterval(state._csRefreshTimer); state._csRefreshTimer = null; }
      return;
    }
    const data = await res.json();
    // Remember selected driver before re-render
    const prevSelected = document.querySelector('.cs-driver-selected')?.dataset.driverId;
    csRenderDrivers(data);
    // Restore selection if driver still has uncleared cash
    if (prevSelected) {
      const card = document.querySelector('.cs-driver-card[data-driver-id="' + prevSelected + '"]');
      if (card && !card.classList.contains('cs-driver-disabled')) {
        card.classList.add('cs-driver-selected');
        // Reload that driver's orders too
        try {
          const r2 = await fetch('/api/supervisor/cash/orders?driver_id=' + prevSelected, { credentials: 'same-origin' });
          csRenderOrders(await r2.json());
        } catch (e) {}
      }
    } else if (autoSelect) {
      // Initial open — auto-select first driver with cash owing
      const first = data.find(d => d.uncleared > 0);
      if (first) {
        const card = document.querySelector('.cs-driver-card[data-driver-id="' + first.id + '"]');
        if (card && !card.classList.contains('cs-driver-disabled')) csSelectDriver(card);
      }
    }
  } catch (e) {
    if (autoSelect) showToast('โหลดข้อมูล Driver ไม่ได้', 'error');
  }
}

function csRenderDrivers(drivers) {
  const colors = ['#e8e4ff,#5b3fd4','#ffeee8,#c94010','#e6f4ea,#1d6b35','#fff8e1,#c68000','#fce4ec,#b5195a'];
  const grid = document.getElementById('cs-driver-grid');
  if (!grid) return;
  grid.innerHTML = drivers.map((d, i) => {
    const [bg, fg] = colors[i % colors.length].split(',');
    const initials = (d.name || 'D').slice(0, 2);
    const disabled = !d.uncleared ? ' cs-driver-disabled' : '';
    const onclick  = !d.uncleared ? '' : ' onclick="csSelectDriver(this)"';
    return '<div class="cs-driver-card' + disabled + '" data-driver-id="' + d.id + '" data-owing="' + (d.uncleared||0) + '"' + onclick + '>' +
      '<div class="cs-avatar" style="background:' + bg + ';color:' + fg + '">' + initials + '</div>' +
      '<div class="cs-dname">' + (d.name || '') + '</div>' +
      '<div class="cs-owing-label">ค้างส่ง</div>' +
      '<div class="cs-owing-val' + (!d.uncleared ? ' cs-zero' : '') + '">฿ ' + (d.uncleared||0).toLocaleString() + '</div>' +
      '</div>';
  }).join('');
}

function closeCashScreen() {
  document.getElementById('cash-screen').style.display = 'none';
  if (state._csRefreshTimer) { clearInterval(state._csRefreshTimer); state._csRefreshTimer = null; }
  if (state.map) setTimeout(() => state.map.invalidateSize(), 80);
}

function csUpdateClock() {
  const now = new Date();
  const h = now.getHours().toString().padStart(2,'0');
  const m = now.getMinutes().toString().padStart(2,'0');
  const el = document.getElementById('cs-clock');
  if (el) el.textContent = h + ':' + m + ' น.';
}

async function csSelectDriver(card) {
  document.querySelectorAll('.cs-driver-card').forEach(c => c.classList.remove('cs-driver-selected'));
  card.classList.add('cs-driver-selected');
  document.getElementById('cs-amount-input').value = '';
  // Load this driver's uncleared orders
  const driverId = card.dataset.driverId;
  const wrap = document.getElementById('cs-orders-wrap');
  if (wrap) wrap.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-disabled);font-size:0.82rem">กำลังโหลด...</div>';
  try {
    const res  = await fetch('/api/supervisor/cash/orders?driver_id=' + driverId, { credentials: 'same-origin' });
    const orders = await res.json();
    csRenderOrders(orders);
  } catch (e) {
    if (wrap) wrap.innerHTML = '<div style="text-align:center;padding:16px;color:var(--danger)">โหลดออเดอร์ไม่ได้</div>';
  }
  csRecalc();
}

function csRenderOrders(orders) {
  const wrap = document.getElementById('cs-orders-wrap');
  if (!wrap) return;
  if (!orders.length) {
    wrap.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-disabled);font-size:0.82rem">ไม่มีออเดอร์ค้างรับเงิน</div>';
    return;
  }
  wrap.innerHTML = orders.map((o, idx) => {
    const amt = o.cash_collected || 0;
    const time = o.delivered_at ? o.delivered_at.slice(11,16) + ' น.' : '';
    return '<label class="cs-order-row" style="' + (idx === orders.length-1 ? 'border-bottom:none' : '') + '">' +
      '<div class="cs-order-left">' +
      '<div class="cs-order-top"><span class="cs-order-num">#' + o.order_num + '</span>' +
      (time ? '<span class="cs-order-time">' + time + '</span>' : '') + '</div>' +
      '<div class="cs-order-cust">' + (o.cust_name || '') + (o.items_summary ? ' · ' + o.items_summary : '') + '</div>' +
      '</div>' +
      '<div class="cs-order-right">' +
      '<span class="cs-order-amt" data-amt="' + amt + '">฿ ' + amt.toLocaleString() + '</span>' +
      '<input type="checkbox" class="cs-chk" checked onchange="csRecalc()">' +
      '</div></label>';
  }).join('');
  csRecalc();
}

function csRecalc() {
  const expectedEl = document.getElementById('cs-expected');
  const varRow = document.getElementById('cs-variance-row');
  const reasonWrap = document.getElementById('cs-reason-wrap');
  const confirmBtn = document.getElementById('cs-confirm-btn');
  const summaryEl = document.getElementById('cs-footer-summary');
  const selectedCard = document.querySelector('.cs-driver-selected');

  const checkboxes = document.querySelectorAll('.cs-chk');
  let selected = 0;
  checkboxes.forEach(chk => {
    if (chk.checked) {
      const amtEl = chk.closest('.cs-order-row').querySelector('.cs-order-amt');
      selected += parseInt(amtEl.dataset.amt) || 0;
    }
  });
  if (expectedEl) expectedEl.textContent = '฿ ' + selected.toLocaleString();

  const rawAmt = parseFloat(document.getElementById('cs-amount-input')?.value) || 0;
  const diff = rawAmt - selected;
  const driverName = selectedCard ? selectedCard.querySelector('.cs-dname')?.textContent : 'Driver';

  if (varRow) {
    if (rawAmt === 0) {
      varRow.innerHTML = '';
    } else if (Math.abs(diff) < 0.01) {
      varRow.innerHTML = '<span class="cs-var-ok">✓ ตรงกัน</span>';
    } else if (diff < 0) {
      varRow.innerHTML = '<span class="cs-var-under">⚠ ขาด ฿ ' + Math.abs(diff).toLocaleString() + '</span>';
    } else {
      varRow.innerHTML = '<span class="cs-var-over">⚠ เกิน ฿ ' + diff.toLocaleString() + '</span>';
    }
  }

  const hasVariance = rawAmt > 0 && Math.abs(diff) >= 0.01;
  if (reasonWrap) reasonWrap.style.display = hasVariance ? 'block' : 'none';

  const reason = document.getElementById('cs-reason')?.value || '';
  const canConfirm = rawAmt > 0 && (!hasVariance || reason.trim().length > 0);
  if (confirmBtn) confirmBtn.disabled = !canConfirm;

  if (summaryEl) {
    summaryEl.textContent = rawAmt > 0
      ? 'ยืนยันรับเงินสด ฿ ' + rawAmt.toLocaleString() + ' จาก ' + driverName
      : 'ยืนยันรับเงินสด ฿ 0 จาก ' + driverName;
  }
}

async function csConfirm() {
  const confirmBtn = document.getElementById('cs-confirm-btn');
  if (confirmBtn?.disabled) return;
  const selectedCard = document.querySelector('.cs-driver-selected');
  const driverId = selectedCard?.dataset.driverId;
  if (!driverId) {
    showToast('กรุณาเลือก Driver ก่อน', 'error');
    return;
  }
  const amount = parseFloat(document.getElementById('cs-amount-input')?.value) || 0;
  if (amount <= 0) {
    showToast('กรุณาระบุจำนวนเงิน', 'error');
    return;
  }
  const reason = document.getElementById('cs-reason')?.value || '';
  const orderNums = [];
  document.querySelectorAll('.cs-order-row').forEach(row => {
    if (row.querySelector('.cs-chk')?.checked) {
      orderNums.push(row.querySelector('.cs-order-num')?.textContent?.replace('#',''));
    }
  });
  try {
    const res = await fetch('/api/supervisor/cash/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ driver_id: driverId, amount: amount, reason: reason, order_nums: orderNums }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast('รับเงินสดแล้ว ฿ ' + amount.toLocaleString() + ' (' + (data.cleared_orders||0) + ' ออเดอร์)', 'success');
      closeCashScreen();
      loadKanban();
    } else {
      showToast(data.error || 'รับเงินไม่ได้', 'error');
    }
  } catch (e) { showToast('รับเงินไม่ได้', 'error'); }
}

// ── S9: Day-end Summary Screen ────────────────────────────────

async function openDayendScreen() {
  closeAllOverlays();
  const el = document.getElementById('dayend-screen');
  if (!el) return;
  el.style.display = 'flex';
  const now = new Date();
  const thDate = now.toLocaleDateString('th-TH-u-nu-latn', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
  const dateEl = document.getElementById('de-topbar-date');
  if (dateEl) dateEl.textContent = thDate;

  // Reset stale state immediately so old data never lingers
  const _drvListReset = document.getElementById('de-driver-list');
  if (_drvListReset) _drvListReset.innerHTML = '<div style="color:var(--text-disabled);padding:8px 0;font-size:0.85rem">กำลังโหลด...</div>';
  const _expListReset  = document.getElementById('de-exp-list');
  const _expEmptyReset = document.getElementById('de-exp-empty');
  if (_expListReset)  _expListReset.innerHTML = '';
  if (_expEmptyReset) _expEmptyReset.style.display = '';

  const setText = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };

  let todayStats = {};
  try {
    const [statsRes, cashRes] = await Promise.all([
      fetch('/api/supervisor/summary/today', { credentials: 'same-origin' }),
      fetch('/api/supervisor/cash/summary',   { credentials: 'same-origin' }),
    ]);
    if (statsRes.ok) {
      const d  = await statsRes.json();
      todayStats = d.stats || {};
      const s   = todayStats;
      setText('de-kpi-orders', s.orders ?? '--');
      setText('de-kpi-sales',  s.revenue   != null ? '฿ ' + Math.round(s.revenue).toLocaleString()   : '--');
      setText('de-kpi-cash',   s.cash_in   != null ? '฿ ' + Math.round(s.cash_in).toLocaleString()   : '--');
      setText('de-kpi-credit', s.credit_in != null ? '฿ ' + Math.round(s.credit_in).toLocaleString() : '--');

      // Payment breakdown
      const fmt = v => '฿ ' + Math.round(v || 0).toLocaleString();
      const cnt = v => '(' + (v || 0) + ' ออเดอร์)';
      setText('de-pay-cash-count',     cnt(s.cash_count));
      setText('de-pay-cash-amt',       fmt(s.cash_in));
      setText('de-pay-transfer-count', cnt(s.transfer_count));
      setText('de-pay-transfer-amt',   fmt(s.transfer_in));
      setText('de-pay-credit-count',   cnt(s.credit_count));
      setText('de-pay-credit-amt',     fmt(s.credit_in));
      const totalOrders = (s.cash_count || 0) + (s.transfer_count || 0) + (s.credit_count || 0);
      const totalAmt    = (s.cash_in || 0) + (s.transfer_in || 0) + (s.credit_in || 0);
      setText('de-pay-total-count', cnt(totalOrders));
      setText('de-pay-total-amt',   fmt(totalAmt));

      // Expenses
      const expenses = d.expenses || [];
      const expList  = document.getElementById('de-exp-list');
      const expEmpty = document.getElementById('de-exp-empty');
      if (expList) {
        if (expenses.length) {
          if (expEmpty) expEmpty.style.display = 'none';
          expList.innerHTML = expenses.map(exp =>
            '<div class="de-exp-row" data-exp-id="' + exp.id + '">' +
            '<span class="de-exp-name">' + (exp.note || '') + '</span>' +
            '<span class="de-exp-amt">฿ ' + Math.round(exp.amount).toLocaleString() + '</span>' +
            '</div>'
          ).join('');
        } else {
          if (expEmpty) expEmpty.style.display = '';
        }
      }
    }
    if (cashRes.ok) {
      const drivers = await cashRes.json();
      const list = document.getElementById('de-driver-list');
      if (list) {
        list.innerHTML = drivers.length ? drivers.map(drv => {
          const initials = (drv.name || '?').slice(0, 2);
          const hasOwing = (drv.uncleared || 0) > 0;
          return '<div class="de-driver-row">' +
            '<div class="de-drv-avatar">' + initials + '</div>' +
            '<span class="de-drv-name">' + (drv.name || '') + '</span>' +
            (hasOwing
              ? '<span class="de-drv-status de-status-warn">⚠ ค้าง ฿ ' + Math.round(drv.uncleared).toLocaleString() + '</span>' +
                '<button class="de-drv-action-btn" onclick="deOpenCashScreen()">รับเงิน</button>'
              : '<span class="de-drv-status de-status-ok">✓ รับครบ</span>' +
                '<span class="de-drv-amt">฿ ' + Math.round(drv.collected || 0).toLocaleString() + '</span>') +
          '</div>';
        }).join('')
        : '<div style="color:var(--text-disabled);padding:8px 0;font-size:0.85rem">ยังไม่มีข้อมูล Driver วันนี้</div>';
      }

      // Variance card — show only when there are real issues
      const warnCard        = document.getElementById('de-warn-card');
      const warnSub         = document.getElementById('de-warn-sub');
      const unclearedDrvs   = drivers.filter(drv => (drv.uncleared || 0) > 0);
      const issues          = [];
      if (unclearedDrvs.length) {
        const uc = unclearedDrvs.reduce((s, drv) => s + (drv.uncleared || 0), 0);
        issues.push('เงินค้าง ' + unclearedDrvs.length + ' คน ฿ ' + Math.round(uc).toLocaleString());
      }
      if (todayStats.cancelled_count) issues.push('ยกเลิก ' + todayStats.cancelled_count + ' ออเดอร์');
      if (warnCard) warnCard.style.display = issues.length ? '' : 'none';
      if (warnSub)  warnSub.textContent    = issues.join(' · ');
    }
  } catch (e) { showToast('โหลดข้อมูลปิดกะไม่ได้', 'error'); }
}

function closeDayendScreen() {
  document.getElementById('dayend-screen').style.display = 'none';
  if (state.map) setTimeout(() => state.map.invalidateSize(), 80);
}

function deOpenCashScreen() {
  closeDayendScreen();
  openCashScreen();
}

function deAddExpense() {
  const form = document.getElementById('de-exp-form');
  const btn  = document.getElementById('de-exp-add-btn');
  if (!form) return;
  form.style.display = '';
  if (btn) btn.style.display = 'none';
  document.getElementById('de-exp-name-inp')?.focus();
}

function deExpFormCancel() {
  const form = document.getElementById('de-exp-form');
  const btn  = document.getElementById('de-exp-add-btn');
  if (form) { form.style.display = 'none'; }
  if (btn)  btn.style.display = '';
  const ni = document.getElementById('de-exp-name-inp');
  const ai = document.getElementById('de-exp-amt-inp');
  if (ni) ni.value = '';
  if (ai) ai.value = '';
}

async function deExpFormSubmit() {
  const name = (document.getElementById('de-exp-name-inp')?.value || '').trim();
  const amt  = parseFloat(document.getElementById('de-exp-amt-inp')?.value || '');
  if (!name) { document.getElementById('de-exp-name-inp')?.focus(); return; }
  if (!amt || amt <= 0) { document.getElementById('de-exp-amt-inp')?.focus(); return; }
  try {
    const res = await fetch('/api/supervisor/expenses', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: name, amount: amt }),
    });
    if (!res.ok) { showToast('บันทึกค่าใช้จ่ายไม่ได้', 'error'); return; }
    const data = await res.json();
    const expList  = document.getElementById('de-exp-list');
    const expEmpty = document.getElementById('de-exp-empty');
    if (expEmpty) expEmpty.style.display = 'none';
    const row = document.createElement('div');
    row.className = 'de-exp-row';
    row.dataset.expId = data.id || '';
    row.innerHTML = '<span class="de-exp-name">' + name + '</span>' +
      '<span class="de-exp-amt">฿ ' + amt.toLocaleString() + '</span>';
    expList?.appendChild(row);
    deExpFormCancel();
    showToast('บันทึกค่าใช้จ่ายแล้ว', 'success');
  } catch (e) { showToast('บันทึกค่าใช้จ่ายไม่ได้', 'error'); }
}

async function deSendReport() {
  const btn = document.querySelector('.de-footer-ghost');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/supervisor/dayend/report', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) showToast('ส่งรายงานให้เจ้าของแล้ว', 'success');
    else        showToast('ส่งรายงานไม่ได้', 'error');
  } catch (e) { showToast('ส่งรายงานไม่ได้', 'error'); }
  finally { if (btn) btn.disabled = false; }
}

async function confirmDayend() {
  if (!confirm('ยืนยันปิดกะ? หลังปิดแล้วจะแก้ออเดอร์วันนี้ไม่ได้ ต้องให้ Admin แก้')) return;
  try {
    const res = await fetch('/api/supervisor/dayend', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) { showToast('ปิดกะไม่สำเร็จ', 'error'); return; }
    showToast('ปิดกะเรียบร้อย — ส่งรายงานแล้ว', 'success');
    setTimeout(() => { closeDayendScreen(); logout(); }, 1400);
  } catch (e) { showToast('ปิดกะไม่สำเร็จ', 'error'); }
}

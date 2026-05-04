/* driver.js — Driver PWA */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const D = {
  pin: '',
  staff: null,
  jobs: [],
  cashSummary: null,
  activeJob: null,
  pollTimer: null,
  checklistPassed: false,
  pendingPickupNum: null,
};

// ─── Boot: populate staff dropdown + check existing session ──────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadStaffList();
  await checkSession();
});

async function loadStaffList() {
  try {
    const res  = await fetch('/api/auth/staff?role=driver', { credentials: 'same-origin' });
    const data = await res.json();
    const sel  = document.getElementById('staff-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- เลือกชื่อ --</option>'
      + (data.staff || []).map(s =>
          '<option value="' + htmlEsc(s.id) + '">' + htmlEsc(s.name) + '</option>'
        ).join('');
  } catch (e) {
    console.warn('loadStaffList', e);
  }
}

async function checkSession() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      if (data.staff && data.staff.role === 'driver') {
        onLoginSuccess(data.staff);
      }
    }
  } catch (e) { /* not logged in */ }
}

// ─── PIN keypad ───────────────────────────────────────────────────────────────
function pinKey(d) {
  if (D.pin.length >= 4) return;
  D.pin += d;
  renderPin();
  if (D.pin.length === 4) setTimeout(pinConfirm, 200);
}

function pinDel() {
  D.pin = D.pin.slice(0, -1);
  renderPin();
}

function pinConfirm() {
  if (D.pin.length !== 4) return;
  doLogin();
}

function renderPin() {
  const el = document.getElementById('pin-display');
  if (el) el.textContent = '●'.repeat(D.pin.length) || '—';
}

async function doLogin() {
  const sel      = document.getElementById('staff-select');
  const staffId  = sel ? sel.value : '';
  const errEl    = document.getElementById('login-error');

  if (!staffId) {
    if (errEl) errEl.textContent = 'กรุณาเลือกชื่อก่อน';
    D.pin = ''; renderPin(); return;
  }

  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ staff_id: staffId, pin: D.pin }),
    });
    const data = await res.json();

    if (res.status === 423) {
      const mins = Math.ceil((data.locked_seconds || 900) / 60);
      if (errEl) errEl.textContent = 'ล็อคอีก ' + mins + ' นาที';
      D.pin = ''; renderPin(); return;
    }

    if (res.ok && data.staff) {
      onLoginSuccess(data.staff);
    } else {
      if (errEl) errEl.textContent = data.error || 'PIN ไม่ถูกต้อง';
      D.pin = ''; renderPin();
    }
  } catch (e) {
    if (errEl) errEl.textContent = 'เชื่อมต่อไม่ได้ กรุณาลองใหม่';
    D.pin = ''; renderPin();
  }
}

function onLoginSuccess(staff) {
  D.staff = staff;
  document.getElementById('login-screen').style.display = 'none';
  const app = document.getElementById('app');
  if (app) app.classList.add('visible');
  const nameEl = document.getElementById('header-driver-name');
  if (nameEl) nameEl.textContent = staff.name;
  loadJobs();
  D.pollTimer = setInterval(() => {
    loadJobs();
    // Also refresh cash if user is on cash tab
    if (D.currentTab === 'cash') loadCash();
  }, 10000);
}

async function doLogout() {
  clearInterval(D.pollTimer);
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (e) { /* ignore */ }
  D.staff = null;
  D.pin   = '';
  D.jobs  = [];
  renderPin();
  const errEl = document.getElementById('login-error');
  if (errEl) errEl.textContent = '';
  const app = document.getElementById('app');
  if (app) app.classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function showPage(name) {
  D.currentTab = name;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');

  if (name === 'cash') loadCash();
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────
async function loadJobs() {
  if (!D.staff) return;
  try {
    const res = await fetch('/api/driver/orders', { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) {
      // 401 = not logged in, 403 = logged in as wrong role (e.g., supervisor cookie)
      console.warn('Auth issue, status=' + res.status + ', logging out');
      doLogout();
      return;
    }
    const data = await res.json();
    D.jobs = data.orders || [];
    renderJobs();
  } catch (e) {
    console.error('loadJobs', e);
  }
}

function renderJobs() {
  const list = document.getElementById('jobs-list');
  if (!D.jobs.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-ico">📭</div><div class="empty-msg">ยังไม่มีงานที่ได้รับมอบหมาย</div></div>';
    return;
  }
  // Split into active (preparing/delivering) and completed
  const active    = D.jobs.filter(j => j.status === 'preparing' || j.status === 'delivering');
  const completed = D.jobs.filter(j => j.status === 'completed');
  // Sort active newest first; completed most recent first
  active.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  completed.sort((a, b) => (b.delivered_at || b.created_at || '').localeCompare(a.delivered_at || a.created_at || ''));

  let html = '';

  // Active section — always expanded
  if (active.length) {
    html += '<div class="jobs-section">'
      + '<div class="jobs-section-header"><span class="jobs-section-title">รอส่ง</span>'
      + '<span class="jobs-section-count">' + active.length + '</span></div>'
      + active.map(j => renderJobCard(j, false)).join('')
      + '</div>';
  }

  // Completed section — collapsed by default; click to expand individual cards
  if (completed.length) {
    const isOpen = D._completedOpen ? ' open' : '';
    html += '<div class="jobs-section jobs-completed' + isOpen + '">'
      + '<div class="jobs-section-header" onclick="toggleCompletedSection()">'
      + '<span class="jobs-section-title">ส่งแล้ว</span>'
      + '<span class="jobs-section-count">' + completed.length + '</span>'
      + '<span class="jobs-section-toggle">' + (D._completedOpen ? '▾' : '▸') + '</span>'
      + '</div>';
    if (D._completedOpen) {
      html += completed.map(j => renderJobCard(j, true)).join('');
    }
    html += '</div>';
  }

  list.innerHTML = html;
}

function toggleCompletedSection() {
  D._completedOpen = !D._completedOpen;
  renderJobs();
}

function toggleJobCard(orderNum) {
  D._expandedJobs = D._expandedJobs || new Set();
  if (D._expandedJobs.has(orderNum)) D._expandedJobs.delete(orderNum);
  else D._expandedJobs.add(orderNum);
  renderJobs();
}

function renderJobCard(j, isCompleted) {
  D._expandedJobs = D._expandedJobs || new Set();
  const isPreparing = j.status === 'preparing';
  const isDelivering = j.status === 'delivering';
  const isExpanded = !isCompleted || D._expandedJobs.has(j.order_num);

  let badgeClass, badgeText;
  if (isCompleted) {
    badgeClass = 'badge-completed';
    badgeText = 'ส่งแล้ว';
  } else if (isPreparing) {
    badgeClass = 'badge-preparing';
    badgeText = 'กำลังเตรียม';
  } else {
    badgeClass = 'badge-delivering';
    badgeText = 'กำลังส่ง';
  }

  const items = (j.items || []).map(i => i.name + ' × ' + i.qty).join(', ');
  const mapsUrl = (j.delivery_lat && j.delivery_lng)
    ? 'https://maps.google.com/?q=' + j.delivery_lat + ',' + j.delivery_lng
    : (j.delivery_address ? 'https://maps.google.com/?q=' + encodeURIComponent(j.delivery_address) : null);

  let actions = '';
  if (isPreparing) {
    actions += '<button class="btn-sm primary" onclick="startChecklist(\'' + j.order_num + '\')">🔍 ตรวจแล้วรับงาน</button>';
  }
  if (isDelivering) {
    if (mapsUrl) {
      actions += '<a class="btn-sm secondary" href="' + mapsUrl + '" target="_blank" rel="noopener">🗺️ นำทาง</a>';
    }
    actions += '<button class="btn-sm success" onclick="openDeliverModal(\'' + j.order_num + '\')">✅ ส่งสำเร็จ</button>';
    actions += '<button class="btn-sm warning" onclick="openAbsentModal(\'' + j.order_num + '\')">🚫 ลูกค้าไม่อยู่</button>';
  }

  // Header always visible — clickable on completed cards
  const headerOnclick = isCompleted ? ' onclick="toggleJobCard(\'' + j.order_num + '\')" style="cursor:pointer"' : '';
  const expandIcon = isCompleted ? '<span class="job-expand-icon">' + (isExpanded ? '▾' : '▸') + '</span>' : '';

  let html = '<div class="job-card' + (isCompleted ? ' job-completed' : '') + '">'
    + '<div class="job-header"' + headerOnclick + '>'
    + '<div class="job-num">' + htmlEsc(j.order_num) + ' ' + expandIcon + '</div>'
    + '<span class="job-status-badge ' + badgeClass + '">' + badgeText + '</span>'
    + '</div>';

  if (isExpanded) {
    html += '<div class="job-items">' + htmlEsc(items) + '</div>'
      + '<div class="job-total">฿' + fmt(j.total) + '</div>'
      + (j.delivery_address ? '<div class="job-address">📍 <span>' + htmlEsc(j.delivery_address) + '</span></div>' : '')
      + (j.customer_name ? '<div class="info-row">👤 ' + htmlEsc(j.customer_name) + ' · ' + htmlEsc(j.customer_phone) + '</div>' : '')
      + (actions ? '<div class="job-actions">' + actions + '</div>' : '');
  } else {
    // Compact view: items summary + total only
    html += '<div class="job-compact"><span class="job-compact-items">' + htmlEsc(items) + '</span>'
      + '<span class="job-compact-total">฿' + fmt(j.total) + '</span></div>';
  }

  html += '</div>';
  return html;
}

// ─── Safety Checklist ─────────────────────────────────────────────────────────
function startChecklist(orderNum) {
  D.pendingPickupNum = orderNum;
  // Reset checklist
  document.querySelectorAll('.check-item').forEach(el => {
    el.classList.remove('checked');
  });
  document.getElementById('btn-checklist-ok').disabled = true;
  document.getElementById('modal-checklist').style.display = 'flex';
}

function toggleCheck(el) {
  el.classList.toggle('checked');
  const total = document.querySelectorAll('.check-item').length;
  const checked = document.querySelectorAll('.check-item.checked').length;
  document.getElementById('btn-checklist-ok').disabled = (checked < total);
}

function closeChecklist(e) {
  if (e && e.target !== document.getElementById('modal-checklist')) return;
  document.getElementById('modal-checklist').style.display = 'none';
}

async function confirmChecklist() {
  document.getElementById('modal-checklist').style.display = 'none';
  const num = D.pendingPickupNum;
  if (!num) return;
  try {
    const res = await fetch('/api/driver/orders/' + num + '/pickup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (res.ok) {
      showToast('รับงาน ' + num + ' แล้ว', 'success');
      loadJobs();
    } else {
      showToast(data.error || 'เกิดข้อผิดพลาด', 'error');
    }
  } catch (e) {
    showToast('เชื่อมต่อไม่ได้', 'error');
  }
}

// ─── Deliver Modal ────────────────────────────────────────────────────────────
function openDeliverModal(orderNum) {
  const job = D.jobs.find(j => j.order_num === orderNum);
  if (!job) return;
  D.activeJob = job;
  const items = (job.items || []).map(i => i.name + ' × ' + i.qty).join('\n');
  document.getElementById('deliver-items-txt').textContent = items;
  document.getElementById('deliver-total-txt').textContent = '฿' + fmt(job.total);
  document.getElementById('deliver-payment-txt').textContent = job.payment_method || 'เงินสด';

  const isCash = (job.payment_method || '').includes('สด') || (job.payment_method || '').toLowerCase().includes('cash');
  const cashRow = document.getElementById('cash-input-row');
  cashRow.style.display = isCash ? 'block' : 'none';
  if (isCash) {
    document.getElementById('cash-received-input').value = '';
    document.getElementById('change-row').textContent = '';
  }
  document.getElementById('modal-deliver').style.display = 'flex';
}

function updateChange() {
  if (!D.activeJob) return;
  const received = parseFloat(document.getElementById('cash-received-input').value) || 0;
  const total = D.activeJob.total || 0;
  const change = received - total;
  const row = document.getElementById('change-row');
  if (received > 0) {
    row.textContent = change >= 0 ? 'เงินทอน: ฿' + fmt(change) : 'ไม่เพียงพอ';
    row.style.color = change >= 0 ? 'var(--success-dim)' : 'var(--accent)';
  } else {
    row.textContent = '';
  }
}

async function confirmDeliver() {
  const job = D.activeJob;
  if (!job) return;
  const cashReceived = parseFloat(document.getElementById('cash-received-input').value) || null;
  try {
    const res = await fetch('/api/driver/orders/' + job.order_num + '/deliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ cash_received: cashReceived }),
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('modal-deliver').style.display = 'none';
      showToast('✅ ส่งสำเร็จ! ' + job.order_num, 'success');
      D.activeJob = null;
      loadJobs();
    } else {
      showToast(data.error || 'เกิดข้อผิดพลาด', 'error');
    }
  } catch (e) {
    showToast('เชื่อมต่อไม่ได้', 'error');
  }
}

// ─── Customer Absent ──────────────────────────────────────────────────────────
function openAbsentModal(orderNum) {
  D.activeJob = D.jobs.find(j => j.order_num === orderNum) || { order_num: orderNum };
  document.getElementById('modal-absent').style.display = 'flex';
}

async function confirmAbsent() {
  const job = D.activeJob;
  if (!job) return;
  document.getElementById('modal-absent').style.display = 'none';
  try {
    const res = await fetch('/api/driver/orders/' + job.order_num + '/customer-absent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (res.ok) {
      showToast('แจ้งหัวหน้าแล้ว', 'success');
      loadJobs();
    } else {
      showToast(data.error || 'เกิดข้อผิดพลาด', 'error');
    }
  } catch (e) {
    showToast('เชื่อมต่อไม่ได้', 'error');
  }
}

// ─── Cash Summary ─────────────────────────────────────────────────────────────
async function loadCash() {
  if (!D.staff) return;
  try {
    const res = await fetch('/api/driver/cash/summary', { credentials: 'same-origin' });
    const data = await res.json();
    D.cashSummary = data;
    renderCash(data);
  } catch (e) {
    document.getElementById('cash-content').innerHTML = '<p style="color:var(--text-3);text-align:center;padding:40px 0">โหลดไม่ได้</p>';
  }
}

function renderCash(data) {
  const orders = data.orders || [];
  const total = data.total_cash || 0;
  const totalCollected = data.total_collected_today || 0;
  const allCleared = orders.length > 0 && orders.every(o => o.cleared || o.payment_method !== 'เงินสด');

  let html = '<div class="section-card"><div class="section-title">รายการวันนี้</div>';
  if (!orders.length) {
    html += '<p style="color:var(--text-3);font-size:.85rem">ยังไม่มีรายการ</p>';
  } else {
    orders.forEach(o => {
      const isCash = o.payment_method === 'เงินสด';
      const cleared = o.cleared && isCash;
      const statusBadge = !isCash
        ? '<span style="font-size:.7rem;color:var(--text-3);margin-left:6px">(' + htmlEsc(o.payment_method || '') + ')</span>'
        : (cleared
            ? '<span style="font-size:.7rem;color:var(--success);margin-left:6px">✓ ส่งเงินแล้ว</span>'
            : '<span style="font-size:.7rem;color:var(--warning);margin-left:6px">รอส่ง</span>');
      const valStyle = cleared ? 'opacity:0.5;text-decoration:line-through' : '';
      html += '<div class="cash-row">'
        + '<div class="cash-label">' + htmlEsc(o.order_num) + statusBadge
        + '<br><span style="font-size:.75rem;color:var(--text-3)">' + htmlEsc(o.customer_name || '') + '</span></div>'
        + '<div class="cash-val" style="' + valStyle + '">฿' + fmt(o.cash_received) + '</div>'
        + '</div>';
    });
  }
  html += '</div>';

  html += '<div class="cash-total-row">'
    + '<div class="cash-total-label">' + (allCleared ? 'ส่งคืนครบแล้ว — รวมวันนี้' : 'ยอดรวมที่ต้องส่งคืน') + '</div>'
    + '<div class="cash-total-val" style="' + (allCleared ? 'color:var(--success)' : '') + '">฿' + fmt(allCleared ? totalCollected : total) + '</div>'
    + '</div>';

  document.getElementById('cash-content').innerHTML = html;
  document.getElementById('return-amount-txt').textContent = '฿' + fmt(total);

  // Disable return button if nothing to return
  const returnBtn = document.getElementById('btn-cash-return');
  if (returnBtn) {
    if (total <= 0) {
      returnBtn.disabled = true;
      returnBtn.textContent = orders.length ? 'ส่งคืนครบแล้ว' : 'ยังไม่มีเงินรอส่งคืน';
      returnBtn.style.opacity = '0.5';
    } else {
      returnBtn.disabled = false;
      returnBtn.textContent = 'ส่งคืนเงินสด ฿' + fmt(total);
      returnBtn.style.opacity = '1';
    }
  }
}

function showCashReturn() {
  const total = (D.cashSummary && D.cashSummary.total_cash) || 0;
  if (total <= 0) {
    showToast('ไม่มีเงินค้างที่ต้องส่งคืน', 'success');
    return;
  }
  document.getElementById('return-amount-txt').textContent = '฿' + fmt(total);
  document.getElementById('modal-cash-return').style.display = 'flex';
}

async function confirmCashReturn() {
  document.getElementById('modal-cash-return').style.display = 'none';
  try {
    const res = await fetch('/api/driver/cash/return', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (res.ok) {
      const amt = data.returned || 0;
      if (amt > 0) {
        showToast('ส่งคืนเงินสดแล้ว ฿' + fmt(amt), 'success');
      } else {
        // Supervisor probably already cleared this — sync UI
        showToast('หัวหน้างานได้รับเงินแล้ว', 'success');
      }
      loadCash();
    } else {
      showToast(data.error || 'เกิดข้อผิดพลาด', 'error');
    }
  } catch (e) {
    showToast('เชื่อมต่อไม่ได้', 'error');
  }
}

// ─── Modal close helper ───────────────────────────────────────────────────────
function closeModal(id, e) {
  if (e && e.target !== document.getElementById(id)) return;
  document.getElementById(id).style.display = 'none';
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n === undefined || n === null) return '0';
  return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function htmlEsc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── PWA Service Worker Registration ────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

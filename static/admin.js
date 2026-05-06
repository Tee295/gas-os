// admin.js — Admin back office
'use strict';

const A = {
  staff: null,
  pin: '',
  products: [],
  suppliers: [],
  restockItems: [],
  activeLedgerCust: null,
};

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', checkSession);

async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const d = await res.json();
      if (d.staff && d.staff.role === 'admin') { onLoginSuccess(d.staff); return; }
    }
  } catch (e) { /* not logged in */ }
}

// ── PIN (6-digit for admin) ───────────────────────────────────

function pinPress(d) {
  if (A.pin.length >= 6) return;
  A.pin += d;
  renderPin();
  if (A.pin.length === 6) setTimeout(pinSubmit, 150);
}
function pinClear() { A.pin = ''; renderPin(); document.getElementById('login-error').textContent = ''; }
function renderPin() {
  document.getElementById('pin-display').textContent =
    '●'.repeat(A.pin.length) + '—'.repeat(6 - A.pin.length);
}
async function pinSubmit() {
  if (!A.pin) return;
  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pin: A.pin }),   // no staff_id → admin path
    });
    const data = await res.json();

    if (res.status === 423) {
      const mins = Math.ceil((data.locked_seconds || 900) / 60);
      document.getElementById('login-error').textContent = 'ล็อคอีก ' + mins + ' นาที';
      A.pin = ''; renderPin(); return;
    }
    if (res.ok && data.staff) {
      onLoginSuccess(data.staff);
    } else {
      document.getElementById('login-error').textContent = data.error || 'PIN ไม่ถูกต้อง';
      A.pin = ''; renderPin();
    }
  } catch (e) {
    document.getElementById('login-error').textContent = 'เชื่อมต่อไม่ได้';
    A.pin = ''; renderPin();
  }
}
function onLoginSuccess(staff) {
  A.staff = staff;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('nav-staff').textContent = staff.name + ' (admin)';
  nav('dashboard');
}
async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
  A.staff = null; A.pin = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  renderPin();
}

// ── Nav ──────────────────────────────────────────────────────

function nav(view) {
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelector('[data-view="' + view + '"]').classList.add('active');
  window.location.hash = view;
  loadView(view);
}

function loadView(view) {
  const loaders = {
    dashboard: loadDashboard, orders: loadOrders, customers: loadCustomers,
    products: loadProducts, suppliers: loadSuppliers, restock: loadRestock,
    expenses: loadExpenses, vat: loadVAT, staff: loadStaff,
    audit: loadAudit, settings: loadSettings,
    bonus: loadBonus, translations: loadTranslations,
  };
  if (loaders[view]) loaders[view]();
}

window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (v && document.getElementById('view-' + v)) nav(v);
});

// ── Dashboard ────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const d = await apiAdmin('GET', '/api/admin/dashboard');
    const fmt = v => '฿' + Math.round(v || 0).toLocaleString();
    document.getElementById('kpi-revenue').textContent = fmt(d.revenue);
    document.getElementById('kpi-profit').textContent = fmt(d.gross_profit);
    document.getElementById('kpi-expenses').textContent = fmt(d.expenses);
    const net = d.net_profit || 0;
    const netEl = document.getElementById('kpi-net');
    netEl.textContent = fmt(net);
    netEl.className = 'kpi-value ' + (net >= 0 ? 'success' : 'accent');
    document.getElementById('kpi-cash').textContent = fmt(d.uncleared_cash);
    document.getElementById('kpi-credit').textContent = fmt(d.pending_credit);
    document.getElementById('audit-feed').innerHTML = (d.recent_audit || []).map(a =>
      '<div class="audit-item">' +
      '<span class="audit-time">' + (a.timestamp || '').slice(5, 16) + '</span>' +
      '<span class="audit-actor">' + (a.actor_name || '—') + '</span>' +
      '<span class="audit-action">' + a.action + ' ' + (a.target_type || '') +
      ' ' + (a.target_id || '') + '</span></div>'
    ).join('') || '<div style="color:var(--text-3);font-size:0.82rem">ไม่มีกิจกรรม</div>';
  } catch (e) { toast('โหลด Dashboard ไม่ได้', 'error'); }
}

// ── Orders ───────────────────────────────────────────────────

async function loadOrders() {
  const from = document.getElementById('orders-from').value;
  const to = document.getElementById('orders-to').value;
  const status = document.getElementById('orders-status').value;
  let q = '?limit=200';
  if (from) q += '&from=' + from;
  if (to) q += '&to=' + to;
  if (status) q += '&status=' + status;
  try {
    const rows = await apiAdmin('GET', '/api/admin/orders' + q);
    document.getElementById('orders-body').innerHTML = rows.map(o =>
      '<tr>' +
      '<td class="accent-text">' + o.order_num + '</td>' +
      '<td>' + o.date + '</td>' +
      '<td>' + (o.cust_name || '') + '<br><span style="font-size:0.75rem;color:var(--text-3)">' + (o.cust_phone || '') + '</span></td>' +
      '<td style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (o.items_summary || '') + '</td>' +
      '<td class="num">฿' + (o.total || 0).toLocaleString() + '</td>' +
      '<td>' + (o.payment_method || '') + '</td>' +
      '<td><span class="badge badge-' + o.status + '">' + statusLabel(o.status) + '</span></td>' +
      '<td>' + (o.driver_name || '—') + '</td>' +
      '<td><button class="btn-xs" onclick="viewOrderDetail(\'' + o.order_num + '\')">ดู</button></td>' +
      '</tr>'
    ).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text-3)">ไม่มีข้อมูล</td></tr>';
  } catch (e) { toast('โหลดออเดอร์ไม่ได้', 'error'); }
}

function statusLabel(s) {
  const m = { pending:'รอยืนยัน', preparing:'กำลังเตรียม', delivering:'กำลังส่ง', completed:'สำเร็จ', cancelled:'ยกเลิก' };
  return m[s] || s;
}

async function viewOrderDetail(num) {
  try {
    const o = await api('GET', '/api/admin/orders/' + num);
    const items = (o.items_json || []).map(i =>
      i.name + ' x' + i.qty + ' = ฿' + (i.line_total || 0).toLocaleString()
    ).join('\n');
    alert('ออเดอร์ ' + num + '\n' + o.cust_name + ' ' + o.cust_phone +
      '\n' + o.address + '\n\n' + items +
      '\n\nรวม ฿' + (o.total || 0).toLocaleString() +
      '\nสถานะ: ' + statusLabel(o.status) +
      (o.cancel_reason ? '\nเหตุผลยกเลิก: ' + o.cancel_reason : ''));
  } catch (e) {}
}

function exportOrdersCSV() {
  const rows = document.querySelectorAll('#orders-body tr');
  if (!rows.length) return;
  const cols = ['ออเดอร์','วันที่','ลูกค้า','รายการ','ยอด','ชำระ','สถานะ','คนส่ง'];
  let csv = cols.join(',') + '\n';
  rows.forEach(tr => {
    const cells = [...tr.querySelectorAll('td')].slice(0, 8)
      .map(td => '"' + td.textContent.replace(/"/g, '""').replace(/\n/g, ' ') + '"');
    csv += cells.join(',') + '\n';
  });
  downloadCSV(csv, 'orders.csv');
}

// ── Customers ────────────────────────────────────────────────

async function loadCustomers() {
  const q = document.getElementById('cust-q').value;
  try {
    const rows = await apiAdmin('GET', '/api/admin/customers?q=' + encodeURIComponent(q));
    document.getElementById('customers-body').innerHTML = rows.map(c =>
      '<tr>' +
      '<td>' + c.name + '</td>' +
      '<td>' + (c.phone || '') + '</td>' +
      '<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (c.address || '') + '</td>' +
      '<td><span class="badge badge-' + (c.tier || 'retail') + '">' + (c.tier || 'retail') + '</span></td>' +
      '<td class="num">' + (c.total_orders || 0) + '</td>' +
      '<td class="num">฿' + (c.total_spent || 0).toLocaleString() + '</td>' +
      '<td class="num ' + (c.credit_bal > 0 ? 'warn-text' : '') + '">฿' + (c.credit_bal || 0).toLocaleString() + '</td>' +
      '<td style="display:flex;gap:4px">' +
      '<button class="btn-xs" onclick="editCustomer(\'' + c.id + '\')">แก้ไข</button>' +
      '<button class="btn-xs" onclick="openLedger(\'' + c.id + '\',\'' + c.name + '\')">บัญชี</button>' +
      '</td></tr>'
    ).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text-3)">ไม่มีข้อมูล</td></tr>';
  } catch (e) { toast('โหลดลูกค้าไม่ได้', 'error'); }
}

function openCustomerModal(data) {
  ['id','name','phone','address','note'].forEach(f => {
    const el = document.getElementById('cm-' + f);
    if (el) el.value = data ? (data[f] || '') : '';
  });
  if (data) {
    document.getElementById('cm-tier').value = data.tier || 'retail';
    document.getElementById('cm-credit_limit').value = data.credit_limit || 0;
    document.getElementById('cm-credit_days').value = data.credit_days || 30;
    document.getElementById('cm-need_invoice').value = data.need_invoice || 'no';
  }
  document.getElementById('customer-modal').style.display = 'flex';
}

async function editCustomer(id) {
  try {
    const c = await apiAdmin('GET', '/api/admin/customers/' + id);
    openCustomerModal(c);
    document.getElementById('cm-id').value = id;
  } catch (e) {}
}

async function saveCustomer() {
  const id = document.getElementById('cm-id').value;
  const body = {
    name: document.getElementById('cm-name').value,
    phone: document.getElementById('cm-phone').value,
    address: document.getElementById('cm-address').value,
    tier: document.getElementById('cm-tier').value,
    credit_limit: parseInt(document.getElementById('cm-credit_limit').value) || 0,
    credit_days: parseInt(document.getElementById('cm-credit_days').value) || 30,
    need_invoice: document.getElementById('cm-need_invoice').value,
    note: document.getElementById('cm-note').value,
  };
  try {
    if (id) await apiAdmin('PUT', '/api/admin/customers/' + id, body);
    else await apiAdmin('POST', '/api/admin/customers', body);
    closeModal('customer-modal');
    loadCustomers();
    toast('บันทึกแล้ว', 'success');
  } catch (e) { toast('บันทึกไม่ได้: ' + (e.message || ''), 'error'); }
}

async function openLedger(custId, custName) {
  A.activeLedgerCust = custId;
  try {
    const rows = await apiAdmin('GET', '/api/admin/customers/' + custId + '/ledger');
    document.getElementById('ledger-info').textContent = custName;
    document.getElementById('pay-amount').value = '';
    document.getElementById('pay-note').value = '';
    document.getElementById('ledger-body').innerHTML = rows.map(r =>
      '<tr>' +
      '<td>' + (r.created_at || '').slice(0, 16) + '</td>' +
      '<td><span class="badge ' + (r.type === 'DEBT' ? 'badge-pending' : 'badge-completed') + '">' + r.type + '</span></td>' +
      '<td class="num ' + (r.type === 'DEBT' ? 'warn-text' : 'success-text') + '">฿' + Math.round(r.amount).toLocaleString() + '</td>' +
      '<td class="num">฿' + Math.round(r.balance_after).toLocaleString() + '</td>' +
      '<td>' + (r.note || '') + '</td></tr>'
    ).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-3)">ไม่มีรายการ</td></tr>';
    document.getElementById('ledger-modal').style.display = 'flex';
  } catch (e) { toast('โหลดบัญชีไม่ได้', 'error'); }
}

async function recordCreditPayment() {
  const amount = parseFloat(document.getElementById('pay-amount').value) || 0;
  if (amount <= 0) { toast('ระบุจำนวนเงิน', 'error'); return; }
  try {
    await apiAdmin('POST', '/api/admin/customers/' + A.activeLedgerCust + '/payment',
      { amount, note: document.getElementById('pay-note').value });
    openLedger(A.activeLedgerCust, document.getElementById('ledger-info').textContent);
    toast('บันทึกการรับชำระแล้ว', 'success');
  } catch (e) { toast('บันทึกไม่ได้', 'error'); }
}

// ── Products ─────────────────────────────────────────────────

async function loadProducts() {
  try {
    A.products = await apiAdmin('GET', '/api/admin/products');
    document.getElementById('products-body').innerHTML = A.products.map(p =>
      '<tr>' +
      '<td>' + (p.ico || '🔵') + ' ' + p.name + '</td>' +
      '<td>' + (p.brand || '') + '</td>' +
      '<td class="num">' + (p.size_kg || 0) + ' กก.</td>' +
      '<td class="num accent-text">฿' + (p.price || 0).toLocaleString() + '</td>' +
      '<td class="num">฿' + (p.cost || 0).toLocaleString() + '</td>' +
      '<td class="num success-text">' + (p.full_qty || 0) + '</td>' +
      '<td class="num">' + (p.empty_qty || 0) + '</td>' +
      '<td><span class="badge badge-' + (p.status === 'available' ? 'completed' : p.status === 'hidden' ? 'cancelled' : 'pending') + '">' + p.status + '</span></td>' +
      '<td><button class="btn-xs" onclick="editProduct(\'' + p.id + '\')">แก้ไข</button></td>' +
      '</tr>'
    ).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text-3)">ไม่มีสินค้า</td></tr>';
  } catch (e) { toast('โหลดสินค้าไม่ได้', 'error'); }
}

function openProductModal(data) {
  ['name','brand','size_kg','ico','price','price_transfer','cost','reorder_point','sort_order'].forEach(f => {
    const el = document.getElementById('pm-' + f);
    if (el) el.value = data ? (data[f] || '') : (f === 'ico' ? '🔵' : f === 'reorder_point' ? 5 : 0);
  });
  document.getElementById('pm-id').value = data ? (data.id || '') : '';
  document.getElementById('pm-status').value = data ? (data.status || 'available') : 'available';
  document.getElementById('product-modal-title').textContent = data ? 'แก้ไขสินค้า' : 'เพิ่มสินค้า';
  document.getElementById('product-modal').style.display = 'flex';
}

async function editProduct(id) {
  const p = A.products.find(p => p.id === id);
  if (p) openProductModal(p);
}

async function saveProduct() {
  const id = document.getElementById('pm-id').value;
  const body = {
    name: document.getElementById('pm-name').value,
    brand: document.getElementById('pm-brand').value,
    size_kg: parseFloat(document.getElementById('pm-size_kg').value) || 0,
    ico: document.getElementById('pm-ico').value,
    price: parseInt(document.getElementById('pm-price').value) || 0,
    price_transfer: parseInt(document.getElementById('pm-price_transfer').value) || 0,
    cost: parseInt(document.getElementById('pm-cost').value) || 0,
    reorder_point: parseInt(document.getElementById('pm-reorder_point').value) || 5,
    sort_order: parseInt(document.getElementById('pm-sort_order').value) || 0,
    status: document.getElementById('pm-status').value,
  };
  try {
    if (id) await apiAdmin('PUT', '/api/admin/products/' + id, body);
    else await apiAdmin('POST', '/api/admin/products', body);
    closeModal('product-modal');
    loadProducts();
    toast('บันทึกแล้ว', 'success');
  } catch (e) { toast('บันทึกไม่ได้: ' + (e.message || ''), 'error'); }
}

// ── Suppliers ─────────────────────────────────────────────────

async function loadSuppliers() {
  try {
    A.suppliers = await apiAdmin('GET', '/api/admin/suppliers');
    document.getElementById('suppliers-body').innerHTML = A.suppliers.map(s =>
      '<tr>' +
      '<td>' + s.name + '</td>' +
      '<td>' + (s.brand || '—') + '</td>' +
      '<td>' + (s.phone || '—') + '</td>' +
      '<td class="num warn-text">฿' + (s.balance || 0).toLocaleString() + '</td>' +
      '<td><button class="btn-xs" onclick="editSupplier(\'' + s.id + '\')">แก้ไข</button> ' +
      '<button class="btn-xs" onclick="viewStatement(\'' + s.id + '\')">Statement</button></td>' +
      '</tr>'
    ).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-3)">ไม่มีข้อมูล</td></tr>';
  } catch (e) {}
}

function openSupplierModal(data) {
  ['name','brand','phone','tax_id','address'].forEach(f => {
    const el = document.getElementById('sup-' + f);
    if (el) el.value = data ? (data[f] || '') : '';
  });
  document.getElementById('sup-id').value = data ? (data.id || '') : '';
  document.getElementById('sup-credit_days').value = data ? (data.credit_days || 30) : 30;
  document.getElementById('supplier-modal').style.display = 'flex';
}

async function editSupplier(id) {
  const s = A.suppliers.find(s => s.id === id);
  if (s) openSupplierModal(s);
}

async function saveSupplier() {
  const id = document.getElementById('sup-id').value;
  const body = {
    name: document.getElementById('sup-name').value,
    brand: document.getElementById('sup-brand').value,
    phone: document.getElementById('sup-phone').value,
    tax_id: document.getElementById('sup-tax_id').value,
    address: document.getElementById('sup-address').value,
    credit_days: parseInt(document.getElementById('sup-credit_days').value) || 30,
  };
  try {
    if (id) await apiAdmin('PUT', '/api/admin/suppliers/' + id, body);
    else await apiAdmin('POST', '/api/admin/suppliers', body);
    closeModal('supplier-modal');
    loadSuppliers();
    toast('บันทึกแล้ว', 'success');
  } catch (e) { toast('บันทึกไม่ได้', 'error'); }
}

async function viewStatement(supId) {
  try {
    const d = await apiAdmin('GET', '/api/admin/suppliers/' + supId + '/statement');
    const sup = d.supplier;
    const invRows = (d.invoices || []).map(i =>
      i.batch_id + ' | ' + i.date + ' | ฿' + (i.total_cost || 0).toLocaleString() + ' | ' + i.status
    ).join('\n');
    const payRows = (d.payments || []).map(p =>
      p.date + ' | ฿' + (p.amount || 0).toLocaleString() + ' | ' + p.method
    ).join('\n');
    alert('Statement: ' + sup.name + '\nยอดค้าง: ฿' + (sup.balance || 0).toLocaleString() +
      '\n\nInvoices:\n' + (invRows || 'ไม่มี') +
      '\n\nPayments:\n' + (payRows || 'ไม่มี'));
  } catch (e) {}
}

// ── Restock ───────────────────────────────────────────────────

async function loadRestock() {
  try {
    const rows = await apiAdmin('GET', '/api/admin/restock');
    A.restockList = rows;  // cache for detail popup
    document.getElementById('restock-body').innerHTML = rows.map((r, idx) => {
      const total = r.net_total ?? r.gross_total ?? r.total_cost ?? 0;
      return '<tr>' +
        '<td class="accent-text">' + (r.batch_id || r.id) + '</td>' +
        '<td>' + (r.date || '') + '</td>' +
        '<td>' + (r.supplier_name || '—') + '</td>' +
        '<td>' + (r.invoice_num || '—') + '</td>' +
        '<td class="num">฿' + Math.round(total).toLocaleString() + '</td>' +
        '<td><span class="badge badge-' + (r.status === 'paid' ? 'completed' : 'pending') + '">' + r.status + '</span></td>' +
        '<td><button class="btn-xs" onclick="showRestockDetail(' + idx + ')">ดูรายการ</button></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text-3)">ไม่มีข้อมูล</td></tr>';
  } catch (e) {}
}

// Show restock invoice detail in a styled modal
function showRestockDetail(idx) {
  const r = (A.restockList || [])[idx];
  if (!r) return;
  const items = r.items || [];
  const itemsTotal = items.reduce((s, i) => s + (i.subtotal || (i.qty * i.cost_per_unit) || 0), 0);
  const fmt = v => '฿' + Math.round(v || 0).toLocaleString();

  let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;font-size:0.88rem">'
    + '<div><div class="label-tiny">Batch ID</div><div class="accent-text" style="font-weight:600">' + (r.batch_id || '—') + '</div></div>'
    + '<div><div class="label-tiny">วันที่</div><div>' + (r.date || '—') + '</div></div>'
    + '<div><div class="label-tiny">Supplier</div><div>' + (r.supplier_name || '—') + '</div></div>'
    + '<div><div class="label-tiny">เลขที่ใบกำกับ</div><div>' + (r.invoice_num || '—') + '</div></div>'
    + '<div><div class="label-tiny">ประเภทเอกสาร</div><div>' + (r.doc_type === 'tax' ? 'ใบกำกับภาษี' : 'ใบเสร็จ') + '</div></div>'
    + '<div><div class="label-tiny">ผู้บันทึก</div><div>' + (r.created_by || '—') + '</div></div>'
    + '</div>';

  html += '<table style="width:100%;border-collapse:collapse;font-size:0.85rem;margin-bottom:14px">'
    + '<thead><tr style="border-bottom:1px solid var(--border-hairline);color:var(--text-3)">'
    + '<th style="text-align:left;padding:6px">สินค้า</th>'
    + '<th style="text-align:right;padding:6px">จำนวน</th>'
    + '<th style="text-align:right;padding:6px">ต้นทุน/หน่วย</th>'
    + '<th style="text-align:right;padding:6px">รวม</th>'
    + '</tr></thead><tbody>';
  items.forEach(i => {
    html += '<tr style="border-bottom:1px solid var(--border-hairline)">'
      + '<td style="padding:6px">' + (i.product_name || '—') + '</td>'
      + '<td style="text-align:right;padding:6px">' + (i.qty || 0) + '</td>'
      + '<td style="text-align:right;padding:6px">' + fmt(i.cost_per_unit) + '</td>'
      + '<td style="text-align:right;padding:6px">' + fmt(i.subtotal) + '</td>'
      + '</tr>';
  });
  html += '</tbody></table>';

  html += '<div style="background:var(--bg-surface);padding:12px;border-radius:6px;font-size:0.88rem">'
    + '<div style="display:flex;justify-content:space-between;padding:3px 0"><span>ยอดสินค้า</span><span>' + fmt(itemsTotal) + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:3px 0"><span>VAT</span><span>' + fmt(r.vat_amount) + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:3px 0"><span>ยอดก่อนหักถังเปล่า</span><span>' + fmt(r.gross_total) + '</span></div>';
  if ((r.tare_weight_kg || 0) > 0) {
    html += '<div style="display:flex;justify-content:space-between;padding:3px 0;color:var(--success)"><span>หักถังเปล่า ' + r.tare_weight_kg + ' กก. × ฿' + r.tare_rate + '</span><span>-' + fmt(r.tare_discount) + '</span></div>';
  }
  html += '<div style="display:flex;justify-content:space-between;padding:6px 0;margin-top:6px;border-top:1px solid var(--border-hairline);font-weight:600;font-size:1rem"><span>ยอดสุทธิ</span><span class="accent-text">' + fmt(r.net_total) + '</span></div>'
    + '</div>';

  if (r.pickup_staff_name) {
    html += '<div style="margin-top:10px;font-size:0.82rem;color:var(--text-3)">พนักงานรับสินค้า: ' + r.pickup_staff_name + '</div>';
  }
  if (r.note) {
    html += '<div style="margin-top:10px;font-size:0.82rem"><strong>หมายเหตุ:</strong> ' + r.note + '</div>';
  }

  // Inject into modal
  let modal = document.getElementById('restock-detail-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'restock-detail-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.innerHTML = '<div class="modal-box" style="max-width:640px">'
      + '<div class="modal-title" id="rdm-title">รายละเอียดใบรับสินค้า</div>'
      + '<div id="rdm-body"></div>'
      + '<div class="modal-actions"><button class="btn btn-secondary" onclick="closeModal(\'restock-detail-modal\')">ปิด</button></div>'
      + '</div>';
    document.body.appendChild(modal);
  }
  document.getElementById('rdm-body').innerHTML = html;
  modal.style.display = 'flex';
}

function openRestockModal() {
  A.restockItems = [];
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('rm-date').value = today;
  document.getElementById('rm-supplier_id').innerHTML =
    A.suppliers.map(s => '<option value="' + s.id + '">' + s.name + '</option>').join('');
  renderRestockItems();
  document.getElementById('restock-modal').style.display = 'flex';
}

function addRestockItem() {
  A.restockItems.push({ product_id: '', qty: 1, cost_per_unit: 0 });
  renderRestockItems();
}

function renderRestockItems() {
  const container = document.getElementById('rm-items');
  const inner = A.restockItems.map((item, i) =>
    '<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">' +
    '<select class="filter-select" style="flex:2" onchange="A.restockItems[' + i + '].product_id=this.value">' +
    '<option value="">-- สินค้า --</option>' +
    A.products.map(p =>
      '<option value="' + p.id + '" ' + (item.product_id === p.id ? 'selected' : '') + '>' + p.name + '</option>'
    ).join('') +
    '</select>' +
    '<input class="filter-input" type="number" style="width:70px" placeholder="จำนวน" value="' + item.qty + '" ' +
    'onchange="A.restockItems[' + i + '].qty=parseInt(this.value)||0">' +
    '<input class="filter-input" type="number" style="width:90px" placeholder="ต้นทุน/ถัง" value="' + item.cost_per_unit + '" ' +
    'onchange="A.restockItems[' + i + '].cost_per_unit=parseFloat(this.value)||0">' +
    '<button class="btn-xs danger" onclick="A.restockItems.splice(' + i + ',1);renderRestockItems()">✕</button>' +
    '</div>'
  ).join('');
  container.innerHTML =
    '<div style="font-size:0.82rem;color:var(--text-3);margin-bottom:6px">รายการสินค้า</div>' +
    inner;
}

async function saveRestock() {
  if (!A.restockItems.length) { toast('เพิ่มรายการสินค้าก่อน', 'error'); return; }
  const body = {
    date: document.getElementById('rm-date').value,
    supplier_id: document.getElementById('rm-supplier_id').value,
    invoice_num: document.getElementById('rm-invoice_num').value,
    doc_type: document.getElementById('rm-doc_type').value,
    items: A.restockItems.filter(i => i.product_id && i.qty > 0),
  };
  try {
    const res = await apiAdmin('POST', '/api/supervisor/restock', body);
    closeModal('restock-modal');
    // Refresh both restock list AND products (because stock changed)
    await loadRestock();
    if (typeof loadProducts === 'function') await loadProducts();
    toast('รับสินค้า Batch ' + res.batch_id + ' รวม ฿' + Math.round(res.net_total || res.gross_total || 0).toLocaleString() + ' แล้ว', 'success');
  } catch (e) { toast('รับสินค้าไม่ได้: ' + (e.message || ''), 'error'); }
}

// ── Expenses ─────────────────────────────────────────────────

async function loadExpenses() {
  const from = document.getElementById('exp-from').value;
  const to = document.getElementById('exp-to').value;
  let q = '?';
  if (from) q += 'from=' + from + '&';
  if (to) q += 'to=' + to;
  try {
    const rows = await apiAdmin('GET', '/api/admin/expenses' + q);
    const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
    document.getElementById('expenses-body').innerHTML = rows.map(r =>
      '<tr>' +
      '<td>' + (r.date || '') + '</td>' +
      '<td>' + (r.type || '—') + '</td>' +
      '<td>' + (r.note || '') + '</td>' +
      '<td>' + (r.to_party || '—') + '</td>' +
      '<td class="num warn-text">฿' + (r.amount || 0).toLocaleString() + '</td>' +
      '<td>' + (r.category || '') + '</td>' +
      '</tr>'
    ).join('') + '<tr style="font-weight:bold;border-top:2px solid var(--border)"><td colspan="4">รวม</td><td class="num accent-text">฿' + total.toLocaleString() + '</td><td></td></tr>';
  } catch (e) {}
}

function openExpenseModal() {
  document.getElementById('em-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('em-amount').value = '';
  document.getElementById('em-type').value = '';
  document.getElementById('em-note').value = '';
  document.getElementById('em-to_party').value = '';
  document.getElementById('expense-modal').style.display = 'flex';
}

async function saveExpense() {
  const body = {
    date: document.getElementById('em-date').value,
    category: document.getElementById('em-category').value,
    type: document.getElementById('em-type').value,
    to_party: document.getElementById('em-to_party').value,
    amount: parseInt(document.getElementById('em-amount').value) || 0,
    doc_type: document.getElementById('em-doc_type').value,
    note: document.getElementById('em-note').value,
  };
  if (!body.amount) { toast('ระบุจำนวนเงิน', 'error'); return; }
  try {
    await apiAdmin('POST', '/api/admin/expenses', body);
    closeModal('expense-modal');
    loadExpenses();
    toast('บันทึกรายจ่ายแล้ว', 'success');
  } catch (e) { toast('บันทึกไม่ได้', 'error'); }
}

// ── VAT ──────────────────────────────────────────────────────

async function loadVAT() {
  const period = document.getElementById('vat-period').value ||
    new Date().toISOString().slice(0, 7);
  try {
    const d = await apiAdmin('GET', '/api/admin/vat-report?period=' + period);
    document.getElementById('vat-out').textContent = '฿' + Math.round(d.output_vat || 0).toLocaleString();
    document.getElementById('vat-in').textContent = '฿' + Math.round(d.input_vat || 0).toLocaleString();
    const pay = d.payable || 0;
    document.getElementById('vat-payable').textContent = '฿' + Math.round(pay).toLocaleString();
    document.getElementById('vat-out-body').innerHTML = (d.output || []).map(r =>
      '<tr><td>' + (r.date || '') + '</td><td>' + (r.customer_name || '') + '</td>' +
      '<td class="num">฿' + Math.round(r.base_amount || 0).toLocaleString() + '</td>' +
      '<td class="num accent-text">฿' + Math.round(r.vat_amount || 0).toLocaleString() + '</td></tr>'
    ).join('');
    document.getElementById('vat-in-body').innerHTML = (d.input || []).map(r =>
      '<tr><td>' + (r.date || '') + '</td><td>' + (r.supplier_name || '') + '</td>' +
      '<td class="num">฿' + Math.round(r.base_amount || 0).toLocaleString() + '</td>' +
      '<td class="num success-text">฿' + Math.round(r.vat_amount || 0).toLocaleString() + '</td></tr>'
    ).join('');
  } catch (e) { toast('โหลด VAT ไม่ได้', 'error'); }
}

function exportVATCSV() {
  const period = document.getElementById('vat-period').value || new Date().toISOString().slice(0, 7);
  const out = [...document.querySelectorAll('#vat-out-body tr')].map(tr => {
    const cells = [...tr.querySelectorAll('td')];
    return [period, cells[0]?.textContent, cells[1]?.textContent, cells[2]?.textContent, cells[3]?.textContent, 'output'].map(v => '"' + v + '"').join(',');
  });
  const inp = [...document.querySelectorAll('#vat-in-body tr')].map(tr => {
    const cells = [...tr.querySelectorAll('td')];
    return [period, cells[0]?.textContent, cells[1]?.textContent, cells[2]?.textContent, cells[3]?.textContent, 'input'].map(v => '"' + v + '"').join(',');
  });
  const header = '"เดือน","วันที่","คู่ค้า","ยอดก่อนภาษี","VAT","ประเภท"';
  downloadCSV([header, ...out, ...inp].join('\n'), 'vat_' + period + '.csv');
}

// ── Staff ─────────────────────────────────────────────────────

async function loadStaff() {
  try {
    const rows = await apiAdmin('GET', '/api/admin/staff');
    document.getElementById('staff-body').innerHTML = rows.map(s =>
      '<tr>' +
      '<td>' + s.name + '</td>' +
      '<td><span class="badge badge-' + (s.role === 'admin' ? 'b2b' : s.role === 'supervisor' ? 'delivering' : 'retail') + '">' + s.role + '</span></td>' +
      '<td style="font-family:monospace">****</td>' +
      '<td>' + (s.vehicle || '—') + '</td>' +
      '<td class="num">฿' + (s.salary || 0).toLocaleString() + '</td>' +
      '<td><span class="badge ' + (s.active ? 'badge-completed' : 'badge-cancelled') + '">' + (s.active ? 'ใช้งาน' : 'ปิด') + '</span></td>' +
      '<td><button class="btn-xs" onclick="editStaff(\'' + s.id + '\')">แก้ไข</button></td>' +
      '</tr>'
    ).join('');
    A._staffList = rows;
  } catch (e) {}
}

function openStaffModal(data) {
  ['name','phone','salary','commission_per_order','start_date'].forEach(f => {
    const el = document.getElementById('sm-' + f);
    if (el) el.value = data ? (data[f] || '') : '';
  });
  document.getElementById('sm-id').value = data ? (data.id || '') : '';
  document.getElementById('sm-role').value = data ? (data.role || 'driver') : 'driver';
  document.getElementById('sm-vehicle').value = data ? (data.vehicle || 'bike') : 'bike';
  document.getElementById('sm-pin').value = '';
  document.getElementById('staff-modal').style.display = 'flex';
}

async function editStaff(id) {
  const s = (A._staffList || []).find(s => s.id === id);
  if (s) openStaffModal(s);
}

async function saveStaff() {
  const id      = document.getElementById('sm-id').value;
  const newPin  = document.getElementById('sm-pin').value;
  const body = {
    name: document.getElementById('sm-name').value,
    phone: document.getElementById('sm-phone').value,
    role: document.getElementById('sm-role').value,
    vehicle: document.getElementById('sm-vehicle').value,
    salary: parseInt(document.getElementById('sm-salary').value) || 0,
    commission_per_order: parseInt(document.getElementById('sm-commission_per_order').value) || 0,
    start_date: document.getElementById('sm-start_date').value,
  };
  if (newPin) body.pin = newPin;
  try {
    if (id) await apiAdmin('PUT', '/api/admin/staff/' + id, body);
    else await apiAdmin('POST', '/api/admin/staff', body);
    closeModal('staff-modal');
    loadStaff();
    toast('บันทึกแล้ว', 'success');
  } catch (e) { toast('บันทึกไม่ได้: ' + (e.message || ''), 'error'); }
}

// ── Audit ─────────────────────────────────────────────────────

async function loadAudit() {
  const date = document.getElementById('audit-date').value;
  const actor = document.getElementById('audit-actor').value;
  const action = document.getElementById('audit-action').value;
  let q = '?limit=100';
  if (date) q += '&date=' + date;
  if (actor) q += '&actor=' + encodeURIComponent(actor);
  if (action) q += '&action=' + action;
  try {
    const rows = await apiAdmin('GET', '/api/admin/audit' + q);
    document.getElementById('audit-body').innerHTML = rows.map(r =>
      '<tr>' +
      '<td style="white-space:nowrap;font-size:0.78rem">' + (r.timestamp || '').slice(0, 16) + '</td>' +
      '<td class="accent-text">' + (r.actor_name || '—') + '</td>' +
      '<td><span class="badge badge-' + (r.actor_role === 'admin' ? 'b2b' : 'retail') + '">' + (r.actor_role || '') + '</span></td>' +
      '<td>' + r.action + '</td>' +
      '<td style="font-size:0.78rem">' + (r.target_type || '') + ':' + (r.target_id || '') + '</td>' +
      '<td style="font-size:0.78rem;color:var(--text-3);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      (r.detail_json || '') + '</td>' +
      '</tr>'
    ).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-3)">ไม่มีข้อมูล</td></tr>';
  } catch (e) {}
}

// ── Settings ─────────────────────────────────────────────────

async function loadSettings() {
  try {
    const d = await apiAdmin('GET', '/api/admin/settings');
    ['shop_name','shop_phone','shop_tax_id','shop_address',
     'open_time','close_time','promptpay','promptpay_name',
     'line_token_order','line_token_stock','sheets_webhook',
     'slipok_key','api_key'].forEach(k => {
      const el = document.getElementById('s-' + k);
      if (el) el.value = d[k] || '';
    });
  } catch (e) {}
}

async function saveSettings() {
  const keys = ['shop_name','shop_phone','shop_tax_id','shop_address',
                'open_time','close_time','promptpay','promptpay_name',
                'line_token_order','line_token_stock','sheets_webhook',
                'slipok_key','api_key'];
  const body = {};
  keys.forEach(k => {
    const el = document.getElementById('s-' + k);
    if (el) body[k] = el.value;
  });
  try {
    await apiAdmin('POST', '/api/admin/settings', body);
    toast('บันทึกการตั้งค่าแล้ว', 'success');
  } catch (e) { toast('บันทึกไม่ได้', 'error'); }
}

// ── Staff Bonus Log view ──────────────────────────────────────

async function loadBonus() {
  try {
    const d = await apiAdmin('GET', '/api/admin/staff-bonus-log');
    const rows = d.log || d || [];
    document.getElementById('bonus-body').innerHTML = rows.map(r =>
      '<tr>' +
      '<td>' + (r.created_at || '').slice(0, 16) + '</td>' +
      '<td>' + (r.staff_name || '') + '</td>' +
      '<td class="num">' + (r.tare_weight_kg || 0) + ' กก.</td>' +
      '<td class="num">฿' + (r.rate_per_kg || 0) + '</td>' +
      '<td class="num success-text">฿' + (r.amount || 0).toLocaleString() + '</td>' +
      '<td>' + (r.note || '') + '</td>' +
      '</tr>'
    ).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-3)">ไม่มีข้อมูล</td></tr>';
  } catch (e) { toast('โหลดไม่ได้', 'error'); }
}

// ── Translations view ─────────────────────────────────────────

async function loadTranslations() {
  try {
    const d = await apiAdmin('GET', '/api/admin/translations');
    const rows = d.translations || d || [];
    document.getElementById('trans-body').innerHTML = rows.map(r =>
      '<tr>' +
      '<td>' + r.lang_code + '</td>' +
      '<td>' + r.key + '</td>' +
      '<td>' +
      '<input class="filter-input" style="width:100%" value="' + r.value.replace(/"/g, '&quot;') + '" ' +
      'onblur="saveTrans(\'' + r.id + '\',this.value)">' +
      '</td>' +
      '</tr>'
    ).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--text-3)">ไม่มีข้อมูล</td></tr>';
  } catch (e) { toast('โหลดไม่ได้', 'error'); }
}

async function saveTrans(id, value) {
  try {
    await apiAdmin('PUT', '/api/admin/translations', { id, value });
    toast('บันทึกแล้ว', 'success');
  } catch (e) { toast('บันทึกไม่ได้', 'error'); }
}

// ── Utils ─────────────────────────────────────────────────────

function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function toast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || '');
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3000);
}

function downloadCSV(content, filename) {
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
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

async function apiAdmin(method, path, body) {
  return api(method, path, body);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
  }
});

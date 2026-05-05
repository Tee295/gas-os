/* order.js — Customer Order App */
'use strict';

// ─── i18n ───────────────────────────────────────────────────────────────────
const T = {
  th: {
    choose_lang:'เลือกภาษา', back:'กลับ', next:'ต่อไป', confirm:'ยืนยัน',
    enter_phone:'กรอกเบอร์โทรศัพท์', phone_sub:'เบอร์ 10 หลัก เพื่อติดตามคำสั่งซื้อ',
    choose_type:'เลือกประเภทการสั่งซื้อ',
    walkin:'มารับเอง', walkin_desc:'รับที่ร้าน',
    delivery:'จัดส่ง', delivery_desc:'ส่งถึงบ้าน',
    repeat_order:'สั่งรายการเดิม',
    choose_products:'เลือกสินค้า',
    exchange:'เปลี่ยนถัง', new_tank:'ถังใหม่',
    out_of_stock:'หมด', in_stock:'คงเหลือ',
    set_address:'ระบุที่อยู่จัดส่ง', address_sub:'แตะแผนที่เพื่อปักหมุด',
    address_detail:'รายละเอียดที่อยู่', landmark:'จุดสังเกต (ไม่บังคับ)',
    confirm_address:'ยืนยันที่อยู่',
    choose_payment:'เลือกวิธีชำระเงิน',
    review_order:'ตรวจสอบคำสั่งซื้อ',
    subtotal:'ยอดสินค้า', delivery_fee:'ค่าจัดส่ง',
    vat_incl:'VAT 7% (รวมแล้ว)', total:'รวมทั้งหมด',
    payment_method:'ชำระด้วย', address:'ที่อยู่',
    submit_order:'สั่งซื้อเลย',
    order_status:'สถานะคำสั่งซื้อ', order_num:'เลขที่',
    driver:'คนส่ง', warranty_title:'รับประกันการติดตั้ง 7 วัน',
    warranty_exp:'หมดประกัน',
    new_order:'สั่งซื้อใหม่',
    status_pending:'รอยืนยัน', status_preparing:'กำลังเตรียม',
    status_delivering:'กำลังส่ง', status_completed:'ส่งสำเร็จ',
    greeting:'สวัสดี',
    items_in_cart:'รายการ', baht:'฿',
    address_required:'กรุณาระบุที่อยู่',
    submitting:'กำลังส่ง...', submit_error:'เกิดข้อผิดพลาด กรุณาลองใหม่',
    items:'รายการ',
  },
  en: {
    choose_lang:'Choose Language', back:'Back', next:'Next', confirm:'Confirm',
    enter_phone:'Enter Phone Number', phone_sub:'10-digit number to track your order',
    choose_type:'Order Type',
    walkin:'Pick Up', walkin_desc:'Collect at shop',
    delivery:'Delivery', delivery_desc:'Delivered to door',
    repeat_order:'Repeat Last Order',
    choose_products:'Select Products',
    exchange:'Exchange Tank', new_tank:'New Tank',
    out_of_stock:'Out of Stock', in_stock:'In Stock',
    set_address:'Delivery Address', address_sub:'Tap the map to drop a pin',
    address_detail:'Address Detail', landmark:'Landmark (optional)',
    confirm_address:'Confirm Address',
    choose_payment:'Payment Method',
    review_order:'Review Order',
    subtotal:'Subtotal', delivery_fee:'Delivery Fee',
    vat_incl:'VAT 7% (incl.)', total:'Total',
    payment_method:'Payment', address:'Address',
    submit_order:'Place Order',
    order_status:'Order Status', order_num:'Order #',
    driver:'Driver', warranty_title:'7-Day Installation Warranty',
    warranty_exp:'Expires',
    new_order:'New Order',
    status_pending:'Pending', status_preparing:'Preparing',
    status_delivering:'Out for Delivery', status_completed:'Delivered',
    greeting:'Hello',
    items_in_cart:'items', baht:'฿',
    address_required:'Please set your delivery address',
    submitting:'Submitting...', submit_error:'Error — please try again',
    items:'items',
  },
  my: {
    choose_lang:'ဘာသာစကားရွေးပါ', back:'နောက်', next:'ရှေ့', confirm:'အတည်ပြုမည်',
    enter_phone:'ဖုန်းနံပါတ်ထည့်ပါ', phone_sub:'အမှာစာခြေရာခံရန် ဂဏန်း ၁၀ လုံး',
    choose_type:'အမျိုးအစားရွေးပါ',
    walkin:'ဆိုင်မှာယူ', walkin_desc:'ဆိုင်မှာလာယူ',
    delivery:'ပို့ဆောင်', delivery_desc:'အိမ်တိုင်ပါ',
    repeat_order:'ယခင်အမှာပြန်ညှိ',
    choose_products:'ကုန်ပစ္စည်းရွေးပါ',
    exchange:'ဘူးလဲ', new_tank:'ဘူးသစ်',
    out_of_stock:'မရှိ', in_stock:'ကျန်',
    set_address:'ပို့ဆောင်လိပ်စာ', address_sub:'မြေပုံကိုနှိပ်ပါ',
    address_detail:'လိပ်စာအသေးစိတ်', landmark:'မှတ်သားချက်',
    confirm_address:'လိပ်စာ အတည်ပြု',
    choose_payment:'ငွေပေးချေမည့်နည်း',
    review_order:'အမှာစစ်ဆေးပါ',
    subtotal:'ကုန်ပစ္စည်း', delivery_fee:'ပို့ဆောင်ခ',
    vat_incl:'VAT 7% (ပါပြီး)', total:'စုစုပေါင်း',
    payment_method:'ငွေပေးချေမည်', address:'လိပ်စာ',
    submit_order:'အမှာတင်မည်',
    order_status:'အမှာအခြေအနေ', order_num:'အမှာနံပါတ်',
    driver:'ပို့သူ', warranty_title:'အာမခံ ၇ ရက်',
    warranty_exp:'သက်တမ်းကုန်',
    new_order:'အမှာသစ်',
    status_pending:'စောင့်ဆိုင်းနေ', status_preparing:'ပြင်ဆင်နေ',
    status_delivering:'ပို့နေ', status_completed:'ရောက်ပြီ',
    greeting:'မင်္ဂလာပါ',
    items_in_cart:'မျိုး', baht:'฿',
    address_required:'လိပ်စာထည့်ပါ',
    submitting:'ပို့နေ...', submit_error:'အမှားဖြစ်သည်',
    items:'မျိုး',
  },
  ko: {
    choose_lang:'언어 선택', back:'뒤로', next:'다음', confirm:'확인',
    enter_phone:'전화번호 입력', phone_sub:'주문 추적을 위한 10자리 번호',
    choose_type:'주문 유형 선택',
    walkin:'직접 수령', walkin_desc:'매장에서 수령',
    delivery:'배달', delivery_desc:'집으로 배달',
    repeat_order:'이전 주문 반복',
    choose_products:'상품 선택',
    exchange:'통 교환', new_tank:'새 통',
    out_of_stock:'품절', in_stock:'재고',
    set_address:'배달 주소', address_sub:'지도를 눌러 위치를 설정하세요',
    address_detail:'상세 주소', landmark:'랜드마크 (선택)',
    confirm_address:'주소 확인',
    choose_payment:'결제 방법',
    review_order:'주문 확인',
    subtotal:'상품 합계', delivery_fee:'배달비',
    vat_incl:'부가세 7% (포함)', total:'합계',
    payment_method:'결제', address:'주소',
    submit_order:'주문하기',
    order_status:'주문 상태', order_num:'주문번호',
    driver:'배달기사', warranty_title:'7일 설치 보증',
    warranty_exp:'만료',
    new_order:'새 주문',
    status_pending:'대기중', status_preparing:'준비중',
    status_delivering:'배달중', status_completed:'완료',
    greeting:'안녕하세요',
    items_in_cart:'개', baht:'฿',
    address_required:'배달 주소를 입력해주세요',
    submitting:'처리중...', submit_error:'오류 발생, 다시 시도해주세요',
    items:'개',
  },
  zh: {
    choose_lang:'选择语言', back:'返回', next:'下一步', confirm:'确认',
    enter_phone:'输入手机号码', phone_sub:'10位数字以跟踪您的订单',
    choose_type:'选择订单类型',
    walkin:'自取', walkin_desc:'到店自取',
    delivery:'配送', delivery_desc:'送货上门',
    repeat_order:'重复上次订单',
    choose_products:'选择产品',
    exchange:'换气罐', new_tank:'新气罐',
    out_of_stock:'缺货', in_stock:'库存',
    set_address:'配送地址', address_sub:'点击地图设置位置',
    address_detail:'详细地址', landmark:'地标（可选）',
    confirm_address:'确认地址',
    choose_payment:'支付方式',
    review_order:'确认订单',
    subtotal:'小计', delivery_fee:'配送费',
    vat_incl:'含税 7%', total:'合计',
    payment_method:'付款', address:'地址',
    submit_order:'下单',
    order_status:'订单状态', order_num:'订单号',
    driver:'配送员', warranty_title:'7天安装保修',
    warranty_exp:'到期',
    new_order:'新订单',
    status_pending:'待确认', status_preparing:'准备中',
    status_delivering:'配送中', status_completed:'已送达',
    greeting:'您好',
    items_in_cart:'件', baht:'฿',
    address_required:'请设置配送地址',
    submitting:'提交中...', submit_error:'出错了，请重试',
    items:'件',
  }
};

const LANG_META = {
  th:  { flag:'🇹🇭', native:'ภาษาไทย',  name:'Thai' },
  en:  { flag:'🇬🇧', native:'English',   name:'English' },
  my:  { flag:'🇲🇲', native:'မြန်မာ',     name:'Burmese' },
  ko:  { flag:'🇰🇷', native:'한국어',     name:'Korean' },
  zh:  { flag:'🇨🇳', native:'中文',       name:'Chinese' },
};

// ─── State ───────────────────────────────────────────────────────────────────
const S = {
  lang: 'th',
  phone: '',
  customer: null,
  orderType: null,   // 'walkin' | 'delivery'
  serviceType: 'exchange',
  products: [],
  cart: [],          // [{product_id, name, qty, price}]
  fees: [],
  paymentMethods: [],
  selectedPayment: null,
  address: { text: '', note: '', lat: null, lng: null },
  currentStep: 0,
  currentOrderNum: null,
  trackTimer: null,
  mapInit: false,
  mapObj: null,
  mapMarker: null,
  submitting: false,
  availLangs: [],
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  loadLanguages();

  document.getElementById('btn-change-lang').addEventListener('click', () => goStep(0));
});

async function loadConfig() {
  try {
    const [prodRes, feeRes, pmRes] = await Promise.all([
      fetch('/api/customer/products'),
      fetch('/api/customer/fees'),
      fetch('/api/customer/payment-methods'),
    ]);
    S.products = await prodRes.json();
    if (!Array.isArray(S.products)) S.products = [];
    const feeData = await feeRes.json();
    S.fees = feeData.fees || feeData || [];
    const pmData = await pmRes.json();
    S.paymentMethods = pmData.methods || pmData || [];
  } catch (e) {
    console.error('loadConfig error', e);
  }
}

async function loadLanguages() {
  try {
    const res = await fetch('/customer/settings');
    const data = await res.json();
    // Use hardcoded lang list but filter by what server says is active if available
    S.availLangs = Object.keys(LANG_META);
  } catch (e) {
    S.availLangs = Object.keys(LANG_META);
  }
  renderLangGrid();
}

// ─── Language ─────────────────────────────────────────────────────────────────
function renderLangGrid() {
  const grid = document.getElementById('lang-grid');
  grid.innerHTML = S.availLangs.map(code => {
    const m = LANG_META[code];
    if (!m) return '';
    return '<div class="lang-btn' + (S.lang === code ? ' active' : '') + '" onclick="setLang(\'' + code + '\')">'
      + '<div class="lang-flag">' + m.flag + '</div>'
      + '<div class="lang-native">' + m.native + '</div>'
      + '<div class="lang-name">' + m.name + '</div>'
      + '</div>';
  }).join('');
}

function setLang(code) {
  S.lang = code;
  renderLangGrid();
  applyI18n();
  goStep(1);
}

function t(key) {
  return (T[S.lang] && T[S.lang][key]) ? T[S.lang][key] : (T.th[key] || key);
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
}

// ─── Steps ────────────────────────────────────────────────────────────────────
// Step ids: 0=lang, 1=phone, 1.5=register (handled separately), 2=type, 3=products, 4=address, 5=payment, 6=review, 7=track
function goStep(n) {
  if (n === 4 && S.orderType !== 'delivery') {
    goStep(5); return;
  }

  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  const steps = ['step-lang','step-phone','step-type','step-products','step-address','step-payment','step-review','step-track'];
  const el = document.getElementById(steps[n]);
  if (!el) return;
  el.classList.add('active');
  S.currentStep = n;
  window.scrollTo(0, 0);
  applyI18n();

  if (n === 3) renderProducts();
  if (n === 4) initAddressStep();
  if (n === 5) renderPayments();
  if (n === 6) renderReview();
}

function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
  applyI18n();
}

// ─── Phone Entry ──────────────────────────────────────────────────────────────
function numKey(d) {
  if (S.phone.length >= 10) return;
  S.phone += d;
  updatePhoneDisplay();
}

function delKey() {
  S.phone = S.phone.slice(0, -1);
  updatePhoneDisplay();
}

function updatePhoneDisplay() {
  const el = document.getElementById('phone-digits');
  el.textContent = S.phone || '—';
  document.getElementById('btn-confirm-phone').disabled = S.phone.length !== 10;
}

async function confirmPhone() {
  if (S.phone.length !== 10) return;
  try {
    const res  = await fetch('/api/customer/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: S.phone }),
    });
    const data = await res.json();
    if (data.is_new) {
      // New customer — show registration step
      S.customer = { phone: S.phone, name: '' };
      const el = document.getElementById('reg-phone');
      if (el) el.textContent = S.phone;
      showStep('step-register');
    } else {
      S.customer = data.customer;
      // Load saved addresses for delivery step
      if (S.customer && S.customer.id) {
        loadSavedAddresses(S.customer.id);
      }
      goStep(2);
      renderTypeStep();
    }
  } catch (e) {
    S.customer = { phone: S.phone, name: '' };
    goStep(2);
    renderTypeStep();
  }
}

// ─── Customer Registration ────────────────────────────────────────────────────
async function registerCustomer() {
  const name    = (document.getElementById('reg-name').value || '').trim();
  const address = (document.getElementById('reg-address').value || '').trim();
  const errEl   = document.getElementById('reg-error');

  if (!name) { errEl.textContent = 'กรุณากรอกชื่อ'; return; }
  errEl.textContent = '';

  try {
    const res  = await fetch('/api/customer/register', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: S.phone, name, address }),
    });
    const data = await res.json();
    if (res.ok) {
      S.customer = { phone: S.phone, name, address, id: data.customer_id, tier: 'retail', last_order_items: [] };
      goStep(2);
      renderTypeStep();
    } else {
      errEl.textContent = data.error || 'ลงทะเบียนไม่สำเร็จ';
    }
  } catch (e) {
    errEl.textContent = 'เชื่อมต่อไม่ได้ กรุณาลองใหม่';
  }

}

async function loadSavedAddresses(customerId) {
  try {
    const res  = await fetch('/api/customer/addresses/' + customerId);
    S.savedAddresses = await res.json();
  } catch (e) { S.savedAddresses = []; }
}

// ─── Order Type ───────────────────────────────────────────────────────────────
function renderTypeStep() {
  const name = S.customer && S.customer.name ? S.customer.name : S.phone;
  const greet = document.getElementById('user-greeting');
  greet.textContent = t('greeting') + ', ' + name + ' 👋';

  // Repeat last order
  const banner = document.getElementById('repeat-banner');
  if (S.customer && S.customer.last_order_items && S.customer.last_order_items.length > 0) {
    const summary = S.customer.last_order_items.map(i => i.name + ' x' + i.qty).join(', ');
    document.getElementById('repeat-items-text').textContent = summary;
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

function selectType(t_) {
  S.orderType = t_;
  document.getElementById('card-walkin').classList.toggle('active', t_ === 'walkin');
  document.getElementById('card-delivery').classList.toggle('active', t_ === 'delivery');
  document.getElementById('btn-type-next').disabled = false;
}

function repeatLastOrder() {
  if (!S.customer || !S.customer.last_order_items) return;
  S.cart = S.customer.last_order_items.map(i => ({
    product_id: i.product_id,
    name: i.name,
    qty: i.qty,
    price: i.price,
  }));
  if (!S.orderType) selectType('walkin');
  goStep(3);
}

// ─── Service Type ─────────────────────────────────────────────────────────────
function selectService(svc) {
  S.serviceType = svc;
  document.getElementById('svc-exchange').classList.toggle('active', svc === 'exchange');
  document.getElementById('svc-new').classList.toggle('active', svc === 'new');
  renderProducts();
}

// ─── Products ─────────────────────────────────────────────────────────────────
function renderProducts() {
  const list = document.getElementById('product-list');
  const avail = S.products.filter(p => p.status === 'active');
  if (!avail.length) {
    list.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:40px 0">ไม่มีสินค้า</p>';
    return;
  }
  list.innerHTML = avail.map(p => {
    const inCart = S.cart.find(c => c.product_id === p.id);
    const qty = inCart ? inCart.qty : 0;
    const isOut = p.full_qty <= 0;
    return '<div class="product-item' + (isOut ? ' out' : '') + '">'
      + '<div class="prod-ico">' + (p.icon || '🔴') + '</div>'
      + '<div class="prod-info">'
      + '<div class="prod-name">' + htmlEsc(p.name) + '</div>'
      + '<div class="prod-brand">' + htmlEsc(p.brand || '') + '</div>'
      + '<div class="prod-price">฿' + fmt(p.price) + '</div>'
      + '<div class="prod-stock">' + t('in_stock') + ': ' + p.full_qty + '</div>'
      + '</div>'
      + '<div class="qty-ctrl">'
      + '<button class="qty-btn" onclick="changeQty(' + p.id + ',-1)" ' + (qty === 0 ? 'disabled' : '') + '>−</button>'
      + '<div class="qty-num">' + qty + '</div>'
      + '<button class="qty-btn" onclick="changeQty(' + p.id + ',1)" ' + (isOut ? 'disabled' : '') + '>+</button>'
      + '</div>'
      + '</div>';
  }).join('');
  updateCartBar();
}

function changeQty(productId, delta) {
  const product = S.products.find(p => p.id === productId);
  if (!product) return;
  const idx = S.cart.findIndex(c => c.product_id === productId);
  if (idx === -1 && delta > 0) {
    S.cart.push({ product_id: productId, name: product.name, qty: 1, price: product.price });
  } else if (idx !== -1) {
    S.cart[idx].qty += delta;
    if (S.cart[idx].qty <= 0) S.cart.splice(idx, 1);
  }
  renderProducts();
}

function updateCartBar() {
  const bar = document.getElementById('cart-bar');
  const totalQty = S.cart.reduce((s, i) => s + i.qty, 0);
  if (totalQty === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  const subtotal = S.cart.reduce((s, i) => s + i.qty * i.price, 0);
  document.getElementById('cart-bar-txt').textContent = totalQty + ' ' + t('items');
  document.getElementById('cart-bar-total').textContent = '฿' + fmt(subtotal);
  // add bottom padding to not hide content behind cart bar
  document.getElementById('step-products').style.paddingBottom = '80px';
}

// ─── Address Step ─────────────────────────────────────────────────────────────
function initAddressStep() {
  const addrs = S.savedAddresses || [];
  const listEl = document.getElementById('saved-addresses-list');
  if (listEl) {
    if (addrs.length) {
      listEl.style.display = 'block';
      listEl.innerHTML = '<div style="font-size:.8rem;color:var(--text-3);margin-bottom:8px">ที่อยู่ที่บันทึกไว้</div>'
        + addrs.map((a, i) =>
            '<div class="saved-addr-btn" onclick="selectSavedAddress(' + i + ')">'
            + '<strong>' + htmlEsc(a.label || 'บ้าน') + '</strong> — '
            + htmlEsc(a.address || '')
            + '</div>'
          ).join('')
        + '<div class="saved-addr-btn" onclick="usePinAddress()" style="color:var(--accent)">+ ที่อยู่ใหม่ (ปักหมุด)</div>';
    } else {
      listEl.style.display = 'none';
    }
  }
  initMap();
}

function selectSavedAddress(idx) {
  const a = (S.savedAddresses || [])[idx];
  if (!a) return;
  S.address.text = a.address || '';
  S.address.lat  = a.lat;
  S.address.lng  = a.lng;
  document.getElementById('address-text').value = S.address.text;
  if (a.lat && a.lng && S.mapObj) {
    S.mapObj.setView([a.lat, a.lng], 16);
    S.mapMarker.setLatLng([a.lat, a.lng]);
  }
}

function usePinAddress() {
  document.getElementById('address-text').value = '';
  S.address.text = '';
}

// ─── Map ──────────────────────────────────────────────────────────────────────
function initMap() {
  if (S.mapInit) return;
  S.mapInit = true;
  const defaultLat = 13.7563, defaultLng = 100.5018; // Bangkok
  S.mapObj = L.map('map-container').setView([defaultLat, defaultLng], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
  }).addTo(S.mapObj);

  S.mapMarker = L.marker([defaultLat, defaultLng], { draggable: true }).addTo(S.mapObj);
  S.address.lat = defaultLat;
  S.address.lng = defaultLng;

  S.mapMarker.on('dragend', e => {
    const pos = e.target.getLatLng();
    S.address.lat = pos.lat;
    S.address.lng = pos.lng;
  });

  S.mapObj.on('click', e => {
    S.mapMarker.setLatLng(e.latlng);
    S.address.lat = e.latlng.lat;
    S.address.lng = e.latlng.lng;
  });

  // Try geolocation
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      S.mapObj.setView(ll, 16);
      S.mapMarker.setLatLng(ll);
      S.address.lat = ll[0];
      S.address.lng = ll[1];
    }, () => {});
  }
}

function confirmAddress() {
  S.address.text = document.getElementById('address-text').value.trim();
  S.address.note = document.getElementById('address-note').value.trim();
  if (!S.address.text) {
    alert(t('address_required'));
    return;
  }
  goStep(5);
}

// ─── Payment ──────────────────────────────────────────────────────────────────
function payBack() {
  goStep(S.orderType === 'delivery' ? 4 : 3);
}

function renderPayments() {
  const list = document.getElementById('payment-list');
  const methods = S.paymentMethods.filter(m => {
    if (m.require_tier === 'b2b' && (!S.customer || S.customer.tier !== 'b2b')) return false;
    return true;
  });
  list.innerHTML = methods.map(m =>
    '<div class="pm-item' + (S.selectedPayment === m.id ? ' active' : '') + '" onclick="selectPayment(' + m.id + ',\'' + htmlEsc(m.name) + '\')">'
    + '<div class="pm-icon">' + (m.icon || '💳') + '</div>'
    + '<div><div class="pm-name">' + htmlEsc(m.name) + '</div>'
    + '<div class="pm-desc">' + htmlEsc(m.description || '') + '</div></div>'
    + '</div>'
  ).join('');
  document.getElementById('btn-pay-next').disabled = !S.selectedPayment;
}

function selectPayment(id, name) {
  S.selectedPayment = id;
  S.selectedPaymentName = name;
  renderPayments();
  document.getElementById('btn-pay-next').disabled = false;
}

// ─── Review ───────────────────────────────────────────────────────────────────
function calcTotals() {
  const subtotal = S.cart.reduce((s, i) => s + i.qty * i.price, 0);
  let feeAmount = 0;
  let feeLabel = t('delivery_fee');
  if (S.orderType === 'delivery') {
    const df = S.fees.find(f => f.type === 'delivery');
    if (df) { feeAmount = df.amount; feeLabel = df.name; }
  }
  const total = subtotal + feeAmount;
  const vat = Math.round(total * 7 / 107 * 100) / 100;
  return { subtotal, feeAmount, feeLabel, total, vat };
}

function renderReview() {
  const items = document.getElementById('review-items');
  items.innerHTML = S.cart.map(i =>
    '<div class="summary-item">'
    + '<span class="summary-label">' + htmlEsc(i.name) + ' × ' + i.qty + '</span>'
    + '<span class="summary-val">฿' + fmt(i.qty * i.price) + '</span>'
    + '</div>'
  ).join('');

  const { subtotal, feeAmount, feeLabel, total, vat } = calcTotals();
  document.getElementById('rv-subtotal').textContent = '฿' + fmt(subtotal);

  const feeRow = document.getElementById('rv-fee-row');
  if (feeAmount > 0) {
    feeRow.style.display = 'flex';
    document.getElementById('rv-fee-label').textContent = feeLabel;
    document.getElementById('rv-fee').textContent = '฿' + fmt(feeAmount);
  } else {
    feeRow.style.display = 'none';
  }

  document.getElementById('rv-vat').textContent = '฿' + fmt(vat);
  document.getElementById('rv-total').textContent = '฿' + fmt(total);
  document.getElementById('rv-payment').textContent = S.selectedPaymentName || '—';

  const addrRow = document.getElementById('rv-address-row');
  if (S.orderType === 'delivery' && S.address.text) {
    addrRow.style.display = 'flex';
    document.getElementById('rv-address').textContent = S.address.text + (S.address.note ? ' (' + S.address.note + ')' : '');
  } else {
    addrRow.style.display = 'none';
  }
}

// ─── Submit ───────────────────────────────────────────────────────────────────
async function submitOrder() {
  if (S.submitting || S.cart.length === 0) return;
  S.submitting = true;
  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = t('submitting');

  const { feeAmount } = calcTotals();
  const body = {
    phone: S.phone,
    order_type: S.orderType,
    service_type: S.serviceType,
    items: S.cart.map(i => ({ product_id: i.product_id, qty: i.qty })),
    payment_method_id: S.selectedPayment,
    delivery_address: S.orderType === 'delivery' ? S.address.text : null,
    delivery_note: S.orderType === 'delivery' ? S.address.note : null,
    delivery_lat: S.orderType === 'delivery' ? S.address.lat : null,
    delivery_lng: S.orderType === 'delivery' ? S.address.lng : null,
    fees: feeAmount > 0 ? [{ type: 'delivery', amount: feeAmount }] : [],
  };

  try {
    const res = await fetch('/api/customer/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok && data.order_num) {
      S.currentOrderNum = data.order_num;
      startTracking(data.order_num);
    } else {
      alert(data.error || t('submit_error'));
      btn.disabled = false;
      btn.textContent = t('submit_order');
      S.submitting = false;
    }
  } catch (e) {
    alert(t('submit_error'));
    btn.disabled = false;
    btn.textContent = t('submit_order');
    S.submitting = false;
  }
}

// ─── Tracking ─────────────────────────────────────────────────────────────────
const TRACK_STATUSES = ['pending','preparing','delivering','completed'];

function startTracking(orderNum) {
  document.getElementById('track-order-num').textContent = orderNum;
  goStep(7);
  fetchTrack(orderNum);
  S.trackTimer = setInterval(() => fetchTrack(orderNum), 15000);
}

async function fetchTrack(orderNum) {
  try {
    const res = await fetch('/api/customer/order/' + orderNum);
    if (!res.ok) return;
    const data = await res.json();
    renderTracking(data);
  } catch (e) {}
}

function renderTracking(data) {
  const status = data.status || 'pending';
  const stepIdx = TRACK_STATUSES.indexOf(status);

  const stepDefs = [
    { status:'pending',    icon:'📋', labelKey:'status_pending' },
    { status:'preparing',  icon:'📦', labelKey:'status_preparing' },
    { status:'delivering', icon:'🚚', labelKey:'status_delivering' },
    { status:'completed',  icon:'✅', labelKey:'status_completed' },
  ];

  const html = stepDefs.map((s, i) => {
    let cls = 'track-step';
    if (i < stepIdx) cls += ' done';
    else if (i === stepIdx) cls += ' active';
    const time = (i === stepIdx && data.updated_at) ? data.updated_at.substr(11,5) : '';
    return '<div class="' + cls + '">'
      + (i > 0 ? '<div class="track-line"></div>' : '')
      + '<div class="track-dot">' + (i < stepIdx ? '✓' : s.icon) + '</div>'
      + '<div class="track-info">'
      + '<div class="track-label">' + t(s.labelKey) + '</div>'
      + (time ? '<div class="track-time">' + time + '</div>' : '')
      + '</div></div>';
  }).join('');
  document.getElementById('track-steps').innerHTML = html;

  // Driver info
  const driverDiv = document.getElementById('driver-info');
  if (data.driver_name && status !== 'pending') {
    driverDiv.style.display = 'block';
    document.getElementById('driver-name-txt').textContent = data.driver_name;
    const vRow = document.getElementById('driver-vehicle-row');
    if (data.driver_vehicle) {
      vRow.style.display = 'flex';
      document.getElementById('driver-vehicle-txt').textContent = data.driver_vehicle;
    } else {
      vRow.style.display = 'none';
    }
  } else {
    driverDiv.style.display = 'none';
  }

  // Warranty
  const wBox = document.getElementById('warranty-box');
  if (status === 'completed') {
    wBox.style.display = 'block';
    // 7 days from delivered_at or now
    const base = data.delivered_at ? new Date(data.delivered_at) : new Date();
    const exp = new Date(base.getTime() + 7 * 86400000);
    const expStr = exp.toLocaleDateString(S.lang === 'th' ? 'th-TH' : 'en-GB',
      { year: 'numeric', month: 'long', day: 'numeric' });
    document.getElementById('warranty-date-txt').textContent = t('warranty_exp') + ': ' + expStr;
    clearInterval(S.trackTimer);
  } else {
    wBox.style.display = 'none';
  }
}

function newOrder() {
  clearInterval(S.trackTimer);
  // Reset state but keep language and customer
  S.orderType = null;
  S.serviceType = 'exchange';
  S.cart = [];
  S.selectedPayment = null;
  S.selectedPaymentName = null;
  S.address = { text:'', note:'', lat: null, lng: null };
  S.submitting = false;
  S.currentOrderNum = null;
  goStep(2);
  renderTypeStep();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n === undefined || n === null) return '0';
  return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function htmlEsc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

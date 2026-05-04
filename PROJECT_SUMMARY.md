# GAS OS v3 — Project Summary
**หจก.ชัยเพ็ญ 1988 | LPG Gas Shop Management System**
*อัปเดต: 26 เมษายน 2569*

---

## สถาปัตยกรรม

| ชั้น | เทคโนโลยี |
|------|-----------|
| Backend | Python 3 + Flask + SQLite (ไม่มี ORM) |
| Frontend | Vanilla JS (ไม่มี framework), HTML5, CSS3 |
| Maps | Leaflet.js (self-hosted, ใช้ Nominatim สำหรับ geocoding) |
| Auth | Session cookie `gas_session` — HMAC-SHA256 signed, HttpOnly |
| Deploy | Railway (nixpacks + Procfile) |

---

## ✅ สิ่งที่ทำเสร็จแล้ว

### Backend (server.py + routes/)

#### Auth (routes/auth.py)
- `POST /api/auth/login` — รับ `{staff_id, pin}`, ออก session cookie HttpOnly
- `POST /api/auth/logout` — ลบ cookie, บันทึก audit log
- `GET /api/auth/me` — คืน staff ปัจจุบันจาก cookie
- `GET /api/auth/staff?role=...` — ดึงรายชื่อพนักงานสำหรับ dropdown
- Lockout หลัง 3 ครั้งผิด → ล็อค 15 นาที (in-memory dict)
- `require_auth(roles=[])` decorator ใน helpers.py — ทุก blueprint ใช้แทน X-Pin

#### DB Schema (server.py — _create_tables)
ตารางหลักทั้งหมด 22 ตาราง รวมถึงที่เพิ่มใหม่สำหรับ v3:
- `translations` — i18n จาก DB
- `customer_addresses` — หลายที่อยู่ต่อลูกค้า
- `tare_bonus_rules` — อัตราเงินพิเศษก๊าซเหลือ
- `staff_bonus_log` — log เงินพิเศษพนักงาน
- `restock_invoices` เพิ่มคอลัมน์: tare_weight_kg, tare_rate, tare_discount, pickup_staff_id, pickup_staff_name
- `settings` global dict (`app_settings`) โหลดครั้งเดียวตอน startup

#### Supervisor POS (routes/supervisor.py)
- `GET /api/supervisor/kanban?date=&driver_id=` — ดึงออเดอร์แบ่งตาม status + stats
- `POST /api/supervisor/orders` — สร้างออเดอร์จาก POS (stock deduction, VAT, audit)
- `PUT /api/supervisor/orders/<num>/confirm` — pending → preparing
- `PUT /api/supervisor/orders/<num>/dispatch` — preparing → delivering (assign driver)
- `PUT /api/supervisor/orders/<num>/complete` — supervisor override จบงาน
- `PUT /api/supervisor/orders/<num>/cancel` — ยกเลิก + restore stock
- `GET /api/supervisor/stock` — สต็อกถัง
- `GET /api/supervisor/drivers` — รายชื่อ driver
- `POST /api/supervisor/stock/adjust` — ปรับสต็อก
- `POST /api/supervisor/restock` — รับสินค้า + tare discount + staff bonus
- `POST /api/supervisor/cash/clear` — เคลียร์เงินสด driver
- `GET /api/supervisor/cash/summary` — สรุปเงินสด
- `GET /api/supervisor/dayend` — ข้อมูลปิดกะ
- `GET /api/supervisor/customers/search?q=` — ค้นหาลูกค้าด้วยชื่อ/เบอร์

#### Admin (routes/admin.py)
- Dashboard P&L, CRUD ทั้งหมด (products, customers, staff, suppliers, expenses)
- VAT report ภ.พ.30
- Audit log
- Settings (shop info, API keys, etc.)

#### Driver (routes/driver.py)
- Login, ดูออเดอร์ที่ได้รับมอบหมาย, รับส่งพัสดุ, เก็บเงิน, สรุปรายวัน

#### Customer (routes/customer.py)
- ค้นหา, ประวัติออเดอร์, track ออเดอร์

---

### Frontend

#### pos.html — Supervisor POS ✅ (สมบูรณ์ที่สุด)
- **Login**: Dropdown ชื่อพนักงาน + PIN 4 หลัก + lockout UI
- **Topbar**: stat cards (ออเดอร์วันนี้ / รอจัดส่ง / กำลังส่ง / เงินสดค้าง) + connection dot (5s polling)
- **Map view**: Leaflet.js แสดง pin ออเดอร์แบบ color-coded
  - เหลือง = รอจัดส่ง, **เขียว = กำลังส่ง**, **น้ำเงิน = สำเร็จ**, แดง = ยกเลิก
  - กดปุ่ม pin = popover แสดง ชื่อลูกค้า / driver / เวลาสั่ง-เริ่มส่ง-ส่งแล้ว / ปุ่ม จบงาน
  - ปุ่ม locate (เหมือน Google Maps) — fly ไปตำแหน่งปัจจุบัน + แสดงจุดสีน้ำเงิน
  - Filter panel: กรองตาม status / driver
- **List view**: Kanban 3 คอลัมน์ (รอจัดส่ง / กำลังส่ง / สำเร็จ)
  - แต่ละ card มีปุ่ม: ✓ ยืนยัน, 👤 มอบหมาย, ✓ จบ (delivering), ✕ ยกเลิก, 🖨 พิมพ์
- **Phone pane**: ค้นหาลูกค้าด้วยเบอร์โทร + **ค้นชื่อลูกค้า** (autocomplete dropdown)
  - "สั่งเหมือนเดิม" — โหลดรายการเดิม + **pre-fill ที่อยู่ล่าสุดโดยอัตโนมัติ**
- **Order screen (full-screen)**: เลือกสินค้า, ประเภท walk-in/delivery, fees, VAT
  - **Address picker**: Leaflet + Nominatim reverse geocode, drag marker, ปุ่ม locate ตำแหน่งปัจจุบัน
- **Stock modal**: ดูสต็อกถัง
- **Restock modal**: รับสินค้า + tare kg → คำนวณส่วนลดและ bonus อัตโนมัติ
- **S8 Cash Screen**: รับเงินสดจาก Driver พร้อมแสดง variance
- **S9 Day-end Screen**: ปิดกะ, KPI, สรุปยอด, บันทึกค่าใช้จ่าย

#### admin.html ✅
- Login PIN 6 หลัก, hash-based routing, CRUD ครบ

#### driver.html ✅
- Login, job list, check-list ความปลอดภัย, รับส่ง-เงิน

#### order.html ✅
- 8 ขั้นตอน (เลือกภาษา → เบอร์ → ประเภท → สินค้า → ที่อยู่ → ชำระ → review → tracking)
- i18n: th/en/my/ko/zh

---

## 🔄 ที่ยังค้างอยู่ (จาก v3 spec)

| รายการ | สถานะ | หมายเหตุ |
|--------|-------|---------|
| `POST /api/customer/identify` + `PUT /api/customer/register` | ❌ ยังไม่มี | สำหรับ order.html ลูกค้าใหม่ |
| `/api/customer-addresses` CRUD | ❌ ยังไม่มี | หลายที่อยู่ต่อลูกค้า |
| `/api/translations` CRUD (admin) | ❌ ยังไม่มี | ตาราง translations มีแล้ว |
| `/api/tare-bonus-rules` CRUD (admin) | ❌ ยังไม่มี | ตาราง tare_bonus_rules มีแล้ว |
| `/api/staff-bonus-log` GET (admin) | ❌ ยังไม่มี | ตาราง staff_bonus_log มีแล้ว |
| `POST /api/slip/verify` (SlipOK) | ❌ ยังไม่มี | ยืนยันสลิปโอน |
| Admin: translations / tare rules / bonus log views | ❌ ยังไม่มี | UI เพิ่มใน admin.html |
| order.html: registration step (ลูกค้าใหม่) | ❌ ยังไม่มี | แสดง form ชื่อ+ที่อยู่+pin |
| order.html: multi-address selector | ❌ ยังไม่มี | เลือกที่อยู่หลายจุด |
| driver.html: session cookie login | ⚠️ ยังใช้ X-Pin | ต้องเปลี่ยนเป็น cookie เหมือน pos |
| import_from_sheets.py (rewrite) | ⚠️ บางส่วน | ต้องเพิ่ม OPENING_STOCK, --dry-run, --confirm |
| `verify_stock_invariant()` | ⚠️ บางส่วน | helpers.py มี แต่ไม่ได้ call ทุก mutation |

---

## โครงสร้างไฟล์

```
Gas/
├── server.py              # Flask app, init DB, shared helpers
├── helpers.py             # require_auth, session token, calc_vat, audit
├── routes/
│   ├── auth.py            # /api/auth/* — login, logout, me, staff list
│   ├── supervisor.py      # /api/supervisor/* — POS, kanban, stock, restock
│   ├── driver.py          # /api/driver/* — jobs, deliver, cash
│   ├── customer.py        # /api/customer/* — identify, history, track
│   └── admin.py           # /api/admin/* — full back office
├── static/
│   ├── pos.html/.js/.css  # Supervisor POS (สมบูรณ์ที่สุด)
│   ├── admin.html/.js/.css
│   ├── driver.html/.js/.css
│   ├── order.html/.js/.css
│   ├── leaflet.js/.css    # self-hosted (Edge tracking prevention)
│   ├── images/            # Leaflet marker icons
│   ├── css/
│   │   ├── _tokens.css    # CSS variables (colors, fonts, spacing)
│   │   └── _base.css      # reusable components (btn, card, badge, table)
│   └── js/
│       └── _theme.js      # dark/light mode toggle
├── import_from_sheets.py  # CSV import utility
├── inspect_db.py          # DB inspection tool
├── backup.py              # DB backup (keep last 7)
├── requirements.txt
├── .env                   # SECRET_KEY, DATABASE_PATH, PORT
├── Procfile               # web: python server.py
└── railway.json           # deployment config
```

---

## การทดสอบเบื้องต้น

```bash
# ตรวจ syntax
python -m py_compile server.py helpers.py routes/auth.py routes/supervisor.py && echo "Python OK"
node --check static/pos.js && echo "JS OK"

# เปิด server
python server.py

# ทดสอบ health
curl http://localhost:5000/api/health

# ทดสอบ login
curl -sc cookies.txt -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" -d '{"pin":"1988"}' | python -m json.tool

# ทดสอบ kanban (ต้องมี session)
curl -sb cookies.txt http://localhost:5000/api/supervisor/kanban | python -m json.tool
```

---

## Design System

```css
/* Fonts */
--font-kanit: 'Kanit'    /* headers, numbers, prices */
--font-sarabun: 'Sarabun' /* body, Thai content */

/* Accent colors */
--accent: #ff5625         /* orange brand */
--success: #27a644        /* green */
--danger: #c9302c         /* red */
--warning: #ff9d00        /* amber */

/* Map pin colors */
รอจัดส่ง  → เหลือง (#ff9d00)
กำลังส่ง  → เขียว (--success)
สำเร็จ    → น้ำเงิน (#2563eb)
ยกเลิก   → แดง (--danger)
```

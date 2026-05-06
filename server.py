import os
from flask import Flask, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

# helpers must be imported BEFORE routes to avoid circular imports
from helpers import (
    get_db, bkk_now, new_id, calc_vat,
    generate_order_num, audit, notify_line,
    require_shop_key, verify_pin, require_auth
)

app = Flask(__name__, static_folder='static', static_url_path='/static')
app.secret_key = os.getenv('SECRET_KEY', 'changeme-dev-replace-in-production')
CORS(app, supports_credentials=True)

# ─── Settings Cache ───────────────────────────────────────────────────────────
app_settings = {}

def load_settings():
    """Load all settings into memory. Call after init_db() and after each save."""
    global app_settings
    try:
        db   = get_db()
        rows = db.execute("SELECT key, val FROM settings").fetchall()
        db.close()
        app_settings = {r['key']: r['val'] for r in rows}
    except Exception:
        pass


# ─── Database Init ───────────────────────────────────────────────────────────

def init_db():
    db_path = os.getenv('DATABASE_PATH', 'gasshop.db')
    print(f"[INFO] Database path: {db_path}", flush=True)
    print(f"[INFO] Database parent exists: {os.path.exists(os.path.dirname(db_path) or '.')}", flush=True)
    conn = get_db()
    _create_tables(conn)
    _migrate(conn)
    conn.commit()
    conn.close()
    _seed_defaults()
    load_settings()
    print(f"[INFO] Database initialized successfully at {db_path}", flush=True)


def _create_tables(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        val TEXT
    );

    CREATE TABLE IF NOT EXISTS languages (
        code        TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        native_name TEXT DEFAULT '',
        flag        TEXT DEFAULT '',
        active      INTEGER DEFAULT 1,
        sort_order  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS staff (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        phone      TEXT DEFAULT '',
        role       TEXT DEFAULT 'driver',
        pin        TEXT DEFAULT '',
        vehicle    TEXT DEFAULT 'bike',
        active     INTEGER DEFAULT 1,
        note       TEXT DEFAULT '',
        salary     INTEGER DEFAULT 0,
        commission_per_order INTEGER DEFAULT 0,
        start_date TEXT DEFAULT '',
        created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
        id              TEXT PRIMARY KEY,
        brand           TEXT DEFAULT '',
        name            TEXT NOT NULL,
        name_en         TEXT DEFAULT '',
        ico             TEXT DEFAULT '🔵',
        image_url       TEXT DEFAULT '',
        size_kg         REAL DEFAULT 0,
        price           INTEGER DEFAULT 0,
        price_excl_vat  REAL DEFAULT 0,
        price_transfer  INTEGER DEFAULT 0,
        cost            INTEGER DEFAULT 0,
        status          TEXT DEFAULT 'available',
        reorder_point   INTEGER DEFAULT 5,
        sort_order      INTEGER DEFAULT 0,
        created_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS fees (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        type            TEXT DEFAULT 'fixed',
        amount          REAL DEFAULT 0,
        condition_type  TEXT DEFAULT '',
        condition_value TEXT DEFAULT '',
        active          INTEGER DEFAULT 1,
        sort_order      INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payment_methods (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        type         TEXT DEFAULT 'cash',
        active       INTEGER DEFAULT 1,
        require_tier TEXT DEFAULT '',
        sort_order   INTEGER DEFAULT 0,
        config_json  TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS suppliers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        brand       TEXT DEFAULT '',
        phone       TEXT DEFAULT '',
        address     TEXT DEFAULT '',
        tax_id      TEXT DEFAULT '',
        credit_days INTEGER DEFAULT 30,
        balance     INTEGER DEFAULT 0,
        note        TEXT DEFAULT '',
        active      INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS customers (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        phone            TEXT UNIQUE,
        address          TEXT DEFAULT '',
        lat              REAL,
        lng              REAL,
        tier             TEXT DEFAULT 'retail',
        lang             TEXT DEFAULT 'th',
        credit_limit     INTEGER DEFAULT 0,
        credit_days      INTEGER DEFAULT 30,
        credit_bal       INTEGER DEFAULT 0,
        need_invoice     TEXT DEFAULT 'no',
        tax_id           TEXT DEFAULT '',
        note             TEXT DEFAULT '',
        total_orders     INTEGER DEFAULT 0,
        total_spent      INTEGER DEFAULT 0,
        last_order_items TEXT DEFAULT '[]',
        created_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS customer_prices (
        id             TEXT PRIMARY KEY,
        customer_id    TEXT NOT NULL,
        product_id     TEXT NOT NULL,
        price          INTEGER NOT NULL,
        price_excl_vat REAL DEFAULT 0,
        note           TEXT DEFAULT '',
        updated_at     TEXT,
        updated_by     TEXT DEFAULT '',
        UNIQUE(customer_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS customer_ledger (
        id            TEXT PRIMARY KEY,
        customer_id   TEXT NOT NULL,
        order_id      TEXT DEFAULT '',
        type          TEXT NOT NULL,
        amount        REAL NOT NULL,
        balance_after REAL NOT NULL,
        note          TEXT DEFAULT '',
        created_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
        id                  TEXT PRIMARY KEY,
        order_num           TEXT UNIQUE,
        date                TEXT,
        created_at          TEXT,
        updated_at          TEXT,
        cust_id             TEXT DEFAULT '',
        cust_name           TEXT DEFAULT '',
        cust_phone          TEXT DEFAULT '',
        cust_tier           TEXT DEFAULT 'retail',
        cust_lang           TEXT DEFAULT 'th',
        address             TEXT DEFAULT '',
        lat                 REAL,
        lng                 REAL,
        order_type          TEXT DEFAULT 'delivery',
        service_type        TEXT DEFAULT 'exchange',
        items_json          TEXT DEFAULT '[]',
        items_summary       TEXT DEFAULT '',
        fees_json           TEXT DEFAULT '[]',
        subtotal            INTEGER DEFAULT 0,
        fees_total          INTEGER DEFAULT 0,
        total               INTEGER DEFAULT 0,
        payment_method      TEXT DEFAULT 'เงินสด',
        payment_proof       TEXT DEFAULT '',
        awaiting_payment    INTEGER DEFAULT 0,
        credit_due          TEXT DEFAULT '',
        invoice             INTEGER DEFAULT 0,
        inv_name            TEXT DEFAULT '',
        inv_tax             TEXT DEFAULT '',
        inv_branch          TEXT DEFAULT '',
        driver_id           TEXT DEFAULT '',
        driver_name         TEXT DEFAULT '',
        batch_id            TEXT DEFAULT '',
        status              TEXT DEFAULT 'pending',
        cancel_reason       TEXT DEFAULT '',
        started_at          TEXT DEFAULT '',
        delivered_at        TEXT DEFAULT '',
        delivery_proof_url  TEXT DEFAULT '',
        cash_collected      INTEGER DEFAULT 0,
        cash_cleared        INTEGER DEFAULT 0,
        cleared_by          TEXT DEFAULT '',
        cleared_at          TEXT DEFAULT '',
        commission_amount   INTEGER DEFAULT 0,
        source              TEXT DEFAULT 'pos',
        note                TEXT DEFAULT '',
        synced_sheet        INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tank_stock (
        id            TEXT PRIMARY KEY,
        product_id    TEXT UNIQUE,
        full_qty      INTEGER DEFAULT 0,
        empty_qty     INTEGER DEFAULT 0,
        customer_qty  INTEGER DEFAULT 0,
        reorder_point INTEGER DEFAULT 5,
        last_updated  TEXT
    );

    CREATE TABLE IF NOT EXISTS spare_parts (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        qty           INTEGER DEFAULT 0,
        unit          TEXT DEFAULT 'ชิ้น',
        reorder_point INTEGER DEFAULT 10,
        cost          REAL DEFAULT 0,
        note          TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS restock_invoices (
        id           TEXT PRIMARY KEY,
        batch_id     TEXT UNIQUE,
        date         TEXT,
        supplier_id  TEXT DEFAULT '',
        invoice_num  TEXT DEFAULT '',
        doc_type     TEXT DEFAULT 'tax',
        total_cost   INTEGER DEFAULT 0,
        status       TEXT DEFAULT 'unpaid',
        note         TEXT DEFAULT '',
        created_by   TEXT DEFAULT '',
        created_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS restock_items (
        id             TEXT PRIMARY KEY,
        invoice_id     TEXT NOT NULL,
        product_id     TEXT NOT NULL,
        qty            INTEGER DEFAULT 0,
        cost_per_unit  REAL DEFAULT 0,
        subtotal       REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS supplier_payments (
        id            TEXT PRIMARY KEY,
        supplier_id   TEXT NOT NULL,
        date          TEXT,
        amount        REAL DEFAULT 0,
        invoices_json TEXT DEFAULT '[]',
        method        TEXT DEFAULT 'โอน',
        note          TEXT DEFAULT '',
        created_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS expenses (
        id          TEXT PRIMARY KEY,
        date        TEXT,
        created_at  TEXT,
        category    TEXT DEFAULT 'operating',
        type        TEXT DEFAULT '',
        to_party    TEXT DEFAULT '',
        amount      INTEGER DEFAULT 0,
        vat_amount  INTEGER DEFAULT 0,
        doc_type    TEXT DEFAULT 'cash',
        doc_no      TEXT DEFAULT '',
        note        TEXT DEFAULT '',
        created_by  TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS vat_output (
        id               TEXT PRIMARY KEY,
        tax_month        TEXT,
        date             TEXT,
        invoice_num      TEXT DEFAULT '',
        customer_name    TEXT DEFAULT '',
        customer_tax_id  TEXT DEFAULT '',
        base_amount      REAL DEFAULT 0,
        vat_amount       REAL DEFAULT 0,
        total            REAL DEFAULT 0,
        is_cancelled     INTEGER DEFAULT 0,
        order_id         TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS vat_input (
        id               TEXT PRIMARY KEY,
        tax_month        TEXT,
        date             TEXT,
        invoice_num      TEXT DEFAULT '',
        supplier_name    TEXT DEFAULT '',
        supplier_tax_id  TEXT DEFAULT '',
        base_amount      REAL DEFAULT 0,
        vat_amount       REAL DEFAULT 0,
        total            REAL DEFAULT 0,
        doc_type         TEXT DEFAULT 'tax',
        restock_id       TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS driver_cash (
        id          TEXT PRIMARY KEY,
        driver_id   TEXT NOT NULL,
        order_id    TEXT DEFAULT '',
        amount      INTEGER DEFAULT 0,
        cleared     INTEGER DEFAULT 0,
        cleared_by  TEXT DEFAULT '',
        cleared_at  TEXT DEFAULT '',
        created_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
        id           TEXT PRIMARY KEY,
        timestamp    TEXT,
        actor_id     TEXT DEFAULT '',
        actor_name   TEXT DEFAULT '',
        actor_role   TEXT DEFAULT '',
        action       TEXT NOT NULL,
        target_type  TEXT DEFAULT '',
        target_id    TEXT DEFAULT '',
        detail_json  TEXT,
        location_lat REAL,
        location_lng REAL
    );

    CREATE TABLE IF NOT EXISTS price_history (
        id          TEXT PRIMARY KEY,
        product_id  TEXT NOT NULL,
        customer_id TEXT DEFAULT '',
        old_price   INTEGER DEFAULT 0,
        new_price   INTEGER DEFAULT 0,
        changed_by  TEXT DEFAULT '',
        changed_at  TEXT,
        note        TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS translations (
        id        TEXT PRIMARY KEY,
        lang_code TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT NOT NULL,
        UNIQUE(lang_code, key)
    );

    CREATE TABLE IF NOT EXISTS customer_addresses (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        label       TEXT DEFAULT 'บ้าน',
        address     TEXT DEFAULT '',
        lat         REAL,
        lng         REAL,
        is_default  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tare_bonus_rules (
        id         TEXT PRIMARY KEY,
        name       TEXT DEFAULT 'เงินได้พิเศษแก๊สเหลือ',
        rate_per_kg REAL DEFAULT 5.0,
        active     INTEGER DEFAULT 1,
        updated_by TEXT DEFAULT '',
        updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS staff_bonus_log (
        id             TEXT PRIMARY KEY,
        staff_id       TEXT NOT NULL,
        staff_name     TEXT DEFAULT '',
        type           TEXT DEFAULT 'tare',
        ref_id         TEXT DEFAULT '',
        tare_weight_kg REAL DEFAULT 0,
        rate_per_kg    REAL DEFAULT 0,
        amount         REAL DEFAULT 0,
        note           TEXT DEFAULT '',
        created_at     TEXT
    );
    """)


def _migrate(conn):
    """Add columns / tables missing from earlier schema versions. Safe to run multiple times."""

    def _add_col(table, col, defn):
        try:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN {col} {defn}')
        except Exception:
            pass  # column already exists

    # ── v0 → v1: restock_invoices tare fields ────────────────────────────────
    for col, defn in [
        ('gross_total',       'REAL DEFAULT 0'),
        ('vat_amount',        'REAL DEFAULT 0'),
        ('tare_weight_kg',    'REAL DEFAULT 0'),
        ('tare_rate',         'REAL DEFAULT 0'),
        ('tare_discount',     'REAL DEFAULT 0'),
        ('pickup_staff_id',   'TEXT DEFAULT ""'),
        ('pickup_staff_name', 'TEXT DEFAULT ""'),
        ('net_total',         'REAL DEFAULT 0'),
    ]:
        _add_col('restock_invoices', col, defn)

    _add_col('expenses', 'receipt_image', 'TEXT DEFAULT ""')

    # ── v2: Phase 1A — multi-branch + OTP + document fields ──────────────────

    # customers
    for col, defn in [
        ('credit_approved',         'INTEGER DEFAULT 0'),
        ('default_delivery_note',   'INTEGER DEFAULT 0'),
        ('default_invoice',         'INTEGER DEFAULT 0'),
        ('place_type',              'TEXT DEFAULT "home"'),
        ('preferred_branch_id',     'TEXT DEFAULT "MAIN"'),
    ]:
        _add_col('customers', col, defn)

    # orders
    for col, defn in [
        ('branch_id',              'TEXT DEFAULT "MAIN"'),
        ('order_method',           'TEXT DEFAULT "app"'),
        ('confirmed_by_otp',       'TEXT DEFAULT ""'),
        ('device_ip',              'TEXT DEFAULT ""'),
        ('device_fingerprint',     'TEXT DEFAULT ""'),
        ('doc_delivery_note',      'INTEGER DEFAULT 0'),
        ('doc_delivery_name',      'TEXT DEFAULT ""'),
        ('delivery_note_num',      'TEXT DEFAULT ""'),
        ('tax_invoice_num',        'TEXT DEFAULT ""'),
        ('proof_photo_url',        'TEXT DEFAULT ""'),
        ('proof_photo_taken_at',   'TEXT DEFAULT ""'),
        ('scheduled_at',           'TEXT DEFAULT ""'),
        ('vat',                    'REAL DEFAULT 0'),
    ]:
        _add_col('orders', col, defn)

    # branch_id on operational tables
    for table in ['staff', 'tank_stock', 'suppliers', 'restock_invoices',
                  'driver_cash', 'expenses', 'customer_addresses']:
        _add_col(table, 'branch_id', 'TEXT DEFAULT "MAIN"')

    # customer_ledger — slip verification
    for col, defn in [
        ('slip_image',   'TEXT DEFAULT ""'),
        ('slip_verified','INTEGER DEFAULT 0'),
        ('verified_by',  'TEXT DEFAULT ""'),
        ('verified_at',  'TEXT DEFAULT ""'),
    ]:
        _add_col('customer_ledger', col, defn)

    # ── New tables ────────────────────────────────────────────────────────────

    conn.execute("""
        CREATE TABLE IF NOT EXISTS branches (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          address     TEXT DEFAULT '',
          phone       TEXT DEFAULT '',
          lat         REAL,
          lng         REAL,
          open_time   TEXT DEFAULT '07:00',
          close_time  TEXT DEFAULT '17:00',
          service_radius_km REAL DEFAULT 10,
          active      INTEGER DEFAULT 1,
          created_at  TEXT
        )
    """)
    conn.execute(
        "INSERT OR IGNORE INTO branches (id, name, created_at) VALUES ('MAIN', 'สาขาหลัก', datetime('now'))"
    )

    conn.execute("""
        CREATE TABLE IF NOT EXISTS customer_sessions (
          id                 TEXT PRIMARY KEY,
          customer_id        TEXT NOT NULL,
          device_fingerprint TEXT,
          created_at         TEXT,
          last_seen          TEXT,
          expires_at         TEXT,
          revoked            INTEGER DEFAULT 0
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_cust_sess_customer ON customer_sessions(customer_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_cust_sess_fp ON customer_sessions(device_fingerprint)"
    )

    conn.execute("""
        CREATE TABLE IF NOT EXISTS otp_requests (
          id           TEXT PRIMARY KEY,
          phone        TEXT NOT NULL,
          otp_hash     TEXT NOT NULL,
          ref_code     TEXT,
          purpose      TEXT,
          requested_at TEXT,
          verified_at  TEXT,
          attempts     INTEGER DEFAULT 0,
          expires_at   TEXT
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_requests(phone, requested_at)"
    )

    conn.commit()


def _seed_defaults():
    conn = get_db()
    api_key = os.getenv('SHOP_KEY', 'chaipenn1988secret')
    settings_defaults = [
        ('shop_name',        'ร้านชัยเพ็ญ 1988'),
        ('shop_phone',       ''),
        ('shop_tax_id',      ''),
        ('shop_address',     ''),
        ('promptpay',        ''),
        ('promptpay_name',   ''),
        ('qr_image',         ''),
        ('line_token_order', os.getenv('LINE_NOTIFY_TOKEN', '')),
        ('line_token_stock', os.getenv('LINE_NOTIFY_TOKEN_STOCK', '')),
        ('sheets_webhook',   os.getenv('SHEETS_WEBHOOK', '')),
        ('slipok_key',       os.getenv('SLIPOK_KEY', '')),
        ('api_key',          api_key),
        ('open_time',        '07:00'),
        ('close_time',       '20:00'),
        ('order_seq_date',          ''),
        ('order_seq_num',           '0'),
        ('vat_rate',                '7'),
        ('warranty_days',           '7'),
        ('kanban_completed_hours',  '2'),
        ('commission_default',      '0'),
        ('tare_rate_per_kg',        '5'),
        ('doc_seq_date',            ''),
        ('doc_seq_dn',              '0'),
        ('doc_seq_inv',             '0'),
    ]
    for k, v in settings_defaults:
        conn.execute(
            "INSERT OR IGNORE INTO settings(key,val) VALUES(?,?)", (k, v)
        )

    langs = [
        ('th', 'ไทย',     'ภาษาไทย',    '🇹🇭', 1, 0),
        ('en', 'English', 'English',     '🇬🇧', 1, 1),
        ('my', 'Myanmar', 'မြန်မာဘာသာ', '🇲🇲', 1, 2),
        ('ko', 'Korean',  '한국어',      '🇰🇷', 1, 3),
        ('zh', 'Chinese', '中文',        '🇨🇳', 1, 4),
    ]
    for code, name, native, flag, active, sort in langs:
        conn.execute(
            """INSERT OR IGNORE INTO languages
               (code,name,native_name,flag,active,sort_order)
               VALUES (?,?,?,?,?,?)""",
            (code, name, native, flag, active, sort)
        )

    pay_methods = [
        (new_id(), 'เงินสด',    'cash',     1, '',    0, '{}'),
        (new_id(), 'โอน+สลิป', 'transfer', 1, '',    1, '{}'),
        (new_id(), 'เครดิต',   'credit',   1, 'b2b', 2, '{}'),
        (new_id(), 'QR Code',   'qr',       1, '',    3, '{}'),
    ]
    existing = conn.execute(
        "SELECT COUNT(*) FROM payment_methods"
    ).fetchone()[0]
    if not existing:
        for row in pay_methods:
            conn.execute(
                """INSERT OR IGNORE INTO payment_methods
                   (id,name,type,active,require_tier,sort_order,config_json)
                   VALUES (?,?,?,?,?,?,?)""",
                row
            )

    has_staff = conn.execute(
        "SELECT COUNT(*) FROM staff WHERE role='admin'"
    ).fetchone()[0]
    if not has_staff:
        conn.execute(
            """INSERT INTO staff
               (id,name,phone,role,pin,vehicle,active,created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (new_id(), 'Admin', '', 'admin', '198800', 'none', 1, bkk_now())
        )

    # Seed default supervisor + driver too (for fresh production deploy)
    has_supervisor = conn.execute(
        "SELECT COUNT(*) FROM staff WHERE role='supervisor'"
    ).fetchone()[0]
    if not has_supervisor:
        conn.execute(
            """INSERT INTO staff
               (id,name,phone,role,pin,vehicle,active,created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (new_id(), 'หัวหน้างาน', '', 'supervisor', '1111', 'none', 1, bkk_now())
        )

    has_driver = conn.execute(
        "SELECT COUNT(*) FROM staff WHERE role='driver'"
    ).fetchone()[0]
    if not has_driver:
        conn.execute(
            """INSERT INTO staff
               (id,name,phone,role,pin,vehicle,active,created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (new_id(), 'พนักงานส่ง', '', 'driver', '2222', 'มอเตอร์ไซค์', 1, bkk_now())
        )

    # Seed tare bonus rule if none exists
    has_tare = conn.execute("SELECT COUNT(*) FROM tare_bonus_rules").fetchone()[0]
    if not has_tare:
        conn.execute(
            """INSERT INTO tare_bonus_rules (id, name, rate_per_kg, active, updated_at)
               VALUES (?,?,?,?,?)""",
            (new_id(), 'เงินได้พิเศษแก๊สเหลือ', 5.0, 1, bkk_now())
        )

    conn.commit()
    conn.close()


# ─── Static Pages ────────────────────────────────────────────────────────────

@app.route('/')
@app.route('/order')
@app.route('/order.html')
def serve_order():
    return send_from_directory('static', 'order.html')


@app.route('/pos')
@app.route('/pos.html')
def serve_pos():
    return send_from_directory('static', 'pos.html')


@app.route('/driver')
@app.route('/driver.html')
def serve_driver():
    return send_from_directory('static', 'driver.html')


@app.route('/admin')
@app.route('/admin.html')
def serve_admin():
    return send_from_directory('static', 'admin.html')


@app.route('/manifest.json')
def serve_manifest():
    return send_from_directory('static', 'manifest.json')


@app.route('/sw.js')
def serve_sw():
    return send_from_directory('static', 'sw.js',
                               mimetype='application/javascript')


# ─── Register Blueprints ─────────────────────────────────────────────────────

from routes.auth       import auth_bp
from routes.supervisor import supervisor_bp
from routes.driver     import driver_bp
from routes.customer   import customer_bp
from routes.admin      import admin_bp

app.register_blueprint(auth_bp,       url_prefix='/api/auth')
app.register_blueprint(supervisor_bp, url_prefix='/api/supervisor')
app.register_blueprint(driver_bp,     url_prefix='/api/driver')
app.register_blueprint(customer_bp,   url_prefix='/api/customer')
app.register_blueprint(admin_bp,      url_prefix='/api/admin')


# ─── Entry Point ─────────────────────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    port = int(os.getenv('PORT', 5000))
    debug_mode = os.getenv('FLASK_DEBUG', '0') == '1'
    app.run(host='0.0.0.0', port=port, debug=debug_mode)

# expose for routes that need to reload settings after save
__all__ = ['app_settings', 'load_settings']

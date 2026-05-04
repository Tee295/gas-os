"""
routes/customer.py — Customer-facing endpoints (public, no auth required)
Driver phone is NEVER returned in any response.
"""
import json
from flask import Blueprint, jsonify, request

from helpers import (
    get_db, bkk_now, new_id, audit,
    generate_order_num, verify_stock_invariant, notify_line
)

customer_bp = Blueprint('customer', __name__)


# ─── Customer Identity ────────────────────────────────────────────────────────

@customer_bp.route('/identify', methods=['POST'])
def identify():
    """Look up customer by phone. Returns {customer, is_new}."""
    d     = request.get_json(silent=True) or {}
    phone = str(d.get('phone', '')).strip()
    if len(phone) != 10 or not phone.isdigit():
        return jsonify({'error': 'Invalid phone number'}), 400

    db  = get_db()
    row = db.execute(
        """SELECT id,name,phone,address,lat,lng,tier,lang,
                  credit_bal,need_invoice,total_orders,last_order_items
           FROM customers WHERE phone=?""", (phone,)
    ).fetchone()

    if not row:
        db.close()
        return jsonify({'is_new': True, 'phone': phone, 'customer': None})

    c = dict(row)
    try:
        c['last_order_items'] = json.loads(c.get('last_order_items') or '[]')
    except Exception:
        c['last_order_items'] = []

    # Fetch saved addresses
    addrs = db.execute(
        "SELECT id,label,address,lat,lng,is_default FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC",
        (c['id'],)
    ).fetchall()
    db.close()
    c['addresses'] = [dict(a) for a in addrs]
    return jsonify({'is_new': False, 'customer': c})


@customer_bp.route('/identify/<phone>', methods=['GET'])
def identify_get(phone):
    """GET version for backwards compat."""
    db  = get_db()
    row = db.execute(
        """SELECT id,name,phone,address,lat,lng,tier,lang,
                  credit_bal,need_invoice,total_orders,last_order_items
           FROM customers WHERE phone=?""", (phone,)
    ).fetchone()
    if not row:
        db.close()
        return jsonify({'is_new': True, 'phone': phone, 'customer': None})
    c = dict(row)
    try:
        c['last_order_items'] = json.loads(c.get('last_order_items') or '[]')
    except Exception:
        c['last_order_items'] = []
    addrs = db.execute(
        "SELECT id,label,address,lat,lng,is_default FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC",
        (c['id'],)
    ).fetchall()
    db.close()
    c['addresses'] = [dict(a) for a in addrs]
    return jsonify({'is_new': False, 'customer': c})


@customer_bp.route('/register', methods=['PUT', 'POST'])
def register():
    """Create new customer from customer app."""
    d     = request.get_json(silent=True) or {}
    phone = str(d.get('phone', '')).strip()
    name  = str(d.get('name', '')).strip()
    if not phone or not name:
        return jsonify({'error': 'phone and name required'}), 400
    if len(phone) != 10 or not phone.isdigit():
        return jsonify({'error': 'Invalid phone'}), 400

    db  = get_db()
    existing = db.execute("SELECT id FROM customers WHERE phone=?", (phone,)).fetchone()
    if existing:
        db.close()
        return jsonify({'error': 'Phone already registered', 'customer_id': existing['id']}), 409

    now     = bkk_now()
    cust_id = new_id()
    address = d.get('address', '')
    lat     = d.get('lat')
    lng     = d.get('lng')
    lang    = d.get('lang', 'th')

    with db:
        db.execute(
            """INSERT INTO customers
               (id,name,phone,address,lat,lng,tier,lang,
                credit_limit,credit_days,credit_bal,
                need_invoice,tax_id,total_orders,total_spent,
                last_order_items,created_at)
               VALUES (?,?,?,?,?,?,?,?,0,30,0,'no','',0,0,'[]',?)""",
            (cust_id, name, phone, address, lat, lng, 'retail', lang, now)
        )
        # Save default address if provided
        if address:
            db.execute(
                """INSERT INTO customer_addresses
                   (id,customer_id,label,address,lat,lng,is_default)
                   VALUES (?,?,?,?,?,?,1)""",
                (new_id(), cust_id, 'บ้าน', address, lat, lng)
            )
        audit(db, 'customer', name, 'customer', 'registered',
              'customer', cust_id, {'phone': phone, 'lang': lang})

    db.close()
    return jsonify({'ok': True, 'customer_id': cust_id, 'name': name}), 201


# ─── Customer Addresses ───────────────────────────────────────────────────────

@customer_bp.route('/addresses/<customer_id>', methods=['GET'])
def get_addresses(customer_id):
    db   = get_db()
    rows = db.execute(
        "SELECT id,label,address,lat,lng,is_default FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC",
        (customer_id,)
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@customer_bp.route('/addresses/<customer_id>', methods=['POST'])
def add_address(customer_id):
    d   = request.get_json(silent=True) or {}
    db  = get_db()
    aid = new_id()
    with db:
        if d.get('is_default'):
            db.execute("UPDATE customer_addresses SET is_default=0 WHERE customer_id=?",
                       (customer_id,))
        db.execute(
            """INSERT INTO customer_addresses
               (id,customer_id,label,address,lat,lng,is_default)
               VALUES (?,?,?,?,?,?,?)""",
            (aid, customer_id, d.get('label', 'บ้าน'),
             d.get('address', ''), d.get('lat'), d.get('lng'),
             1 if d.get('is_default') else 0)
        )
    db.close()
    return jsonify({'ok': True, 'id': aid}), 201


# ─── Order Submission (customer app) ─────────────────────────────────────────

@customer_bp.route('/order', methods=['POST'])
def place_order():
    """Place order from customer app. Proxies to supervisor order-creation logic."""
    import server as srv
    d            = request.get_json(silent=True) or {}
    phone        = str(d.get('phone', '')).strip()
    order_type   = d.get('order_type', 'delivery')
    service_type = d.get('service_type', 'exchange')
    items        = d.get('items', [])
    payment_id   = d.get('payment_method_id')
    address      = d.get('delivery_address', '')
    note         = d.get('delivery_note', '')
    lat          = d.get('delivery_lat')
    lng          = d.get('delivery_lng')

    if not phone or not items:
        return jsonify({'error': 'phone and items required'}), 400

    db  = get_db()
    now = bkk_now()

    # Resolve customer
    cust = db.execute("SELECT * FROM customers WHERE phone=?", (phone,)).fetchone()
    if not cust:
        db.close()
        return jsonify({'error': 'Customer not found — please register first'}), 400

    # Resolve payment method
    pm = None
    if payment_id:
        pm = db.execute("SELECT * FROM payment_methods WHERE id=?", (payment_id,)).fetchone()
    payment_name = pm['name'] if pm else 'เงินสด'

    # Build items + totals
    subtotal     = 0
    items_list   = []
    items_summary_parts = []
    for item in items:
        pid = item.get('product_id', '')
        qty = int(item.get('qty', 0))
        if not pid or qty <= 0:
            continue
        # Custom price?
        cp = db.execute(
            "SELECT price FROM customer_prices WHERE customer_id=? AND product_id=?",
            (cust['id'], pid)
        ).fetchone()
        prod = db.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
        if not prod:
            continue
        price = cp['price'] if cp else prod['price']
        line  = price * qty
        subtotal += line
        items_list.append({'product_id': pid, 'name': prod['name'], 'qty': qty,
                           'price': price, 'line_total': line})
        items_summary_parts.append(f"{prod['name']} x{qty}")

    if not items_list:
        db.close()
        return jsonify({'error': 'No valid items'}), 400

    vat   = round(subtotal * 7 / 107, 2)
    total = subtotal
    order_num = generate_order_num(db)

    with db:
        oid = new_id()
        db.execute(
            """INSERT INTO orders
               (id,order_num,date,cust_id,cust_name,cust_phone,
                address,lat,lng,items_json,items_summary,
                subtotal,fees_json,vat,total,payment_method,
                awaiting_payment,order_type,service_type,
                status,note,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)""",
            (oid, order_num, now[:10],
             cust['id'], cust['name'], phone,
             address, lat, lng,
             json.dumps(items_list, ensure_ascii=False),
             ', '.join(items_summary_parts),
             subtotal, '[]', vat, total, payment_name,
             total if payment_name == 'เงินสด' else 0,
             order_type, service_type,
             note, now, now)
        )
        # Deduct stock
        for item in items_list:
            db.execute(
                "UPDATE tank_stock SET full_qty = MAX(0, full_qty - ?) WHERE product_id=?",
                (item['qty'], item['product_id'])
            )
            verify_stock_invariant(db, item['product_id'])
        audit(db, cust['id'], cust['name'], 'customer', 'placed_order',
              'order', oid, {'order_num': order_num, 'total': total})

    db.close()
    notify_line(
        f"\n📱 สั่งใหม่ {order_num}\n"
        f"👤 {cust['name']} {phone}\n"
        f"💰 ฿{total:,} | {payment_name}"
    )
    return jsonify({'ok': True, 'order_num': order_num, 'total': total}), 201


# ─── Order Tracking ───────────────────────────────────────────────────────────

@customer_bp.route('/order/<order_num>')
def track_order(order_num):
    """Track order status — NO driver phone ever exposed."""
    db  = get_db()
    row = db.execute(
        """SELECT order_num, date, status, items_summary,
                  total, payment_method, awaiting_payment,
                  order_type, service_type,
                  driver_name,
                  started_at, delivered_at,
                  created_at, updated_at
           FROM orders WHERE order_num=?""",
        (order_num,)
    ).fetchone()
    db.close()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(dict(row))


@customer_bp.route('/orders/<phone>')
def order_history(phone):
    db   = get_db()
    rows = db.execute(
        """SELECT order_num, date, items_summary, total,
                  payment_method, status, delivered_at
           FROM orders WHERE cust_phone=?
           ORDER BY created_at DESC LIMIT 20""",
        (phone,)
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


# ─── Products ─────────────────────────────────────────────────────────────────

@customer_bp.route('/products')
def list_products():
    """Public product listing with customer-specific prices if customer_id supplied."""
    customer_id = request.args.get('customer_id', '')
    db = get_db()
    rows = db.execute(
        """SELECT p.id, p.brand, p.name, p.name_en, p.ico,
                  p.image_url, p.size_kg, p.price,
                  p.price_transfer, p.status,
                  COALESCE(ts.full_qty, 0) as full_qty
           FROM products p
           LEFT JOIN tank_stock ts ON ts.product_id = p.id
           WHERE p.status = 'available'
           ORDER BY p.sort_order, p.brand, p.size_kg"""
    ).fetchall()
    result = []
    for r in rows:
        p = dict(r)
        if customer_id:
            cp = db.execute(
                "SELECT price FROM customer_prices WHERE customer_id=? AND product_id=?",
                (customer_id, p['id'])
            ).fetchone()
            if cp:
                p['price'] = cp['price']
        result.append(p)
    db.close()
    return jsonify(result)


# ─── Fees ─────────────────────────────────────────────────────────────────────

@customer_bp.route('/fees')
def list_fees():
    db   = get_db()
    rows = db.execute(
        "SELECT id,name,type,amount,condition_type,condition_value FROM fees WHERE active=1 ORDER BY sort_order"
    ).fetchall()
    db.close()
    return jsonify({'fees': [dict(r) for r in rows]})


# ─── Payment Methods ──────────────────────────────────────────────────────────

@customer_bp.route('/payment-methods')
def list_payment_methods():
    tier = request.args.get('tier', 'retail')
    db   = get_db()
    rows = db.execute(
        """SELECT id,name,type,config_json FROM payment_methods
           WHERE active=1 AND (require_tier='' OR require_tier=?)
           ORDER BY sort_order""",
        (tier,)
    ).fetchall()
    db.close()
    return jsonify({'methods': [dict(r) for r in rows]})


# ─── Settings (public) ────────────────────────────────────────────────────────

@customer_bp.route('/settings')
def public_settings():
    db   = get_db()
    rows = db.execute(
        """SELECT key,val FROM settings
           WHERE key IN ('shop_name','shop_phone','shop_address',
                         'open_time','close_time','promptpay',
                         'promptpay_name','qr_image','warranty_days')"""
    ).fetchall()
    db.close()
    return jsonify({r['key']: r['val'] for r in rows})


# ─── Slip Verify (SlipOK) ─────────────────────────────────────────────────────

@customer_bp.route('/slip/verify', methods=['POST'])
def verify_slip():
    d      = request.get_json(silent=True) or {}
    amount = d.get('amount', 0)
    ref    = d.get('transaction_ref', '')
    db     = get_db()
    row    = db.execute("SELECT val FROM settings WHERE key='slipok_key'").fetchone()
    db.close()
    slipok_key = row['val'] if row else ''
    if not slipok_key:
        # No SlipOK configured — auto-approve
        return jsonify({'ok': True, 'verified': False, 'message': 'SlipOK not configured'})
    try:
        import requests as req
        r = req.post(
            'https://api.slipok.com/api/line/apikey/' + slipok_key,
            json={'data': ref, 'amount': amount},
            timeout=10
        )
        result = r.json()
        return jsonify({'ok': True, 'verified': result.get('success', False), 'data': result})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

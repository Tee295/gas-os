"""
routes/supervisor.py — Supervisor POS endpoints (session-cookie auth)
"""
import json
from flask import Blueprint, jsonify, request, g

from helpers import (
    get_db, bkk_now, new_id, calc_vat,
    generate_order_num, generate_doc_num, audit, notify_line,
    verify_stock_invariant, require_auth
)

supervisor_bp = Blueprint('supervisor', __name__)

ALLOWED_ROLES = ['supervisor', 'admin']


# ─── Dashboard ───────────────────────────────────────────────────────────────

@supervisor_bp.route('/dashboard')
@require_auth(ALLOWED_ROLES)
def dashboard():
    db    = get_db()
    today = bkk_now()[:10]
    stats = db.execute(
        """SELECT
             COUNT(*) as total_orders,
             SUM(CASE WHEN status='completed'  THEN 1 ELSE 0 END) as completed,
             SUM(CASE WHEN status='pending'    THEN 1 ELSE 0 END) as pending,
             SUM(CASE WHEN status='delivering' THEN 1 ELSE 0 END) as delivering,
             SUM(CASE WHEN status='completed'  THEN total ELSE 0 END) as revenue,
             SUM(CASE WHEN status='completed' AND cash_cleared=0
                       AND payment_method='เงินสด'
                       THEN cash_collected ELSE 0 END) as uncleared_cash
           FROM orders WHERE date=?""",
        (today,)
    ).fetchone()
    stock_alerts = db.execute(
        """SELECT p.name, p.brand, ts.full_qty, ts.reorder_point
           FROM tank_stock ts JOIN products p ON p.id=ts.product_id
           WHERE ts.full_qty <= ts.reorder_point AND p.status='available'"""
    ).fetchall()
    db.close()
    return jsonify({
        'today': today,
        'stats': dict(stats) if stats else {},
        'stock_alerts': [dict(r) for r in stock_alerts],
    })


# ─── Kanban ───────────────────────────────────────────────────────────────────

@supervisor_bp.route('/kanban')
@require_auth(ALLOWED_ROLES)
def kanban():
    db    = get_db()
    today = request.args.get('date') or bkk_now()[:10]
    rows  = db.execute(
        """SELECT * FROM orders
           WHERE date=? AND status NOT IN ('cancelled')
           ORDER BY created_at""",
        (today,)
    ).fetchall()

    # Also pull dashboard stats
    stats = db.execute(
        """SELECT
             COUNT(*) as total_orders,
             SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
             SUM(CASE WHEN status IN ('pending','preparing') THEN 1 ELSE 0 END) as pending,
             SUM(CASE WHEN status='delivering' THEN 1 ELSE 0 END) as delivering,
             COALESCE(SUM(CASE WHEN status='completed' AND cash_cleared=0
                                AND payment_method='เงินสด' THEN cash_collected ELSE 0 END),0) as uncleared_cash
           FROM orders WHERE date=?""",
        (today,)
    ).fetchone()
    db.close()

    result = {'pending': [], 'preparing': [], 'delivering': [], 'completed': [], 'stats': dict(stats) if stats else {}}
    for r in rows:
        o = dict(r)
        try:
            o['items_json'] = json.loads(o.get('items_json') or '[]')
        except Exception:
            o['items_json'] = []
        s = o.get('status', '')
        if s in result:
            result[s].append(o)
    return jsonify(result)


# ─── Create Order (POS) ───────────────────────────────────────────────────────

@supervisor_bp.route('/orders', methods=['POST'])
@require_auth(ALLOWED_ROLES)
def create_order():
    staff  = g.actor
    d      = request.get_json(silent=True) or {}
    phone  = d.get('phone', '').strip()
    items_in = d.get('items', [])
    if not items_in:
        return jsonify({'error': 'items required'}), 400

    db = get_db()
    # Resolve customer
    cust_id    = ''
    cust_name  = d.get('cust_name', 'ลูกค้าหน้าร้าน')
    cust_phone = phone
    cust_tier  = 'retail'
    cust_lang  = d.get('lang', 'th')
    if phone:
        cust = db.execute("SELECT * FROM customers WHERE phone=?", (phone,)).fetchone()
        if cust:
            cust_id    = cust['id']
            cust_name  = cust['name']
            cust_tier  = cust['tier']
            cust_lang  = cust['lang']

    # Resolve prices + build items
    items_out = []
    subtotal  = 0
    for item in items_in:
        pid  = item.get('product_id', '')
        qty  = int(item.get('qty', 1))
        prod = db.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
        if not prod:
            db.close()
            return jsonify({'error': f'product {pid} not found'}), 400
        cp = db.execute(
            "SELECT price FROM customer_prices WHERE customer_id=? AND product_id=?",
            (cust_id, pid)
        ).fetchone() if cust_id else None
        unit_price = cp['price'] if cp else prod['price']
        line_total = unit_price * qty
        base, vat  = calc_vat(line_total)
        items_out.append({
            'product_id': pid, 'name': prod['name'], 'brand': prod['brand'],
            'size_kg': prod['size_kg'], 'qty': qty, 'unit_price': unit_price,
            'line_total': line_total, 'base': base, 'vat': vat,
        })
        subtotal += line_total

    # Fees
    fees_applied = []
    fees_total   = 0
    order_type   = d.get('order_type', 'walkin')
    if order_type == 'delivery':
        for fee in db.execute(
            "SELECT * FROM fees WHERE active=1 ORDER BY sort_order"
        ).fetchall():
            if fee['condition_type'] == 'floor':
                try:
                    if subtotal >= float(fee['condition_value']):
                        continue
                except Exception:
                    pass
            amt = int(fee['amount'] if fee['type'] == 'fixed'
                      else round(subtotal * fee['amount'] / 100))
            fees_applied.append({'name': fee['name'], 'amount': amt})
            fees_total += amt

    total          = subtotal + fees_total
    items_summary  = ', '.join(f"{it['name']} x{it['qty']}" for it in items_out)
    now            = bkk_now()
    order_date     = now[:10]
    order_num      = generate_order_num(db)
    oid            = new_id()
    service_type   = d.get('service_type', 'exchange')
    payment_method = d.get('payment_method', 'เงินสด')
    is_credit      = payment_method == 'เครดิต'
    order_method   = d.get('order_method', 'pos')
    branch_id      = d.get('branch_id', 'MAIN')

    # Document numbers — only generated when explicitly requested
    want_dn  = bool(d.get('doc_delivery_note'))
    want_inv = bool(d.get('invoice'))
    dn_num   = generate_doc_num(db, 'dn')  if want_dn  else ''
    inv_num  = generate_doc_num(db, 'inv') if want_inv else ''

    with db:
        db.execute(
            """INSERT INTO orders
               (id,order_num,date,created_at,updated_at,
                cust_id,cust_name,cust_phone,cust_tier,cust_lang,
                address,lat,lng,order_type,service_type,
                items_json,items_summary,fees_json,
                subtotal,fees_total,total,payment_method,
                awaiting_payment,invoice,inv_name,inv_tax,inv_branch,
                driver_id,driver_name,source,note,status,
                order_method,branch_id,
                doc_delivery_note,doc_delivery_name,delivery_note_num,tax_invoice_num)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (oid, order_num, order_date, now, now,
             cust_id, cust_name, cust_phone, cust_tier, cust_lang,
             d.get('address', ''), d.get('lat'), d.get('lng'),
             order_type, service_type,
             json.dumps(items_out, ensure_ascii=False), items_summary,
             json.dumps(fees_applied, ensure_ascii=False),
             subtotal, fees_total, total, payment_method,
             1 if is_credit else 0,
             1 if want_inv else 0,
             d.get('inv_name', ''), d.get('inv_tax', ''), d.get('inv_branch', ''),
             d.get('driver_id', ''), d.get('driver_name', ''),
             'pos', d.get('note', ''), 'pending',
             order_method, branch_id,
             1 if want_dn else 0,
             d.get('doc_delivery_name', cust_name),
             dn_num, inv_num)
        )
        # Stock deduction
        for item in items_out:
            pid = item['product_id']
            qty = item['qty']
            if service_type == 'exchange':
                db.execute(
                    """UPDATE tank_stock SET
                       full_qty=MAX(0,full_qty-?), empty_qty=empty_qty+?,
                       last_updated=? WHERE product_id=?""",
                    (qty, qty, now, pid)
                )
            else:
                db.execute(
                    """UPDATE tank_stock SET
                       full_qty=MAX(0,full_qty-?), customer_qty=customer_qty+?,
                       last_updated=? WHERE product_id=?""",
                    (qty, qty, now, pid)
                )
            verify_stock_invariant(db, pid)

        # Credit ledger
        if is_credit and cust_id:
            cust_row = db.execute(
                "SELECT credit_bal FROM customers WHERE id=?", (cust_id,)
            ).fetchone()
            old_bal = cust_row['credit_bal'] if cust_row else 0
            new_bal = old_bal + total
            db.execute("UPDATE customers SET credit_bal=? WHERE id=?", (new_bal, cust_id))
            db.execute(
                """INSERT INTO customer_ledger
                   (id,customer_id,order_id,type,amount,balance_after,note,created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (new_id(), cust_id, oid, 'DEBT', total, new_bal,
                 f'ออเดอร์ {order_num}', now)
            )

        # VAT output
        base_t, vat_t = calc_vat(total)
        db.execute(
            """INSERT INTO vat_output
               (id,tax_month,date,invoice_num,customer_name,customer_tax_id,
                base_amount,vat_amount,total,is_cancelled,order_id)
               VALUES (?,?,?,?,?,?,?,?,?,0,?)""",
            (new_id(), order_date[:7], order_date, order_num,
             cust_name, d.get('inv_tax', ''), base_t, vat_t, total, oid)
        )
        if cust_id:
            db.execute(
                """UPDATE customers SET total_orders=total_orders+1,
                   total_spent=total_spent+?, last_order_items=? WHERE id=?""",
                (total, json.dumps(items_out[:5], ensure_ascii=False), cust_id)
            )
        audit(db, staff['id'], staff['name'], staff['role'],
              'order_created', 'order', oid,
              {'order_num': order_num, 'total': total, 'source': 'pos'})

    db.close()
    notify_line(
        f"\n🏪 [POS] ออเดอร์ {order_num}\n"
        f"👤 {cust_name}\n🛒 {items_summary}\n💰 ฿{total:,}"
    )
    return jsonify({
        'order_num': order_num, 'id': oid, 'total': total,
        'subtotal': subtotal, 'fees_total': fees_total,
        'items': items_out, 'fees': fees_applied,
        'delivery_note_num': dn_num, 'tax_invoice_num': inv_num,
    }), 201


@supervisor_bp.route('/orders/<order_num>/confirm', methods=['PUT'])
@require_auth(ALLOWED_ROLES)
def confirm_order(order_num):
    staff = g.actor
    db    = get_db()
    order = db.execute("SELECT * FROM orders WHERE order_num=?", (order_num,)).fetchone()
    if not order:
        db.close(); return jsonify({'error': 'Not found'}), 404
    if order['status'] != 'pending':
        db.close(); return jsonify({'error': 'Not pending'}), 400
    now = bkk_now()
    with db:
        db.execute("UPDATE orders SET status='preparing', updated_at=? WHERE order_num=?",
                   (now, order_num))
        audit(db, staff['id'], staff['name'], staff['role'],
              'order_confirmed', 'order', order['id'], {'order_num': order_num})
    db.close()
    return jsonify({'ok': True})


@supervisor_bp.route('/orders/<order_num>/dispatch', methods=['PUT'])
@require_auth(ALLOWED_ROLES)
def dispatch_order(order_num):
    staff = g.actor
    d     = request.get_json(silent=True) or {}
    db    = get_db()
    order = db.execute("SELECT * FROM orders WHERE order_num=?", (order_num,)).fetchone()
    if not order:
        db.close(); return jsonify({'error': 'Not found'}), 404
    driver_id = d.get('driver_id')
    if not driver_id:
        db.close(); return jsonify({'error': 'driver_id required'}), 400
    drv = db.execute("SELECT name FROM staff WHERE id=?", (driver_id,)).fetchone()
    now = bkk_now()
    with db:
        db.execute(
            """UPDATE orders SET driver_id=?, driver_name=?,
               status='delivering', started_at=?, updated_at=? WHERE order_num=?""",
            (driver_id, drv['name'] if drv else '', now, now, order_num)
        )
        audit(db, staff['id'], staff['name'], staff['role'],
              'order_dispatched', 'order', order['id'],
              {'driver_id': driver_id, 'order_num': order_num})
    db.close()
    return jsonify({'ok': True})


@supervisor_bp.route('/orders/<order_num>/cancel', methods=['PUT'])
@require_auth(ALLOWED_ROLES)
def cancel_order(order_num):
    staff  = g.actor
    d      = request.get_json(silent=True) or {}
    reason = d.get('reason', '')
    if not reason:
        return jsonify({'error': 'reason required'}), 400
    db    = get_db()
    order = db.execute("SELECT * FROM orders WHERE order_num=?", (order_num,)).fetchone()
    if not order:
        db.close(); return jsonify({'error': 'Not found'}), 404
    now   = bkk_now()
    items = json.loads(order['items_json'] or '[]')
    with db:
        for item in items:
            pid = item.get('product_id', '')
            qty = item.get('qty', 0)
            if pid and qty:
                if order['service_type'] == 'exchange':
                    db.execute(
                        """UPDATE tank_stock SET full_qty=full_qty+?,
                           empty_qty=MAX(0,empty_qty-?), last_updated=?
                           WHERE product_id=?""",
                        (qty, qty, now, pid)
                    )
                else:
                    db.execute(
                        """UPDATE tank_stock SET full_qty=full_qty+?,
                           customer_qty=MAX(0,customer_qty-?), last_updated=?
                           WHERE product_id=?""",
                        (qty, qty, now, pid)
                    )
                verify_stock_invariant(db, pid)
        if order['awaiting_payment'] and order['cust_id']:
            cust = db.execute(
                "SELECT credit_bal FROM customers WHERE id=?", (order['cust_id'],)
            ).fetchone()
            if cust:
                new_bal = max(0, cust['credit_bal'] - order['total'])
                db.execute("UPDATE customers SET credit_bal=? WHERE id=?",
                           (new_bal, order['cust_id']))
        db.execute("UPDATE vat_output SET is_cancelled=1 WHERE order_id=?", (order['id'],))
        db.execute(
            "UPDATE orders SET status='cancelled', cancel_reason=?, updated_at=? WHERE order_num=?",
            (reason, now, order_num)
        )
        audit(db, staff['id'], staff['name'], staff['role'],
              'order_cancelled', 'order', order['id'], {'reason': reason})
    db.close()
    return jsonify({'ok': True})


@supervisor_bp.route('/orders/<order_num>/complete', methods=['PUT'])
@require_auth(ALLOWED_ROLES)
def complete_order(order_num):
    staff = g.actor
    db    = get_db()
    order = db.execute("SELECT * FROM orders WHERE order_num=?", (order_num,)).fetchone()
    if not order:
        db.close(); return jsonify({'error': 'Not found'}), 404
    if order['status'] not in ('delivering', 'preparing'):
        db.close(); return jsonify({'error': 'ไม่สามารถจบงานได้ (status: ' + order['status'] + ')'}), 400
    now = bkk_now()
    cash = order['total'] if order['payment_method'] == 'เงินสด' else 0
    with db:
        db.execute(
            """UPDATE orders SET status='completed', delivered_at=?, updated_at=?,
               cash_collected=COALESCE(NULLIF(cash_collected,0),?) WHERE order_num=?""",
            (now, now, cash, order_num)
        )
        if cash > 0:
            try:
                from server import app_settings
                db.execute(
                    "INSERT INTO vat_output (id,order_id,order_num,date,total_incl,base_amount,vat_amount,created_at) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (new_id(), order['id'], order_num, order['date'],
                     order['total'],
                     round(order['total'] * 100/107, 2),
                     round(order['total'] * 7/107, 2), now)
                )
            except Exception:
                pass
        audit(db, staff['id'], staff['name'], staff['role'],
              'order_completed', 'order', order['id'],
              {'order_num': order_num, 'completed_by': 'supervisor'})
    db.close()
    return jsonify({'ok': True})


@supervisor_bp.route('/orders/<order_num>/payment', methods=['PUT'])
@require_auth(ALLOWED_ROLES)
def record_payment(order_num):
    staff = g.actor
    d     = request.get_json(silent=True) or {}
    db    = get_db()
    order = db.execute("SELECT * FROM orders WHERE order_num=?", (order_num,)).fetchone()
    if not order:
        db.close(); return jsonify({'error': 'Not found'}), 404
    now = bkk_now()
    with db:
        db.execute(
            """UPDATE orders SET payment_method=COALESCE(?,payment_method),
               payment_proof=COALESCE(?,payment_proof),
               awaiting_payment=0, updated_at=? WHERE order_num=?""",
            (d.get('payment_method'), d.get('proof_url'), now, order_num)
        )
        audit(db, staff['id'], staff['name'], staff['role'],
              'payment_recorded', 'order', order['id'],
              {'method': d.get('payment_method'), 'total': order['total']})
    db.close()
    return jsonify({'ok': True})


# ─── Drivers ─────────────────────────────────────────────────────────────────

@supervisor_bp.route('/drivers')
@require_auth(ALLOWED_ROLES)
def get_drivers():
    db    = get_db()
    today = bkk_now()[:10]
    drivers = db.execute(
        "SELECT id,name,vehicle,phone FROM staff WHERE role='driver' AND active=1"
    ).fetchall()
    result = []
    for drv in drivers:
        load = db.execute(
            """SELECT COUNT(*) as cnt FROM orders
               WHERE driver_id=? AND date=? AND status NOT IN ('completed','cancelled')""",
            (drv['id'], today)
        ).fetchone()
        d2 = dict(drv)
        d2['active_orders'] = load['cnt'] if load else 0
        result.append(d2)
    db.close()
    return jsonify(result)


# ─── Stock ────────────────────────────────────────────────────────────────────

@supervisor_bp.route('/stock')
@require_auth(ALLOWED_ROLES)
def get_stock():
    db   = get_db()
    rows = db.execute(
        """SELECT ts.*, p.name, p.brand, p.size_kg, p.ico, p.reorder_point as prod_reorder
           FROM tank_stock ts
           JOIN products p ON p.id = ts.product_id
           ORDER BY p.sort_order, p.brand, p.size_kg"""
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@supervisor_bp.route('/stock/adjust', methods=['POST'])
@require_auth(ALLOWED_ROLES)
def adjust_stock():
    staff      = g.actor
    d          = request.get_json(silent=True) or {}
    product_id = d.get('product_id')
    if not product_id:
        return jsonify({'error': 'product_id required'}), 400
    db  = get_db()
    old = db.execute("SELECT * FROM tank_stock WHERE product_id=?", (product_id,)).fetchone()
    if not old:
        db.close(); return jsonify({'error': 'Not found'}), 404
    now = bkk_now()
    with db:
        db.execute(
            """UPDATE tank_stock SET
               full_qty=COALESCE(?,full_qty), empty_qty=COALESCE(?,empty_qty),
               customer_qty=COALESCE(?,customer_qty), last_updated=?
               WHERE product_id=?""",
            (d.get('full_qty'), d.get('empty_qty'), d.get('customer_qty'),
             now, product_id)
        )
        verify_stock_invariant(db, product_id)
        audit(db, staff['id'], staff['name'], staff['role'],
              'stock_adjusted', 'tank', product_id,
              {'reason': d.get('reason', ''), 'old': dict(old), 'new': d})
    db.close()
    return jsonify({'ok': True})


# ─── Restock (with tare discount + staff bonus) ───────────────────────────────

@supervisor_bp.route('/restock', methods=['POST'])
@require_auth(ALLOWED_ROLES)
def create_restock():
    staff = g.actor
    d     = request.get_json(silent=True) or {}
    items = d.get('items', [])
    if not items:
        return jsonify({'error': 'items required'}), 400

    now      = bkk_now()
    today    = now[:10]
    hour     = int(now[11:13])
    shift    = 'M' if hour < 12 else ('A' if hour < 18 else 'E')
    batch_id = f"LOT-{today[2:4]}{today[5:7]}{today[8:10]}-{shift}"
    inv_id   = new_id()

    subtotal    = sum(
        int(it.get('qty', 0)) * float(it.get('cost_per_unit', 0))
        for it in items
    )
    vat_amount   = float(d.get('vat_amount', 0) or 0)
    gross_total  = subtotal + vat_amount
    tare_weight_kg   = float(d.get('tare_weight_kg', 0) or 0)
    supplier_id      = d.get('supplier_id', '')
    invoice_num      = d.get('invoice_num', '')
    doc_type         = d.get('doc_type', 'tax')
    pickup_staff_id  = d.get('pickup_staff_id', '')
    pickup_staff_name = d.get('pickup_staff_name', '')

    db = get_db()

    # Tare rate from tare_bonus_rules or settings
    tare_rule = db.execute(
        "SELECT rate_per_kg FROM tare_bonus_rules WHERE active=1 LIMIT 1"
    ).fetchone()
    tare_rate    = tare_rule['rate_per_kg'] if tare_rule else 5.0
    tare_discount = round(tare_weight_kg * tare_rate, 2)
    net_total     = gross_total - tare_discount

    with db:
        db.execute(
            """INSERT INTO restock_invoices
               (id,batch_id,date,supplier_id,invoice_num,doc_type,
                gross_total,vat_amount,tare_weight_kg,tare_rate,tare_discount,net_total,
                pickup_staff_id,pickup_staff_name,
                status,note,created_by,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (inv_id, batch_id, today, supplier_id, invoice_num, doc_type,
             gross_total, vat_amount, tare_weight_kg, tare_rate, tare_discount, net_total,
             pickup_staff_id, pickup_staff_name,
             'unpaid', d.get('note', ''), staff['name'], now)
        )
        for item in items:
            pid = item.get('product_id')
            qty = int(item.get('qty', 0))
            cpu = float(item.get('cost_per_unit', 0))
            db.execute(
                """INSERT INTO restock_items
                   (id,invoice_id,product_id,qty,cost_per_unit,subtotal)
                   VALUES (?,?,?,?,?,?)""",
                (new_id(), inv_id, pid, qty, cpu, qty * cpu)
            )
            db.execute(
                """UPDATE tank_stock SET
                   empty_qty=MAX(0,empty_qty-?), full_qty=full_qty+?,
                   last_updated=? WHERE product_id=?""",
                (qty, qty, now, pid)
            )
            verify_stock_invariant(db, pid)
            if cpu > 0:
                db.execute("UPDATE products SET cost=? WHERE id=?", (int(cpu), pid))

        # Staff bonus log (tare weight → extra pay)
        if tare_weight_kg > 0 and pickup_staff_id:
            db.execute(
                """INSERT INTO staff_bonus_log
                   (id,staff_id,staff_name,type,ref_id,
                    tare_weight_kg,rate_per_kg,amount,note,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (new_id(), pickup_staff_id, pickup_staff_name,
                 'tare', inv_id,
                 tare_weight_kg, tare_rate, tare_discount,
                 f'Restock {batch_id}', now)
            )

        # Supplier balance
        if supplier_id:
            db.execute("UPDATE suppliers SET balance=balance+? WHERE id=?",
                       (net_total, supplier_id))

        # VAT input
        if doc_type == 'tax' and supplier_id:
            sup = db.execute(
                "SELECT name,tax_id FROM suppliers WHERE id=?", (supplier_id,)
            ).fetchone()
            base, vat = calc_vat(net_total)
            db.execute(
                """INSERT INTO vat_input
                   (id,tax_month,date,invoice_num,supplier_name,supplier_tax_id,
                    base_amount,vat_amount,total,doc_type,restock_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (new_id(), today[:7], today, invoice_num,
                 sup['name'] if sup else '', sup['tax_id'] if sup else '',
                 base, vat, net_total, doc_type, inv_id)
            )
        audit(db, staff['id'], staff['name'], staff['role'],
              'batch_created', 'restock', inv_id,
              {'batch_id': batch_id, 'gross_total': gross_total,
               'tare_discount': tare_discount, 'net_total': net_total})

    db.close()
    notify_line(
        f"\n📦 รับสต็อก {batch_id}\n"
        f"💰 รวม ฿{int(gross_total):,} หักส่วนลดถัง ฿{tare_discount:,.0f}\n"
        f"   สุทธิ ฿{net_total:,.0f}",
        token=None
    )
    return jsonify({
        'ok': True, 'batch_id': batch_id, 'invoice_id': inv_id,
        'gross_total': gross_total, 'tare_discount': tare_discount,
        'net_total': net_total,
    })


# ─── Cash Management ─────────────────────────────────────────────────────────

@supervisor_bp.route('/cash/clear', methods=['POST'])
@require_auth(ALLOWED_ROLES)
def clear_cash():
    staff     = g.actor
    d         = request.get_json(silent=True) or {}
    driver_id = d.get('driver_id')
    if not driver_id:
        return jsonify({'error': 'driver_id required'}), 400
    now   = bkk_now()
    today = now[:10]
    db    = get_db()
    orders = db.execute(
        """SELECT * FROM orders WHERE driver_id=? AND date=?
           AND status='completed' AND cash_cleared=0 AND payment_method='เงินสด'""",
        (driver_id, today)
    ).fetchall()
    total = sum(o['cash_collected'] for o in orders)
    ids   = [o['order_num'] for o in orders]
    with db:
        db.execute(
            """UPDATE orders SET cash_cleared=1, cleared_by=?, cleared_at=?
               WHERE driver_id=? AND date=? AND status='completed' AND cash_cleared=0""",
            (staff['name'], now, driver_id, today)
        )
        audit(db, staff['id'], staff['name'], staff['role'],
              'cash_cleared', 'driver', driver_id,
              {'orders': ids, 'total': total})
    db.close()
    return jsonify({'ok': True, 'cleared_orders': len(ids), 'total': total})


@supervisor_bp.route('/cash/orders')
@require_auth(ALLOWED_ROLES)
def cash_orders():
    driver_id = request.args.get('driver_id', '')
    date      = request.args.get('date', bkk_now()[:10])
    if not driver_id:
        return jsonify([])
    db   = get_db()
    rows = db.execute(
        """SELECT order_num, cust_name, items_summary, cash_collected, delivered_at
           FROM orders WHERE driver_id=? AND date=?
           AND status='completed' AND cash_cleared=0 AND payment_method='เงินสด'
           ORDER BY delivered_at""",
        (driver_id, date)
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@supervisor_bp.route('/cash/summary')
@require_auth(ALLOWED_ROLES)
def cash_summary():
    db    = get_db()
    today = bkk_now()[:10]
    rows  = db.execute(
        """SELECT s.id, s.name,
             SUM(CASE WHEN o.status='completed' AND o.payment_method='เงินสด'
                       THEN o.cash_collected ELSE 0 END) as collected,
             SUM(CASE WHEN o.status='completed' AND o.payment_method='เงินสด'
                       AND o.cash_cleared=0
                       THEN o.cash_collected ELSE 0 END) as uncleared
           FROM staff s
           LEFT JOIN orders o ON o.driver_id=s.id AND o.date=?
           WHERE s.role='driver' AND s.active=1
           GROUP BY s.id""",
        (today,)
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


# ─── Customer Search ──────────────────────────────────────────────────────────

@supervisor_bp.route('/customers/search')
@require_auth(ALLOWED_ROLES)
def search_customers():
    q  = request.args.get('q', '')
    db = get_db()
    if len(q) < 2:
        rows = db.execute(
            """SELECT id,name,phone,address,lat,lng,tier,credit_bal,credit_limit,last_order_items
               FROM customers ORDER BY name LIMIT 200"""
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT id,name,phone,address,lat,lng,tier,credit_bal,credit_limit,last_order_items
               FROM customers WHERE name LIKE ? OR phone LIKE ?
               ORDER BY name LIMIT 30""",
            (f'%{q}%', f'%{q}%')
        ).fetchall()
    db.close()
    result = []
    for r in rows:
        c = dict(r)
        try:
            c['last_order_items'] = json.loads(c.get('last_order_items') or '[]')
        except Exception:
            c['last_order_items'] = []
        result.append(c)
    return jsonify(result)


# ─── Today Summary ────────────────────────────────────────────────────────────

@supervisor_bp.route('/summary/today')
@require_auth(ALLOWED_ROLES)
def today_summary():
    db    = get_db()
    today = bkk_now()[:10]
    stats = db.execute(
        """SELECT COUNT(*) as orders, SUM(total) as revenue,
             SUM(CASE WHEN payment_method='เงินสด'   AND status='completed' THEN cash_collected ELSE 0 END) as cash_in,
             SUM(CASE WHEN payment_method='เงินสด'   AND status='completed' THEN 1 ELSE 0 END) as cash_count,
             SUM(CASE WHEN payment_method='โอน+สลิป' AND status='completed' THEN total ELSE 0 END) as transfer_in,
             SUM(CASE WHEN payment_method='โอน+สลิป' AND status='completed' THEN 1 ELSE 0 END) as transfer_count,
             SUM(CASE WHEN payment_method='เครดิต'   AND status='completed' THEN total ELSE 0 END) as credit_in,
             SUM(CASE WHEN payment_method='เครดิต'   AND status='completed' THEN 1 ELSE 0 END) as credit_count,
             SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled_count
           FROM orders WHERE date=?""",
        (today,)
    ).fetchone()
    expenses_rows = db.execute(
        "SELECT id, type, amount, note FROM expenses WHERE date=? ORDER BY created_at",
        (today,)
    ).fetchall()
    db.close()
    return jsonify({
        'date': today,
        'stats': dict(stats) if stats else {},
        'expenses': [dict(r) for r in expenses_rows],
    })


# ─── Expenses ────────────────────────────────────────────────────────────────

@supervisor_bp.route('/expenses', methods=['POST'])
@require_auth(ALLOWED_ROLES)
def add_expense():
    staff = g.actor
    d     = request.get_json(force=True)
    name  = (d.get('note') or d.get('name') or '').strip()
    amt   = float(d.get('amount', 0))
    if not name or amt <= 0:
        return jsonify({'error': 'ข้อมูลไม่ครบ'}), 400
    db    = get_db()
    today = bkk_now()[:10]
    eid   = new_id()
    with db:
        db.execute(
            "INSERT INTO expenses (id,date,created_at,type,note,amount,created_by) VALUES (?,?,?,?,?,?,?)",
            (eid, today, bkk_now(), d.get('type','operating'), name, int(amt), staff.get('id',''))
        )
    db.close()
    return jsonify({'ok': True, 'id': eid})


# ─── Suppliers list (for restock modal) ──────────────────────────────────────

@supervisor_bp.route('/suppliers')
@require_auth(ALLOWED_ROLES)
def list_suppliers():
    db   = get_db()
    rows = db.execute(
        "SELECT id, name, brand FROM suppliers WHERE active=1 ORDER BY name"
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


# ─── Day-end Close + Report ──────────────────────────────────────────────────

def _build_dayend_summary(db, today):
    stats = db.execute(
        """SELECT COUNT(*) as orders, COALESCE(SUM(total),0) as revenue,
             SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled
           FROM orders WHERE date=?""", (today,)
    ).fetchone()
    uncleared = db.execute(
        """SELECT COUNT(*) as cnt, COALESCE(SUM(cash_collected),0) as total
           FROM orders WHERE date=? AND status='completed'
           AND cash_cleared=0 AND payment_method='เงินสด'""", (today,)
    ).fetchone()
    exp_total = db.execute(
        "SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE date=?", (today,)
    ).fetchone()
    return dict(stats), dict(uncleared), dict(exp_total)


@supervisor_bp.route('/dayend/report', methods=['POST'])
@require_auth(ALLOWED_ROLES)
def dayend_report():
    staff = g.actor
    db    = get_db()
    today = bkk_now()[:10]
    s, uc, exp = _build_dayend_summary(db, today)
    db.close()
    msg = (
        f"\n📊 รายงานกะวันนี้ {today}\n"
        f"👤 ส่งโดย {staff['name']}\n"
        f"📦 ออเดอร์สำเร็จ {s['orders']} รายการ\n"
        f"💰 รายรับ ฿{int(s['revenue']):,}\n"
        f"💸 ค่าใช้จ่าย ฿{int(exp['total']):,}\n"
    )
    if uc['cnt']:
        msg += f"⚠️ เงินค้าง {uc['cnt']} รายการ ฿{int(uc['total']):,}\n"
    if s['cancelled']:
        msg += f"❌ ยกเลิก {s['cancelled']} ออเดอร์\n"
    notify_line(msg)
    return jsonify({'ok': True})


@supervisor_bp.route('/dayend', methods=['POST'])
@require_auth(ALLOWED_ROLES)
def dayend_close():
    staff = g.actor
    db    = get_db()
    today = bkk_now()[:10]
    s, uc, exp = _build_dayend_summary(db, today)
    audit(db, staff['id'], staff['name'], staff['role'],
          'dayend_close', 'shift', today,
          {'orders': s['orders'], 'revenue': s['revenue'],
           'uncleared_cash': uc['total'], 'expenses': exp['total']})
    db.close()
    msg = (
        f"\n🔒 ปิดกะ {today}\n"
        f"👤 ปิดโดย {staff['name']}\n"
        f"📦 ออเดอร์ {s['orders']} รายการ รายรับ ฿{int(s['revenue']):,}\n"
        f"💸 ค่าใช้จ่าย ฿{int(exp['total']):,}\n"
    )
    if uc['cnt']:
        msg += f"⚠️ เงินค้างส่ง {uc['cnt']} รายการ ฿{int(uc['total']):,}\n"
    notify_line(msg)
    return jsonify({'ok': True, 'date': today})


# ─── Tare Rate (for POS UI) ───────────────────────────────────────────────────

@supervisor_bp.route('/tare-rate')
@require_auth(ALLOWED_ROLES)
def get_tare_rate():
    db  = get_db()
    row = db.execute(
        "SELECT rate_per_kg FROM tare_bonus_rules WHERE active=1 LIMIT 1"
    ).fetchone()
    db.close()
    return jsonify({'rate_per_kg': row['rate_per_kg'] if row else 5.0})
